'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { QuestionsStore } from '../../../src/core/questions/index.mjs';

const OPEN_INDEX = '/kikx/questions/index/open.json';

test('QuestionsStore persists one doc per question and maintains both indexes', async () => {
  let aeordb = createClient();
  let now = 1000;
  let ids = [ 'group_1', 'q_1', 'q_2' ];
  let store = createStore({ aeordb, clock: () => now++, ids });

  let result = await store.createQuestions({
    questions: [
      { text: 'Which database should this use?', priority: 'high' },
      { text: 'Should the sidebar show answered questions?' },
    ],
    mode: 'wait',
    sessionID: 'session_1',
    agentID: 'agent_1',
    contextRefs: [ { type: 'session', id: 'session_1', label: 'Main' } ],
  });

  assert.equal(result.groupID, 'group_1');
  assert.deepEqual(result.questionIDs, [ 'q_1', 'q_2' ]);
  assert.equal(result.status, 'pending');
  assert.equal(result.mode, 'wait');
  assert.equal(typeof result.message, 'string');

  // One doc per question, at the documented path.
  let first = aeordb.files.get('/kikx/questions/q_1.json');
  let second = aeordb.files.get('/kikx/questions/q_2.json');
  assert.ok(first, 'question doc must exist');
  assert.equal(first.id, 'q_1');
  assert.equal(first.groupID, 'group_1');
  assert.equal(first.index, 1);
  assert.equal(first.status, 'open');
  assert.equal(first.mode, 'wait');
  assert.equal(first.priority, 'high');
  assert.equal(first.text, 'Which database should this use?');
  assert.equal(first.sessionID, 'session_1');
  assert.equal(first.agentID, 'agent_1');
  assert.equal(first.answer, null);
  assert.equal(second.index, 2);
  assert.equal(second.priority, 'normal');

  // D-4: there is no options field anywhere in the shape.
  assert.ok(!('options' in first), 'question docs must not carry options');
  assert.ok(!('options' in second));

  // Global open index holds both, oldest first.
  let openIndex = aeordb.files.get(OPEN_INDEX);
  assert.deepEqual(openIndex.ids, [ 'q_1', 'q_2' ]);
  assert.equal(openIndex.summaries.length, 2);
  assert.equal(openIndex.summaries[0].text, 'Which database should this use?');

  // Per-agent mirror.
  let agentIndex = aeordb.files.get('/kikx/agents/agent_1/questions.json');
  assert.deepEqual(agentIndex.ids, [ 'q_1', 'q_2' ]);
  assert.equal(agentIndex.agentID, 'agent_1');
});

test('QuestionsStore enforces the free-form shape, the cap, and empty text', async () => {
  let aeordb = createClient();
  // 1 groupID + up to 25 question IDs per call.
  let store = createStore({ aeordb, ids: [ 'group_1', ...Array.from({ length: 25 }, (_v, i) => `q_${i + 1}`) ] });

  await assert.rejects(
    () => store.createQuestions({ questions: [], mode: 'wait', sessionID: 'session_1', agentID: 'agent_1' }),
    /at least one question/,
  );

  await assert.rejects(
    () => store.createQuestions({
      questions: [ { text: '   ' } ],
      mode: 'wait',
      sessionID: 'session_1',
      agentID: 'agent_1',
    }),
    /text must be a non-empty string/,
  );

  // CAP = 25 is an anti-spam guardrail, not a feature envelope (D-8).
  let tooMany = Array.from({ length: 26 }, (_value, index) => ({ text: `Question ${index + 1}` }));
  await assert.rejects(
    () => store.createQuestions({ questions: tooMany, mode: 'wait', sessionID: 'session_1', agentID: 'agent_1' }),
    /at most 25 questions/,
  );

  let atCap = Array.from({ length: 25 }, (_value, index) => ({ text: `Question ${index + 1}` }));
  let result = await store.createQuestions({ questions: atCap, mode: 'wait', sessionID: 'session_1', agentID: 'agent_1' });
  assert.equal(result.questionIDs.length, 25);
});

test('QuestionsStore rejects an options field so answers stay free-form (D-4)', async () => {
  let aeordb = createClient();
  let store = createStore({ aeordb, ids: [ 'group_1' ] });

  await assert.rejects(
    () => store.createQuestions({
      questions: [ { text: 'Proceed?', options: [ 'yes', 'no' ] } ],
      mode: 'wait',
      sessionID: 'session_1',
      agentID: 'agent_1',
    }),
    /must not carry options/,
  );
});

