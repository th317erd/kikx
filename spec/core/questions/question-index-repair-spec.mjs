'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { QuestionsStore, repairQuestionIndex, listDocPaths } from '../../../src/core/questions/index.mjs';

const OPEN_INDEX = '/kikx/questions/index/open.json';

// A db double that exposes `list`, like the production driver surface.
function createListClient() {
  return {
    files: new Map(),
    writes: 0,
    async getFile(path) {
      if (!this.files.has(path))
        throw Object.assign(new Error(`missing ${path}`), { status: 404 });

      return JSON.parse(JSON.stringify(this.files.get(path)));
    },
    async putFile(path, body) {
      this.writes++;
      this.files.set(path, JSON.parse(JSON.stringify(body)));
      return { path };
    },
    async list(path, options = {}) {
      return scanFiles(this.files, path, {
        glob: options.glob,
        recursive: options.recursive === true,
      });
    },
  };
}

// A db double with no `list` at all, only `listDirectory` — the thin-client and
// test-stub surface. The repair path must work here too.
function createListDirectoryClient() {
  let files = new Map();
  let state = { writes: 0 };

  return {
    files,
    get writes() {
      return state.writes;
    },
    async getFile(path) {
      if (!files.has(path))
        throw Object.assign(new Error(`missing ${path}`), { status: 404 });

      return JSON.parse(JSON.stringify(files.get(path)));
    },
    async putFile(path, body) {
      state.writes++;
      files.set(path, JSON.parse(JSON.stringify(body)));
      return { path };
    },
    async listDirectory(path, options = {}) {
      let recursive = Number(options.depth) < 0;
      return scanFiles(files, path, { glob: options.glob, recursive });
    },
  };
}

function createStore(db, ids) {
  let queue = [ ...ids ];
  return new QuestionsStore({
    db,
    clock: () => 1000,
    idGenerator: () => queue.shift() || `generated_${queue.length}`,
  });
}

async function seedOpenQuestions(db, store) {
  return await store.createQuestions({
    questions: [
      { text: 'Which database should this use?' },
      { text: 'Should the sidebar show answered questions?' },
    ],
    mode: 'wait',
    sessionID: 'session_1',
    agentID: 'agent_1',
  });
}

test('repairQuestionIndex restores an open index entry that was lost', async () => {
  let db = createListClient();
  let store = createStore(db, [ 'group_1', 'q_1', 'q_2' ]);

  let created = await seedOpenQuestions(db, store);

  // Lose one id from the open index entirely — the failure mode that made a
  // question permanently invisible, since listOpen() reads the index only.
  let index = db.files.get(OPEN_INDEX);
  index.ids = [ created.questionIDs[0] ];
  index.summaries = index.summaries.filter((summary) => summary.id === created.questionIDs[0]);
  db.files.set(OPEN_INDEX, index);

  let before = await store.listOpen();
  assert.deepEqual(before.ids, [ created.questionIDs[0] ], 'precondition: one question is invisible');

  let result = await repairQuestionIndex(store);

  assert.equal(result.repaired, 1, 'one index id was restored');
  assert.equal(result.scanned, 2);
  assert.deepEqual(result.openIDs, [ created.questionIDs[0], created.questionIDs[1] ].sort());

  let after = await store.listOpen();
  assert.deepEqual(
    after.ids.sort(),
    [ created.questionIDs[0], created.questionIDs[1] ].sort(),
    'the repaired index lists both questions again',
  );
});

test('repairQuestionIndex restores a lost per-agent mirror', async () => {
  let db = createListClient();
  let store = createStore(db, [ 'group_1', 'q_1' ]);

  await seedOpenQuestions(db, store);

  let mirrorPath = '/kikx/agents/agent_1/questions.json';
  db.files.delete(mirrorPath);

  let result = await repairQuestionIndex(store);

  assert.equal(result.repaired, 0, 'the open index was already correct');
  let mirror = db.files.get(mirrorPath);
  assert.ok(mirror, 'the mirror was rebuilt');
  assert.equal(mirror.ids.length, 2);
});

