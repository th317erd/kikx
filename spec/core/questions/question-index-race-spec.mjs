'use strict';

/**
 * Regression coverage for a cross-question index race.
 *
 * `QuestionsStore` keeps the open index in ONE document
 * (`/kikx/questions/index/open.json`) and AeorDB has no conditional write, so
 * every mutation is a read-modify-write of a globally shared file. The store's
 * per-question mutex cannot serialise that: two writes to two *different*
 * questions take two *different* lock keys while mutating the same document.
 *
 * `listOpen()` reads the index only, and `reindex()` has no non-spec caller, so
 * an entry lost here is lost for good — `GET /api/v1/questions` just never
 * shows that question again. These tests pin the index against that loss.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { QuestionsStore } from '../../../src/core/questions/index.mjs';

const OPEN_INDEX = '/kikx/questions/index/open.json';

test('concurrent createQuestions for distinct questions all reach the open index', async () => {
  let aeordb = createClient({ latency: 1 });
  let store = createStore({ aeordb });

  let calls = [];
  for (let index = 0; index < 6; index++) {
    calls.push(store.createQuestions({
      questions: [ { text: `Question ${index}?` } ],
      mode: 'wait',
      sessionID: `session_${index}`,
      agentID: `agent_${index}`,
    }));
  }

  let results = await Promise.all(calls);

  // Every doc must be written — that part was never in doubt.
  assert.equal(aeordb.countPathPrefix('/kikx/questions/'), 6, 'one doc per question');

  let expected = results.map((result) => result.questions[0].id).sort();
  let index = await store.readOpenIndex();
  let actual = [ ...index.ids ].sort();

  assert.deepEqual(
    actual,
    expected,
    `open index lost ${expected.length - actual.length} of ${expected.length} questions`,
  );

  // The summaries are what the API actually returns; ids alone are not enough.
  assert.deepEqual(index.summaries.map((summary) => summary.id).sort(), expected);

  // Every asking agent must have a mirror, since writes race on those too.
  for (let agentID of [ 'agent_0', 'agent_1', 'agent_2', 'agent_3', 'agent_4', 'agent_5' ]) {
    let mirror = aeordb.files.get(`/kikx/agents/${agentID}/questions.json`);
    assert.ok(mirror, `missing agent mirror for ${agentID}`);
    assert.equal(mirror.ids.length, 1, `agent ${agentID} mirror lost its question`);
  }
});

test('answering one question does not erase a concurrently created question from the index', async () => {
  let aeordb = createClient({ latency: 1 });
  let store = createStore({ aeordb });

  let [ existing ] = await store.createQuestions({
    questions: [ { text: 'Already open?' } ],
    mode: 'wait',
    sessionID: 'session_existing',
    agentID: 'agent_existing',
  }).then((result) => result.questions);

  // answerQuestion locks on the question id; createQuestions takes the index
  // lock. Different keys, same document — that is the race.
  let answer = store.answerQuestion(existing.id, { answer: 'yes', userID: 'user_1' });
  let created = [];
  for (let index = 0; index < 4; index++) {
    created.push(store.createQuestions({
      questions: [ { text: `New ${index}?` } ],
      mode: 'wait',
      sessionID: `session_new_${index}`,
      agentID: `agent_new_${index}`,
    }));
  }

  await Promise.all([ answer, ...created ]);
  let results = await Promise.all(created);

  let expected = results.map((result) => result.questions[0].id).sort();
  let openIndex = await store.readOpenIndex();
  let openIDs = [ ...openIndex.ids ].sort();

  assert.deepEqual(openIDs, expected, 'answered question must leave the index; new ones must stay');
  assert.ok(!openIDs.includes(existing.id), 'answered question must not remain in the open index');

  let answered = await store.getQuestion(existing.id);
  assert.equal(answered.status, 'answered');
  assert.equal(answered.answer, 'yes');
});

test('sequential writes still leave the index consistent', async () => {
  // Guards the fix itself: locking must not drop entries when there is no
  // contention, and must not deadlock through createQuestions -> writeIndexes.
  let aeordb = createClient();
  let store = createStore({ aeordb });

  let expected = [];
  for (let index = 0; index < 5; index++) {
    let result = await store.createQuestions({
      questions: [ { text: `Sequential ${index}?` } ],
      mode: 'wait',
      sessionID: `session_seq_${index}`,
      agentID: 'agent_shared',
    });
    expected.push(result.questions[0].id);
  }

  let index = await store.readOpenIndex();
  assert.deepEqual([ ...index.ids ].sort(), [ ...expected ].sort());
  assert.equal(index.summaries.length, 5);
});

function createStore({ aeordb }) {
  let sequence = 0;
  return new QuestionsStore({
    aeordb,
    clock: () => 1000 + (sequence++),
    idGenerator: () => `id_${(sequence++)}_${Math.random().toString(36).slice(2, 8)}`,
  });
}

/**
 * In-memory AeorDB with configurable latency. The latency is what makes this
 * test meaningful: without an await point between the index read and the index
 * write, JavaScript's single-threaded scheduler would hide the race entirely.
 */
function createClient({ latency = 0 } = {}) {
  return {
    files: new Map(),
    countPathPrefix(prefix) {
      let count = 0;
      for (let key of this.files.keys()) {
        // Only per-question docs, not the index or agent mirrors.
        if (key.startsWith(prefix) && /^\/kikx\/questions\/[^/]+\.json$/.test(key))
          count++;
      }

      return count;
    },
    async getFile(path) {
      if (latency)
        await delay(latency);

      if (!this.files.has(path)) {
        let error = new Error('Not found');
        error.status = 404;
        throw error;
      }

      return clone(this.files.get(path));
    },
    async putFile(path, body) {
      if (latency)
        await delay(latency);

      this.files.set(path, clone(body));
      return { path };
    },
    async deleteFile(path) {
      this.files.delete(path);
      return { path };
    },
    async list(path, options = {}) {
      let prefix = path.endsWith('/') ? path : `${path}/`;
      let glob = options.glob || null;
      let pattern = glob ? new RegExp(`^${glob.replace(/\./g, '\\.').replace(/\*/g, '[^/]*')}$`) : null;
      let items = [];

      for (let key of this.files.keys()) {
        if (!key.startsWith(prefix))
          continue;

        let rest = key.slice(prefix.length);
        if (rest.includes('/'))
          continue;

        if (pattern && !pattern.test(rest))
          continue;

        items.push({ path: key });
      }

      return { items, total: items.length, hasMore: false };
    },
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
