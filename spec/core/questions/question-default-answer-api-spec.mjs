'use strict';

// The open index is a *projection* of the question docs, and `GET
// /api/v1/questions` serves that projection and nothing else — the Inbox never
// fetches per-question docs. So any field a client needs must be carried by
// `summarizeQuestion`, and any field added there must also be able to reach
// rows written by older code, or it appears only on new questions forever.
//
// `defaultAnswer` / `defaultDueAt` fell in that gap: the doc carried them, the
// index summary did not, so the API could not tell a user that a question would
// answer itself. These tests pin both halves — the projection and the rebuild.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  QuestionsStore,
  normalizeQuestionDoc,
  summarizeQuestion,
  repairQuestionIndex,
} from '../../../src/core/questions/index.mjs';

const OPEN_INDEX = '/kikx/questions/index/open.json';

function createClient() {
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
      let prefix = path.endsWith('/') ? path : `${path}/`;
      let recursive = options.recursive === true;
      let items = [];

      for (let key of this.files.keys()) {
        if (!key.startsWith(prefix))
          continue;

        let rest = key.slice(prefix.length);
        if (!recursive && rest.includes('/'))
          continue;

        if (options.glob && !rest.endsWith(options.glob.replace(/^\*/, '')))
          continue;

        items.push({ path: key });
      }

      return { items, total: items.length, hasMore: false };
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

async function seed(db, store, questions) {
  return await store.createQuestions({
    questions,
    mode: 'wait',
    sessionID: 'session_1',
    agentID: 'agent_1',
  });
}

test('the open index summary carries the default answer and its deadline', async () => {
  let db = createClient();
  let store = createStore(db, [ 'group_1', 'q_1' ]);
  let now = 1000;

  await store.createQuestions({
    questions: [ { text: 'Which database?', defaultAnswer: 'PostgreSQL', timeoutSeconds: 60 } ],
    mode: 'wait',
    sessionID: 'session_1',
    agentID: 'agent_1',
  });

  let summary = db.files.get(OPEN_INDEX).summaries[0];

  assert.equal(summary.defaultAnswer, 'PostgreSQL');
  assert.equal(summary.defaultTimeoutMs, 60_000);
  assert.equal(
    summary.defaultDueAt,
    now + 60_000,
    'the deadline is absolute, so it survives a restart',
  );
});

test('a question asked without a default reports null, not a missing key', async () => {
  let db = createClient();
  let store = createStore(db, [ 'group_1', 'q_1' ]);

  await seed(db, store, [ { text: 'No default here' } ]);

  let summary = db.files.get(OPEN_INDEX).summaries[0];

  // `listOpen()` reads the index only, so "absent" and "null" are behaviourally
  // different: a client checking `'defaultDueAt' in summary` must get a stable
  // answer whether or not a default was supplied.
  for (let key of [ 'defaultAnswer', 'defaultTimeoutMs', 'defaultDueAt' ]) {
    assert.ok(key in summary, `${key} must be present on every summary`);
    assert.equal(summary[key], null, `${key} must be null when unset`);
  }
});

test('summarizeQuestion never emits a deadline without a default to apply', async () => {
  // A deadline with no fallback would advertise a self-answer that can never
  // happen. The store only sets `defaultDueAt` alongside a default; the
  // projection must not invent one for docs written by other code paths.
  let doc = normalizeQuestionDoc({
    id: 'q_1',
    status: 'open',
    text: 'deadline without a default',
    askedAt: 500,
    defaultAnswer: null,
    defaultTimeoutMs: 60_000,
    defaultDueAt: null,
  });

  let summary = summarizeQuestion(doc);
  assert.equal(summary.defaultDueAt, null);
  assert.equal(summary.defaultAnswer, null);
});

test('repairQuestionIndex rewrites index rows left stale by an older projection', async () => {
  let db = createClient();
  let store = createStore(db, [ 'group_1', 'q_1', 'q_2' ]);

  await seed(db, store, [
    { text: 'Which database?', defaultAnswer: 'PostgreSQL', timeoutSeconds: 60 },
    { text: 'Which port?' },
  ]);

  // Simulate an index written before the projection carried defaults: the ids
  // are correct, so an id-only comparison sees nothing to do. Only a projection
  // comparison can tell that these rows are incomplete.
  let index = db.files.get(OPEN_INDEX);
  for (let summary of index.summaries) {
    delete summary.defaultAnswer;
    delete summary.defaultTimeoutMs;
    delete summary.defaultDueAt;
  }
  db.files.set(OPEN_INDEX, index);

  let result = await repairQuestionIndex(store);

  assert.equal(result.unchanged, undefined, 'stale summaries must trigger a rebuild');
  assert.ok(result.scanned >= 2);

  let repaired = db.files.get(OPEN_INDEX).summaries;
  let first = repaired.find((summary) => summary.defaultAnswer === 'PostgreSQL');
  assert.ok(first, 'the restored row carries the default again');
  assert.equal(first.defaultDueAt, 61_000);

  let second = repaired.find((summary) => summary.id !== first.id);
  assert.ok('defaultDueAt' in second, 'rows without a default gain the null field too');
});

test('repairQuestionIndex ignores an id-compatible index that is already complete', async () => {
  let db = createClient();
  let store = createStore(db, [ 'group_1', 'q_1' ]);

  await seed(db, store, [ { text: 'Which database?', defaultAnswer: 'SQLite', timeoutSeconds: 5 } ]);

  // An index row may carry keys the current projection does not produce. That is
  // not staleness — treating it as such would rewrite the index on every boot,
  // which is the churn the `unchanged` path exists to prevent.
  let index = db.files.get(OPEN_INDEX);
  index.summaries[0].futureField = 'written by some later build';
  db.files.set(OPEN_INDEX, index);

  let writesBefore = db.writes;
  let result = await repairQuestionIndex(store);

  assert.equal(result.unchanged, true);
  assert.equal(db.writes, writesBefore, 'a complete index must not be rewritten');
});

function reverseKeys(value) {
  if (Array.isArray(value))
    return value.map(reverseKeys);

  if (value && typeof value === 'object') {
    let out = {};
    for (let key of Object.keys(value).reverse())
      out[key] = reverseKeys(value[key]);
    return out;
  }

  return value;
}

test('repairQuestionIndex compares projections by value, not by key order', async () => {
  let db = createClient();
  let store = createStore(db, [ 'group_1', 'q_1' ]);

  await seed(db, store, [
    {
      text: 'Which database?',
      defaultAnswer: 'PostgreSQL',
      timeoutSeconds: 60,
      contextRefs: [ { type: 'file', id: 'src/a.mjs', label: 'a' } ],
    },
  ]);

  await repairQuestionIndex(store);

  // Key order is not part of a JSON object's identity, and a storage layer may
  // normalize it: Postgres jsonb sorts keys recursively on write. If the repair
  // compared serialized forms it would see a difference that does not exist and
  // rewrite the index on every boot -- not merely wasteful, since a rewrite bumps
  // `updatedAt` and redraws every mirror, on every single start.
  let index = db.files.get(OPEN_INDEX);
  index.summaries = reverseKeys(index.summaries);
  db.files.set(OPEN_INDEX, index);

  let writesBefore = db.writes;
  let result = await repairQuestionIndex(store);

  assert.equal(result.unchanged, true, 'reordered keys are the same value');
  assert.equal(db.writes, writesBefore, 'key order alone must not trigger a rewrite');
});