test('repairQuestionIndex leaves a healthy index untouched (no boot-time churn)', async () => {
  let db = createListClient();
  let store = createStore(db, [ 'group_1', 'q_1' ]);

  await seedOpenQuestions(db, store);

  let indexBefore = JSON.stringify(db.files.get(OPEN_INDEX));
  let writesBefore = db.writes;

  let result = await repairQuestionIndex(store);

  assert.equal(result.unchanged, true);
  assert.equal(result.repaired, 0);
  assert.equal(db.writes, writesBefore, 'a healthy index must not be rewritten on boot');
  assert.equal(JSON.stringify(db.files.get(OPEN_INDEX)), indexBefore);
});

test('repairQuestionIndex refuses to wipe a non-empty index when the scan sees nothing', async () => {
  let db = createListClient();
  let store = createStore(db, [ 'group_1', 'q_1' ]);

  await seedOpenQuestions(db, store);
  let indexBefore = JSON.stringify(db.files.get(OPEN_INDEX));

  // Simulate a stub or misconfigured driver: a scan that silently returns no
  // docs. Treating that as truth would destroy the very data repair exists for.
  db.list = async () => ({ items: [], total: 0, hasMore: false });

  let result = await repairQuestionIndex(store);

  assert.equal(result.skippedReason, 'scan-returned-nothing');
  assert.equal(result.repaired, 0);
  assert.equal(JSON.stringify(db.files.get(OPEN_INDEX)), indexBefore, 'the index survived');
});

test('repairQuestionIndex works through listDirectory when the db has no list', async () => {
  let db = createListDirectoryClient();
  let store = createStore(db, [ 'group_1', 'q_1', 'q_2' ]);

  let created = await seedOpenQuestions(db, store);

  let index = db.files.get(OPEN_INDEX);
  index.ids = [];
  index.summaries = [];
  db.files.set(OPEN_INDEX, index);

  let result = await repairQuestionIndex(store);

  assert.equal(result.repaired, 2, 'both ids restored via the listDirectory surface');
  assert.deepEqual((await store.listOpen()).ids.sort(), created.questionIDs.sort());
});

test('repairQuestionIndex tolerates corrupt question docs without failing the boot', async () => {
  let db = createListClient();
  let store = createStore(db, [ 'group_1', 'q_1' ]);

  await seedOpenQuestions(db, store);

  db.files.set('/kikx/questions/q_broken.json', { not: 'a question' });
  db.files.set('/kikx/questions/q_null.json', null);

  let result = await repairQuestionIndex(store);

  assert.equal(result.skipped, 2, 'both malformed docs were skipped, not thrown on');
  assert.equal((await store.listOpen()).ids.length, 2, 'well-formed questions are still indexed');
});

test('listDocPaths prefers list and falls back to listDirectory', async () => {
  let calls = [];
  let listDB = {
    async list(path) {
      calls.push([ 'list', path ]);
      return { items: [ { path: `${path}/a.json` } ] };
    },
    async listDirectory() {
      calls.push([ 'listDirectory' ]);
      return { items: [] };
    },
  };

  let items = await listDocPaths(listDB, '/kikx/questions');
  assert.deepEqual(items, [ { path: '/kikx/questions/a.json' } ]);
  assert.deepEqual(calls, [ [ 'list', '/kikx/questions' ] ], 'list wins when both exist');

  let dirDB = {
    async listDirectory(path, options) {
      calls.push([ 'listDirectory', path, options.depth ]);
      return { items: [ { path: `${path}/a.json` } ] };
    },
  };

  await listDocPaths(dirDB, '/kikx/questions', { recursive: true });
  assert.deepEqual(calls.at(-1), [ 'listDirectory', '/kikx/questions', -1 ], 'recursive maps to depth -1 on the file surface');
});

test('listDocPaths throws a clear error when the db offers neither surface', async () => {
  await assert.rejects(
    () => listDocPaths({}, '/kikx/questions'),
    /requires db\.list or db\.listDirectory/,
  );
});

function scanFiles(files, path, { glob = null, recursive = false }) {
  let prefix = path.endsWith('/') ? path : `${path}/`;
  let pattern = glob ? new RegExp(`^${escapeGlob(glob)}$`) : null;
  let items = [];

  for (let key of files.keys()) {
    if (!key.startsWith(prefix))
      continue;

    let rest = key.slice(prefix.length);
    if (!recursive && rest.includes('/'))
      continue;

    let leaf = rest.split('/').pop();
    if (pattern && !pattern.test(leaf))
      continue;

    items.push({ path: key });
  }

  return { items, total: items.length, hasMore: false };
}

function escapeGlob(glob) {
  return glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*');
}
