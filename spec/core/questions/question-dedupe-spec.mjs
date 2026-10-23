'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { AskUserTool, QuestionListTool } from '../../../src/core/tools/index.mjs';
import { QuestionsStore } from '../../../src/core/questions/index.mjs';
import {
  findDuplicateQuestions,
  questionTextKey,
  resolveVisibleSessionIDs,
  visibleQuestionDigest,
} from '../../../src/core/questions/question-dedupe.mjs';

// ---------------------------------------------------------------------------
// Unit: the digest and the duplicate key
// ---------------------------------------------------------------------------

test('the digest is stable, content-addressed, and order-independent', () => {
  let a = { id: 'q_1', text: 'Ship it?', status: 'open', sessionID: 's_1', askedAt: 1 };
  let b = { id: 'q_2', text: 'Later?', status: 'open', sessionID: 's_1', askedAt: 2 };

  assert.equal(visibleQuestionDigest([ a, b ]), visibleQuestionDigest([ b, a ]));
  assert.equal(visibleQuestionDigest([]), visibleQuestionDigest([]));
  assert.notEqual(visibleQuestionDigest([]), visibleQuestionDigest([ a ]));
});

test('the digest changes on every mutation that matters, and not on cosmetic reordering', () => {
  let base = { id: 'q_1', text: 'Ship it?', status: 'open', sessionID: 's_1', askedAt: 1 };
  let baseline = visibleQuestionDigest([ base ]);

  // Adding a question.
  assert.notEqual(baseline, visibleQuestionDigest([
    base,
    { id: 'q_2', text: 'Later?', status: 'open', sessionID: 's_1', askedAt: 2 },
  ]));

  // The set emptying out — the state right after the user answers.
  assert.notEqual(baseline, visibleQuestionDigest([]));

  // Rewording an existing pending question.
  assert.notEqual(baseline, visibleQuestionDigest([ { ...base, text: 'Do it?' } ]));

  // A different session in the visible set.
  assert.notEqual(baseline, visibleQuestionDigest([ { ...base, sessionID: 's_2' } ]));
});

test('the duplicate key ignores casing, whitespace, quotes, and trailing punctuation only', () => {
  assert.equal(questionTextKey('  Should I ship it?  '), questionTextKey('should i ship it'));
  assert.equal(questionTextKey('"Ship it?"'), questionTextKey('ship it'));
  assert.equal(questionTextKey('Ship   it'), questionTextKey('ship it'));

  // Wording and word order still carry meaning: a deliberate rephrase is allowed.
  assert.notEqual(questionTextKey('Should I ship it?'), questionTextKey('Should I not ship it?'));
  assert.notEqual(questionTextKey('Ship it now'), questionTextKey('Ship it later'));
  assert.equal(questionTextKey(''), '');
  assert.equal(questionTextKey(null), '');
});

test('findDuplicateQuestions reports every collision with the existing question', () => {
  let summaries = [
    { id: 'q_1', text: 'Which database?', status: 'open', askedAt: 10 },
    { id: 'q_2', text: 'Which port?', status: 'open', askedAt: 20 },
  ];

  let duplicates = findDuplicateQuestions({
    summaries,
    questions: [
      { text: 'totally new question' },
      { text: '  which DATABASE ' },
      { text: 'Which port?' },
    ],
  });

  assert.equal(duplicates.length, 2);
  assert.equal(duplicates[0].existingQuestionID, 'q_1');
  assert.equal(duplicates[0].index, 1);
  assert.equal(duplicates[1].existingQuestionID, 'q_2');
  assert.equal(duplicates[1].index, 2);
});

test('resolveVisibleSessionIDs walks descendants and never siblings', () => {
  let sessions = [
    { id: 'root' },
    { id: 'child_a', parentSessionID: 'root' },
    { id: 'grandchild', parentSessionID: 'child_a' },
    { id: 'sibling', parentSessionID: 'other_root' },
    { id: 'other_root' },
  ];

  let visible = resolveVisibleSessionIDs('child_a', sessions).sort();
  assert.deepEqual(visible, [ 'child_a', 'grandchild' ]);

  assert.deepEqual(resolveVisibleSessionIDs('root', sessions).sort(), [
    'child_a',
    'grandchild',
    'root',
  ]);
});

test('resolveVisibleSessionIDs terminates on a parent/child cycle', () => {
  let sessions = [
    { id: 'a', parentSessionID: 'b' },
    { id: 'b', parentSessionID: 'a' },
  ];

  // Must not hang; the root is still included.
  assert.deepEqual(resolveVisibleSessionIDs('a', sessions).sort(), [ 'a', 'b' ]);
});

// ---------------------------------------------------------------------------
// Integration: the gate ask-user actually enforces
// ---------------------------------------------------------------------------

test('ask-user refuses when the agent did not look first', async () => {
  let { tool, store } = createHarness([ 'group_1', 'q_1' ]);

  await assert.rejects(
    () => tool.execute({ questions: [ { text: 'Anything new?' } ] }),
    /requires observedQuestionDigest.*question-list/s,
  );

  // Nothing was persisted: the gate runs before the write.
  assert.equal(await openCount(store), 0);
});

test('ask-user refuses a digest that went stale between the list and the ask', async () => {
  let { tool, store } = createHarness([ 'group_1', 'q_1', 'group_2', 'q_2' ]);

  // The agent looks...
  let lister = new QuestionListTool(createContext({ questionsStore: store }));
  let looked = await lister.execute({});
  assert.equal(looked.total, 0);

  // ...then something else lands a question (another agent, another tab).
  await createHarnessAsk(store, [ 'group_2', 'q_2' ].slice(0, 2));

  // The replayed digest no longer describes reality, so the ask is refused.
  await assert.rejects(
    () => tool.execute({
      questions: [ { text: 'Anything new?' } ],
      observedQuestionDigest: looked.openDigest,
    }),
    /pending question set has changed since you listed it/s,
  );
});

