'use strict';

// markRead must leave the open index agreeing with the question doc.
//
// The bug: `markRead` wrote `readAt` to the per-question doc and returned. The
// open index is the ONLY thing the Inbox reads (`listOpen`), and its summaries
// carry `readAt`, so the index kept saying "unread". The sidebar badge derives
// its count from that summary, which is why it sat at "(2)" after the questions
// had been looked at — it re-counted them as unread on every fetch.

import assert from 'node:assert/strict';
import test from 'node:test';

import { QuestionsStore } from '../../../src/core/questions/index.mjs';

const OPEN_INDEX = '/kikx/questions/index/open.json';

function createClient() {
  return {
    files: new Map(),
    async getFile(path) {
      if (!this.files.has(path)) {
        let error = new Error('Not found');
        error.status = 404;
        throw error;
      }

      return this.files.get(path);
    },
    async putFile(path, body) {
      this.files.set(path, JSON.parse(JSON.stringify(body)));
      return { path };
    },
    async deleteFile(path) {
      this.files.delete(path);
      return { path };
    },
    async list(path, options = {}) {
      let prefix = path.endsWith('/') ? path : `${path}/`;
      let glob = options.glob || null;
      let pattern = glob
        ? new RegExp(`^${glob.replace(/\./g, '\\.').replace(/\*/g, '[^/]*')}$`)
        : null;
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

      return { items };
    },
  };
}

function createStore({ aeordb, clock, ids = [] }) {
  let queue = [ ...ids ];
  return new QuestionsStore({
    aeordb,
    clock: clock || (() => Date.now()),
    idGenerator: () => queue.shift() || `id_${Math.random()}`,
  });
}

async function openQuestion(store, aeordb) {
  let result = await store.createQuestions({
    questions: [ { text: 'Which database should this use?' } ],
    mode: 'wait',
    sessionID: 'session_1',
    agentID: 'agent_1',
  });

  let questionID = result.questionIDs[0];
  return { questionID, doc: aeordb.files.get(`/kikx/questions/${questionID}.json`) };
}

function indexSummary(aeordb, questionID) {
  let index = aeordb.files.get(OPEN_INDEX);
  assert.ok(index, 'the open index must exist');

  return (index.summaries || []).find((summary) => summary.id === questionID) || null;
}

test('markRead stamps the doc and the open index together', async () => {
  let aeordb = createClient();
  let now = 1000;
  let store = createStore({ aeordb, clock: () => now++, ids: [ 'group_1', 'q_1' ] });

  let { questionID } = await openQuestion(store, aeordb);

  assert.equal(indexSummary(aeordb, questionID).readAt ?? null, null, 'starts unread');

  let readAt = now;
  let updated = await store.markRead(questionID);

  assert.equal(updated.readAt, readAt, 'the doc records the read');

  let summary = indexSummary(aeordb, questionID);
  assert.ok(summary, 'the question is still open, so it stays in the index');
  assert.equal(
    summary.readAt,
    readAt,
    'the open index carries readAt — otherwise the badge re-counts it as unread',
  );

  // And the read side the Inbox actually uses must agree.
  let open = await store.listOpen();
  let listed = open.summaries.find((entry) => entry.id === questionID);
  assert.equal(listed.readAt, readAt, 'listOpen reports the question as read');
});

test('markRead is idempotent and does not churn the index timestamp', async () => {
  let aeordb = createClient();
  let now = 5000;
  let store = createStore({ aeordb, clock: () => now++, ids: [ 'group_1', 'q_1' ] });

  let { questionID } = await openQuestion(store, aeordb);

  let first = await store.markRead(questionID);
  let indexAfterFirst = JSON.parse(JSON.stringify(aeordb.files.get(OPEN_INDEX)));

  let second = await store.markRead(questionID);
  let indexAfterSecond = aeordb.files.get(OPEN_INDEX);

  assert.equal(second.readAt, first.readAt, 'a second read keeps the first timestamp');
  assert.deepEqual(
    indexAfterSecond.summaries,
    indexAfterFirst.summaries,
    'the summaries are unchanged by an idempotent read',
  );
});