test('QuestionsStore answers a question, leaves the open index, and keeps history', async () => {
  let aeordb = createClient();
  let now = 1000;
  let ids = [ 'group_1', 'q_1', 'q_2' ];
  let store = createStore({ aeordb, clock: () => now++, ids });

  await store.createQuestions({
    questions: [ { text: 'First?' }, { text: 'Second?' } ],
    mode: 'wait',
    sessionID: 'session_1',
    agentID: 'agent_1',
  });

  let answered = await store.answerQuestion('q_1', { answer: 'Use Postgres 5433.', userID: 'user_1' });

  assert.equal(answered.status, 'answered');
  assert.equal(answered.answer, 'Use Postgres 5433.');
  assert.equal(answered.answeredByUserID, 'user_1');
  assert.equal(typeof answered.answeredAt, 'number');

  // Answered questions leave the open index: it never grows with history.
  assert.deepEqual(aeordb.files.get(OPEN_INDEX).ids, [ 'q_2' ]);
  assert.deepEqual(aeordb.files.get('/kikx/agents/agent_1/questions.json').ids, [ 'q_2' ]);

  // The per-question doc is the immutable record and keeps the answer.
  let persisted = aeordb.files.get('/kikx/questions/q_1.json');
  assert.equal(persisted.status, 'answered');
  assert.equal(persisted.answer, 'Use Postgres 5433.');
});

test('QuestionsStore answer is idempotent: a second answer conflicts and changes nothing', async () => {
  let aeordb = createClient();
  let store = createStore({ aeordb, ids: [ 'group_1', 'q_1' ] });

  await store.createQuestions({ questions: [ { text: 'Only question?' } ], mode: 'wait', sessionID: 'session_1', agentID: 'agent_1' });
  await store.answerQuestion('q_1', { answer: 'first answer', userID: 'user_1' });

  await assert.rejects(
    () => store.answerQuestion('q_1', { answer: 'second answer', userID: 'user_2' }),
    (error) => error.status === 409,
  );

  let persisted = aeordb.files.get('/kikx/questions/q_1.json');
  assert.equal(persisted.answer, 'first answer');
  assert.equal(persisted.answeredByUserID, 'user_1');
});

test('QuestionsStore serialises concurrent answers to the same question', async () => {
  let aeordb = createClient();
  let store = createStore({ aeordb, ids: [ 'group_1', 'q_1' ] });

  await store.createQuestions({ questions: [ { text: 'Race?' } ], mode: 'wait', sessionID: 'session_1', agentID: 'agent_1' });

  // AeorDB has no conditional write, so the read-modify-write needs an
  // in-process mutex: exactly one of these may win.
  let settled = await Promise.allSettled([
    store.answerQuestion('q_1', { answer: 'alpha', userID: 'user_1' }),
    store.answerQuestion('q_1', { answer: 'beta', userID: 'user_2' }),
  ]);

  let fulfilled = settled.filter((entry) => entry.status === 'fulfilled');
  let rejected = settled.filter((entry) => entry.status === 'rejected');

  assert.equal(fulfilled.length, 1, 'exactly one concurrent answer may succeed');
  assert.equal(rejected.length, 1, 'the loser must be rejected, not silently written');
  assert.equal(rejected[0].reason.status, 409);

  let persisted = aeordb.files.get('/kikx/questions/q_1.json');
  assert.ok([ 'alpha', 'beta' ].includes(persisted.answer));
  assert.equal(persisted.status, 'answered');
});

test('QuestionsStore dismisses an open question and refuses to reopen terminal ones', async () => {
  let aeordb = createClient();
  let now = 1000;
  let ids = [ 'group_1', 'q_1', 'q_2' ];
  let store = createStore({ aeordb, clock: () => now++, ids });

  await store.createQuestions({
    questions: [ { text: 'Dismiss me?' }, { text: 'Answer me?' } ],
    mode: 'wait',
    sessionID: 'session_1',
    agentID: 'agent_1',
  });

  let dismissed = await store.dismissQuestion('q_1', { reason: 'superseded' });
  assert.equal(dismissed.status, 'dismissed');
  assert.equal(dismissed.dismissalReason, 'superseded');
  assert.deepEqual(aeordb.files.get(OPEN_INDEX).ids, [ 'q_2' ]);

  // Terminal never reopens, in either direction.
  await assert.rejects(
    () => store.answerQuestion('q_1', { answer: 'too late', userID: 'user_1' }),
    (error) => error.status === 409,
  );
  await assert.rejects(
    () => store.dismissQuestion('q_1', { reason: 'again' }),
    (error) => error.status === 409,
  );

  await store.answerQuestion('q_2', { answer: 'answered', userID: 'user_1' });
  await assert.rejects(
    () => store.dismissQuestion('q_2', { reason: 'after answer' }),
    (error) => error.status === 409,
  );
});

