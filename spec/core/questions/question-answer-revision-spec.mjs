'use strict';

// Revising an answered default: the round trip the user asked for.
//
// The behaviour under test, in one sentence: when a default fired and the user
// then submits a DIFFERENT answer, the new answer replaces the default, the
// delivered default stays on the record, the question frame is patched, and the
// asking agent is woken a second time with text that says plainly it is a
// correction.
//
// The negative cases matter as much as the positive one. A question a PERSON
// answered must stay terminal, or this affordance becomes a way to overwrite
// somebody's answer. A dismissal must stay terminal. A question with no
// provenance at all (every doc written before this change) must stay terminal,
// because we cannot tell what it is.

import test from 'node:test';
import assert from 'node:assert/strict';

import { QuestionsStore } from '../../../src/core/questions/questions-store.mjs';
import { applyDefaultAnswer } from '../../../src/core/questions/question-maintenance.mjs';
import {
  isRevisableDefaultAnswer,
  reviseAnswer,
} from '../../../src/core/questions/question-answer-revision.mjs';
import { QuestionAnswerService, buildAnswerPromptText } from '../../../src/core/questions/question-wake.mjs';

const T0 = 1_700_000_000_000;

function createDB() {
  let files = new Map();
  return {
    async getFile(path) {
      if (!files.has(path)) {
        let error = new Error('not found');
        error.status = 404;
        throw error;
      }
      return JSON.parse(files.get(path));
    },
    async putFile(path, body) {
      files.set(path, JSON.stringify(body));
    },
    async deleteFile(path) {
      files.delete(path);
    },
    async listDirectory() {
      return { items: [ ...files.keys() ].map((path) => ({ path })) };
    },
    size() {
      return files.size;
    },
    dump() {
      return new Map(files);
    },
  };
}

function createStore(db, ids) {
  let queue = [ ...ids ];
  return new QuestionsStore({
    db,
    clock: () => T0,
    idGenerator: () => queue.shift(),
    rootPath: '/kikx',
  });
}

async function askWithDefault(store, options = {}) {
  let result = await store.createQuestions({
    sessionID: 'session_1',
    agentID: 'agent_1',
    questions: [ {
      text: 'Which database are we using?',
      defaultAnswer: options.defaultAnswer ?? 'use the default',
      timeoutSeconds: options.timeoutSeconds ?? 60,
    } ],
  });

  return result.questionIDs[0];
}

// --- Provenance, the precondition for all of this ---------------------------

test('a human answer records answerSource=user', async () => {
  let db = createDB();
  let store = createStore(db, [ 'group_1', 'q_1' ]);
  let id = await askWithDefault(store);

  let answered = await store.answerQuestion(id, { answer: 'Postgres', userID: 'user_1' });

  assert.equal(answered.answerSource, 'user', 'a person answered, and the record says so');
  assert.equal(answered.answeredByUserID, 'user_1');
});

test('a default answer records answerSource=default and credits no human', async () => {
  let db = createDB();
  let store = createStore(db, [ 'group_1', 'q_1' ]);
  let id = await askWithDefault(store);

  let applied = await applyDefaultAnswer(store, id, { now: T0 + 60_000 });

  assert.equal(applied.applied, true);
  assert.equal(applied.question.answerSource, 'default');
  assert.equal(applied.question.answeredByUserID, null);
});

// --- The gate ---------------------------------------------------------------

test('only a fired default is revisable', () => {
  assert.equal(isRevisableDefaultAnswer({ status: 'answered', answerSource: 'default' }), true);

  // A human answer: the case this must never allow.
  assert.equal(isRevisableDefaultAnswer({ status: 'answered', answerSource: 'user' }), false);

  // Pre-change docs carry no provenance at all. Unknown is not permissive.
  assert.equal(isRevisableDefaultAnswer({ status: 'answered', answerSource: null }), false);

  assert.equal(isRevisableDefaultAnswer({ status: 'open', answerSource: null }), false);
  assert.equal(isRevisableDefaultAnswer({ status: 'dismissed', answerSource: null }), false);
  assert.equal(isRevisableDefaultAnswer({ status: 'answered', answerSource: 'default', deleted: true }), false);
  assert.equal(isRevisableDefaultAnswer(null), false);
});