test('ask-user refuses to duplicate a question that is already pending', async () => {
  let { tool, store } = createHarness([ 'group_1', 'q_1' ]);

  await lookAndAsk(tool, store, { questions: [ { text: 'Which database should prod use?' } ] });

  let lister = new QuestionListTool(createContext({ questionsStore: store }));
  let looked = await lister.execute({});
  assert.equal(looked.total, 1);
  assert.equal(looked.questions[0].text, 'Which database should prod use?');

  // Same question, differently padded and cased — the case the user actually saw.
  await assert.rejects(
    () => tool.execute({
      questions: [ { text: '  which database should PROD use  ' } ],
      observedQuestionDigest: looked.openDigest,
    }),
    /duplicates existing question q_1/s,
  );

  assert.equal(await openCount(store), 1, 'the duplicate was not persisted');
});

test('ask-user allows a partially answered batch to be followed by the remaining questions', async () => {
  let { tool, store } = createHarness([ 'group_1', 'q_1', 'q_2', 'group_2', 'q_3' ]);

  // A batch of two.
  await lookAndAsk(tool, store, {
    questions: [ { text: 'Name the service?' }, { text: 'Choose the port?' } ],
  });

  // The user answers the first and dismisses the second.
  await store.answerQuestion('q_1', { answer: 'kikx', answeredByUserID: 'user_1' });
  await store.dismissQuestion('q_2', { reason: 'not needed' });

  let lister = new QuestionListTool(createContext({ questionsStore: store }));
  let looked = await lister.execute({ status: 'all' });

  assert.equal(looked.total, 2);
  let byStatus = looked.questions.map((question) => [ question.id, question.status ]);
  assert.deepEqual(byStatus, [ [ 'q_1', 'answered' ], [ 'q_2', 'dismissed' ] ]);
  assert.equal(looked.questions[0].answer, 'kikx');

  // With both terminal, the pending set is empty and the agent is free to ask
  // the remaining questions without being blocked as a duplicate.
  let pending = await lister.execute({});
  assert.equal(pending.total, 0);

  await tool.execute({
    questions: [ { text: 'Which logger should it use?' } ],
    observedQuestionDigest: pending.openDigest,
  });

  assert.equal(await openCount(store), 1);
});

test('question-list scopes to the session tree and hides sibling sessions', async () => {
  let aeordb = createClient();
  let store = createStore(aeordb, [ 'group_1', 'q_1', 'group_2', 'q_2', 'group_3', 'q_3' ]);

  // Three sessions: root, its child, and an unrelated sibling tree.
  await store.createQuestions({ questions: [ { text: 'in root' } ], sessionID: 'root', agentID: 'agent_1' });
  await store.createQuestions({ questions: [ { text: 'in child' } ], sessionID: 'child', agentID: 'agent_1' });
  await store.createQuestions({ questions: [ { text: 'in stranger' } ], sessionID: 'stranger', agentID: 'agent_1' });

  // The session tree is discovered through frameRuntime; stand it in.
  store.frameStore = {
    listSessions: async () => [
      { id: 'root' },
      { id: 'child', parentSessionID: 'root' },
      { id: 'stranger' },
    ],
  };

  let fromChild = await store.listVisibleQuestions({ sessionID: 'child', status: 'open' });
  assert.deepEqual(fromChild.sessionIDs.sort(), [ 'child' ]);
  assert.deepEqual(fromChild.questions.map((question) => question.text), [ 'in child' ]);

  let fromRoot = await store.listVisibleQuestions({ sessionID: 'root', status: 'open' });
  assert.deepEqual(fromRoot.sessionIDs.sort(), [ 'child', 'root' ]);
  assert.deepEqual(fromRoot.questions.map((question) => question.text).sort(), [ 'in child', 'in root' ]);

  // The sibling tree is invisible from either.
  assert.ok(!fromRoot.questions.some((question) => question.text === 'in stranger'));
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function createHarness(ids) {
  let aeordb = createClient();
  let store = createStore(aeordb, [ ...ids ]);
  let tool = new AskUserTool(createContext({ questionsStore: store }));
  return { aeordb, store, tool };
}

// Look, then ask — the same two-step the gate exists to force. Using it in the
// tests keeps them honest about the real call sequence.
async function lookAndAsk(tool, store, params = {}) {
  let lister = new QuestionListTool(createContext({ questionsStore: store }));
  let looked = await lister.execute({});
  return await tool.execute({ ...params, observedQuestionDigest: looked.openDigest });
}

async function createHarnessAsk(store, _ids) {
  await store.createQuestions({
    questions: [ { text: 'a question from somewhere else' } ],
    sessionID: 'session_1',
    agentID: 'agent_1',
  });
}

async function openCount(store) {
  let open = await store.listOpen({ sessionID: 'session_1' });
  return open.summaries.length;
}

function createContext({ questionsStore }) {
  return {
    agent: { id: 'agent_1', name: 'Zav' },
    session: { id: 'session_1' },
    frame: { id: 'frame_root', interactionID: 'interaction_1' },
    todoState: null,
    // No frame engine: emitting Question frames is best-effort and not what
    // these tests are about.
    frameEngine: null,
    services: { questionsStore },
    questionsStore,
  };
}

function createStore(aeordb, ids) {
  let queue = [ ...ids ];
  let now = 1000;
  return new QuestionsStore({
    aeordb,
    clock: () => now++,
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