test('QuestionsStore marks an undeliverable answer without dropping it', async () => {
  let aeordb = createClient();
  let store = createStore({ aeordb, ids: [ 'group_1', 'q_1' ] });

  await store.createQuestions({ questions: [ { text: 'Anyone there?' } ], mode: 'wait', sessionID: 'session_1', agentID: 'agent_1' });

  let marked = await store.markUndeliverable('q_1', {
    answer: 'still recorded',
    userID: 'user_1',
    reason: 'agent not a participant',
  });

  assert.equal(marked.status, 'undeliverable');
  assert.equal(marked.answer, 'still recorded', 'never silently drop a user answer');
  assert.equal(marked.dismissalReason, 'agent not a participant');
  assert.deepEqual(aeordb.files.get(OPEN_INDEX).ids, []);
});

test('QuestionsStore reports 404 for unknown questions', async () => {
  let aeordb = createClient();
  let store = createStore({ aeordb });

  await assert.rejects(() => store.getQuestion('nope'), (error) => error.status === 404);
  await assert.rejects(
    () => store.answerQuestion('nope', { answer: 'x', userID: 'user_1' }),
    (error) => error.status === 404,
  );
  await assert.rejects(() => store.dismissQuestion('nope'), (error) => error.status === 404);
});

test('QuestionsStore.listOpen reads only the open index, never the whole store', async () => {
  let aeordb = createClient();
  let now = 1000;
  let ids = [ 'group_1', 'q_1', 'q_2', 'group_2', 'q_3' ];
  let store = createStore({ aeordb, clock: () => now++, ids });

  await store.createQuestions({ questions: [ { text: 'A?' }, { text: 'B?' } ], mode: 'wait', sessionID: 'session_1', agentID: 'agent_1' });
  await store.createQuestions({ questions: [ { text: 'C?' } ], mode: 'continue', sessionID: 'session_2', agentID: 'agent_2' });
  await store.answerQuestion('q_1', { answer: 'done', userID: 'user_1' });

  let listCallsBefore = aeordb.listCalls;
  let open = await store.listOpen();

  assert.equal(aeordb.listCalls, listCallsBefore, 'listOpen must not scan the question store');
  assert.deepEqual(open.ids, [ 'q_2', 'q_3' ]);
  assert.equal(open.summaries.length, 2);

  let bySession = await store.listOpen({ sessionID: 'session_2' });
  assert.deepEqual(bySession.ids, [ 'q_3' ]);

  let byAgent = await store.listOpen({ agentID: 'agent_1' });
  assert.deepEqual(byAgent.ids, [ 'q_2' ]);
});

test('QuestionsStore.reindex rebuilds both indexes from the per-question docs', async () => {
  let aeordb = createClient();
  let now = 1000;
  let ids = [ 'group_1', 'q_1', 'q_2', 'group_2', 'q_3' ];
  let store = createStore({ aeordb, clock: () => now++, ids });

  await store.createQuestions({ questions: [ { text: 'One?' }, { text: 'Two?' } ], mode: 'wait', sessionID: 'session_1', agentID: 'agent_1' });
  await store.createQuestions({ questions: [ { text: 'Three?' } ], mode: 'wait', sessionID: 'session_1', agentID: 'agent_2' });
  await store.answerQuestion('q_1', { answer: 'done', userID: 'user_1' });

  // Indexes are caches, never truth: destroy them and rebuild from disk.
  aeordb.files.delete(OPEN_INDEX);
  aeordb.files.delete('/kikx/agents/agent_1/questions.json');
  aeordb.files.delete('/kikx/agents/agent_2/questions.json');

  let rebuilt = await store.reindex();

  assert.equal(rebuilt.scanned, 3);
  assert.deepEqual(aeordb.files.get(OPEN_INDEX).ids, [ 'q_2', 'q_3' ]);
  assert.deepEqual(aeordb.files.get('/kikx/agents/agent_1/questions.json').ids, [ 'q_2' ]);
  assert.deepEqual(aeordb.files.get('/kikx/agents/agent_2/questions.json').ids, [ 'q_3' ]);
});