// --- The round trip ---------------------------------------------------------

test('a default is replaced by the user answer, and the default is kept', async () => {
  let db = createDB();
  let store = createStore(db, [ 'group_1', 'q_1' ]);
  let id = await askWithDefault(store, { defaultAnswer: 'declined to say' });

  let fired = await applyDefaultAnswer(store, id, { now: T0 + 60_000 });
  assert.equal(fired.question.answer, 'declined to say');

  let result = await reviseAnswer(store, id, { answer: 'Postgres 16', userID: 'user_1' });

  assert.equal(result.revised, true);
  assert.equal(result.question.answer, 'Postgres 16', 'the user answer wins');
  assert.equal(result.question.answerSource, 'user', 'provenance flips to the human');
  assert.equal(result.question.answeredByUserID, 'user_1');

  // The delivered default is preserved, not erased: the agent was told it, and
  // the wake text has to be able to name what it is correcting.
  assert.equal(result.question.supersededDefaultAnswer, 'declined to say');
  assert.equal(result.question.supersededDefaultAt, T0 + 60_000, 'the moment the default fired');
  assert.equal(result.question.revisedAt, T0);

  // A re-read sees the same thing, i.e. the new fields survive the doc
  // allow-list in normalizeQuestionDoc.
  let reread = await store.getQuestion(id);
  assert.equal(reread.answer, 'Postgres 16');
  assert.equal(reread.supersededDefaultAnswer, 'declined to say');
  assert.equal(reread.revisedAt, T0);
});

test('a revision is possible exactly once', async () => {
  let db = createDB();
  let store = createStore(db, [ 'group_1', 'q_1' ]);
  let id = await askWithDefault(store);
  await applyDefaultAnswer(store, id, { now: T0 + 60_000 });

  let first = await reviseAnswer(store, id, { answer: 'Postgres', userID: 'user_1' });
  assert.equal(first.revised, true);

  // After a person has answered, the record is terminal again — otherwise this
  // becomes an edit endpoint with no audit trail.
  let second = await reviseAnswer(store, id, { answer: 'MySQL', userID: 'user_1' });
  assert.equal(second.revised, false);
  assert.match(second.reason, /^not-a-default:answered:user$/);

  let stored = await store.getQuestion(id);
  assert.equal(stored.answer, 'Postgres', 'the second attempt changed nothing');
});

test('a human answer is never revisable', async () => {
  let db = createDB();
  let store = createStore(db, [ 'group_1', 'q_1' ]);
  let id = await askWithDefault(store);

  await store.answerQuestion(id, { answer: 'Postgres', userID: 'user_1' });

  let result = await reviseAnswer(store, id, { answer: 'MySQL', userID: 'user_2' });

  assert.equal(result.revised, false);
  assert.match(result.reason, /^not-a-default:answered:user$/);

  let stored = await store.getQuestion(id);
  assert.equal(stored.answer, 'Postgres', 'the person who answered first wins');
  assert.equal(stored.answeredByUserID, 'user_1');
});

test('a dismissed question is never revisable', async () => {
  let db = createDB();
  let store = createStore(db, [ 'group_1', 'q_1' ]);
  let id = await askWithDefault(store);

  await store.dismissQuestion(id, { reason: 'not needed' });

  let result = await reviseAnswer(store, id, { answer: 'Postgres', userID: 'user_1' });
  assert.equal(result.revised, false);
});

test('a revision keeps the stored answer durable before the wake is attempted', async () => {
  // The store write must happen even when there is no service to deliver it,
  // which is what a crash between the two looks like.
  let db = createDB();
  let store = createStore(db, [ 'group_1', 'q_1' ]);
  let id = await askWithDefault(store);
  await applyDefaultAnswer(store, id, { now: T0 + 60_000 });

  await reviseAnswer(store, id, { answer: 'Postgres', userID: 'user_1' });

  let dump = db.dump();
  let stored = JSON.parse(dump.get(`/kikx/questions/${id}.json`));
  assert.equal(stored.answer, 'Postgres', 'written, not merely returned');
});

// --- The wake text ----------------------------------------------------------

test('a revision wakes the agent with text that names what it replaced', () => {
  let text = buildAnswerPromptText({
    id: 'q_1',
    text: 'Which database are we using?',
    askedAt: T0,
    answeredAt: T0 + 60_000,
    mode: 'wait',
    answer: 'Postgres 16',
    answerSource: 'user',
    supersededDefaultAnswer: 'declined to say',
  });

  assert.match(text, /replacing the default you specified/);
  assert.match(text, /Your default was: declined to say/, 'the old answer is quoted back');
  assert.match(text, /A: Postgres 16/);
  assert.match(text, /should be corrected/, 'the agent is told its assumption may be wrong');

  // The default wording would be a lie about this record: a person DID confirm it.
  assert.doesNotMatch(text, /Nobody confirmed this/);
  assert.doesNotMatch(text, /No answer arrived in time/);
});

test('an unrevised default keeps its original wording', () => {
  let text = buildAnswerPromptText({
    id: 'q_1',
    text: 'Which database are we using?',
    askedAt: T0,
    answeredAt: T0 + 60_000,
    mode: 'wait',
    answer: 'declined to say',
    answerSource: 'default',
  });

  assert.match(text, /No answer arrived in time/);
  assert.match(text, /Nobody confirmed this/);
  assert.doesNotMatch(text, /replacing the default/);
});

// --- Through the service, including the second wake ------------------------

function createRuntime(questionsStore) {
  let appended = [];
  return {
    appended,
    async ensureSessionEntry() {
      // The revision path patches the question frame; with no frame engine the
      // patch is a documented no-op (patchQuestionFrameContent returns false).
      return { session: { participantAgentIDs: [ 'agent_1' ] }, frameEngine: null };
    },
    async appendUserMessage(sessionID, message) {
      appended.push({ sessionID, message });
      return { frameID: message.id, delivered: true };
    },
    async flush() {
      return true;
    },
    clock() {
      return T0;
    },
    idGenerator() {
      return 'wake_1';
    },
    emitRuntimeEvent() {},
  };
}

test('the service wakes the agent a second time, labelled as a correction', async () => {
  let db = createDB();
  let store = createStore(db, [ 'group_1', 'q_1' ]);
  let runtime = createRuntime(store);
  let service = new QuestionAnswerService({
    questionsStore: store,
    frameRuntime: runtime,
    logger: { warn() {} },
  });

  let id = await askWithDefault(store, { defaultAnswer: 'declined to say' });
  await applyDefaultAnswer(store, id, { now: T0 + 60_000 });

  let result = await service.reviseDefaultAnswer(id, { answer: 'Postgres 16', userID: 'user_1' });

  assert.equal(result.revised, true);
  assert.equal(result.question.answer, 'Postgres 16');
  assert.equal(runtime.appended.length, 1, 'exactly one additional wake');

  let wake = runtime.appended[0].message;
  assert.equal(wake.targetAgentID, 'agent_1', 'the asking agent is the target');
  assert.match(wake.content.text, /replacing the default you specified/);
  assert.equal(wake.continuation.kind, 'user-answer');
  assert.equal(wake.continuation.questionID, id);
});

test('the service reports nothing to revise without waking anyone', async () => {
  let db = createDB();
  let store = createStore(db, [ 'group_1', 'q_1' ]);
  let runtime = createRuntime(store);
  let service = new QuestionAnswerService({
    questionsStore: store,
    frameRuntime: runtime,
    logger: { warn() {} },
  });

  let id = await askWithDefault(store);
  await store.answerQuestion(id, { answer: 'Postgres', userID: 'user_1' });

  let result = await service.reviseDefaultAnswer(id, { answer: 'MySQL', userID: 'user_2' });

  assert.equal(result.revised, false);
  assert.equal(runtime.appended.length, 0, 'a refused revision must not wake the agent');
});