test('QuestionsStore tolerates corrupt question docs during reindex', async () => {
  let aeordb = createClient();
  let store = createStore({ aeordb, ids: [ 'group_1', 'q_1' ] });

  await store.createQuestions({ questions: [ { text: 'Good?' } ], mode: 'wait', sessionID: 'session_1', agentID: 'agent_1' });

  aeordb.files.set('/kikx/questions/q_broken.json', { not: 'a question' });
  aeordb.files.set('/kikx/questions/q_null.json', null);

  let rebuilt = await store.reindex();

  assert.equal(rebuilt.scanned, 1, 'only well-formed docs count');
  assert.equal(rebuilt.skipped, 2);
  assert.deepEqual(aeordb.files.get(OPEN_INDEX).ids, [ 'q_1' ]);
});

test('QuestionsStore groups a batch by groupID and exposes sibling context', async () => {
  let aeordb = createClient();
  let now = 1000;
  let ids = [ 'group_1', 'q_1', 'q_2' ];
  let store = createStore({ aeordb, clock: () => now++, ids });

  await store.createQuestions({
    questions: [ { text: 'First?' }, { text: 'Second?' } ],
    mode: 'continue',
    sessionID: 'session_1',
    agentID: 'agent_1',
  });
  await store.answerQuestion('q_1', { answer: 'yes', userID: 'user_1' });

  // D-9: the wake is per question, but carries the whole group for coherence.
  let group = await store.getGroup('group_1');

  assert.equal(group.id, 'group_1');
  assert.equal(group.total, 2);
  assert.deepEqual(group.siblings.map((entry) => entry.id), [ 'q_1', 'q_2' ]);
  assert.deepEqual(group.siblings.map((entry) => entry.status), [ 'answered', 'open' ]);
  assert.equal(group.siblings[0].text, 'First?');
});

function createStore({ aeordb, clock, ids = [], frameStore = null }) {
  let queue = [ ...ids ];
  return new QuestionsStore({
    aeordb,
    frameStore,
    clock: clock || (() => Date.now()),
    idGenerator: () => {
      let next = queue.shift();
      if (!next)
        throw new Error('idGenerator exhausted');

      return next;
    },
  });
}

function createClient() {
  return {
    files: new Map(),
    listCalls: 0,
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
      this.listCalls++;
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


test('a tree-scoped question read includes descendants when the frame store is wired', async () => {
  let aeordb = createClient();
  let frameStore = {
    async listSessions() {
      return [
        { id: 'root', parentSessionID: null },
        { id: 'child', parentSessionID: 'root' },
        { id: 'grandchild', parentSessionID: 'child' },
        { id: 'sibling', parentSessionID: null },
      ];
    },
  };
  let store = createStore({
    aeordb,
    ids: [ 'q_root', 'root-group', 'q_child', 'child-group', 'q_grandchild', 'grandchild-group', 'q_sibling', 'sibling-group' ],
    frameStore,
  });

  await store.createQuestions({ questions: [ { text: 'root question?' } ], sessionID: 'root', agentID: 'agent_1' });
  await store.createQuestions({ questions: [ { text: 'child question?' } ], sessionID: 'child', agentID: 'agent_1' });
  await store.createQuestions({ questions: [ { text: 'grandchild question?' } ], sessionID: 'grandchild', agentID: 'agent_1' });
  await store.createQuestions({ questions: [ { text: 'sibling question?' } ], sessionID: 'sibling', agentID: 'agent_1' });

  let open = await store.listOpen({ rootSessionID: 'root', includeDescendants: true });
  assert.deepEqual(open.summaries.map((question) => question.text).sort(), [ 'child question?', 'grandchild question?', 'root question?' ]);

  let visible = await store.listVisibleQuestions({ sessionID: 'root' });
  assert.deepEqual(visible.sessionIDs.sort(), [ 'child', 'grandchild', 'root' ]);
  assert.deepEqual(visible.questions.map((question) => question.text).sort(), [ 'child question?', 'grandchild question?', 'root question?' ]);
});
