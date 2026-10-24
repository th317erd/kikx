'use strict';

// Split wake semantics: a CHANGED post-default answer wakes the asking agent
// once, a CONFIRMATION wakes nobody.
//
// The owner's ruling, verbatim: "the agent already acted on 'declined to say';
// leaving it holding a wrong assumption is the failure mode you just hit.
// Acknowledgements carry no new information, so a wake there is pure noise."
//
// What these tests pin down, in order of how badly each could go wrong:
//
//   1. A confirmation must NOT wake anybody. If it does, every one-click "yes
//      that's right" starts an agent turn to deliver nothing.
//   2. A changed answer MUST wake. If it does not, the agent keeps a wrong
//      assumption forever — the exact failure the whole path exists to fix.
//   3. An unrecognized intent must be treated as a CHANGE. Guessing "confirm"
//      from a malformed request would silently swallow a real correction.
//   4. A confirmation must not rewrite the answer text. The person affirmed the
//      words the agent already has; inventing text they never typed would make
//      the record lie.

import test from 'node:test';
import assert from 'node:assert/strict';

import { QuestionsStore } from '../../../src/core/questions/questions-store.mjs';
import { applyDefaultAnswer } from '../../../src/core/questions/question-maintenance.mjs';
import {
  normalizeRevisionIntent,
  REVISION_INTENT_CHANGE,
  REVISION_INTENT_CONFIRM,
} from '../../../src/core/questions/question-fields.mjs';
import {
  isAcknowledgedDefaultAnswer,
  isRevisableDefaultAnswer,
  reviseAnswer,
} from '../../../src/core/questions/question-answer-revision.mjs';
import { QuestionAnswerService } from '../../../src/core/questions/question-wake.mjs';

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
      defaultAnswer: options.defaultAnswer ?? 'declined to say',
      timeoutSeconds: options.timeoutSeconds ?? 60,
    } ],
  });

  return result.questionIDs[0];
}

// Records every wake attempt. `appended.length` is the assertion that matters:
// it is the difference between "the agent was told" and "the agent was not".
function createRuntime() {
  let appended = [];
  return {
    appended,
    async ensureSessionEntry() {
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

function createService(store, runtime) {
  return new QuestionAnswerService({
    questionsStore: store,
    frameRuntime: runtime,
    logger: { warn() {} },
  });
}

// --- The intent itself -----------------------------------------------------

test('an unknown or absent intent means change, never confirm', () => {
  // The safe direction. A malformed request must not be able to suppress a
  // correction by failing to say what it meant.
  assert.equal(normalizeRevisionIntent(undefined), REVISION_INTENT_CHANGE);
  assert.equal(normalizeRevisionIntent(null), REVISION_INTENT_CHANGE);
  assert.equal(normalizeRevisionIntent(''), REVISION_INTENT_CHANGE);
  assert.equal(normalizeRevisionIntent('nonsense'), REVISION_INTENT_CHANGE);
  assert.equal(normalizeRevisionIntent(true), REVISION_INTENT_CHANGE);
  assert.equal(normalizeRevisionIntent(42), REVISION_INTENT_CHANGE);

  // The declared values, including case tolerance from a hand-written request.
  assert.equal(normalizeRevisionIntent('change'), REVISION_INTENT_CHANGE);
  assert.equal(normalizeRevisionIntent('confirm'), REVISION_INTENT_CONFIRM);
  assert.equal(normalizeRevisionIntent('CONFIRM'), REVISION_INTENT_CONFIRM);
});

// --- The wake split, through the service -----------------------------------

test('a CONFIRMED default wakes nobody at all', async () => {
  let store = createStore(createDB(), [ 'group_1', 'q_1' ]);
  let runtime = createRuntime();
  let service = createService(store, runtime);

  let id = await askWithDefault(store);
  await applyDefaultAnswer(store, id, { now: T0 + 60_000 });

  let result = await service.reviseDefaultAnswer(id, {
    answer: 'declined to say',
    intent: 'confirm',
    userID: 'user_1',
  });

  assert.equal(result.revised, true);
  assert.equal(result.acknowledged, true);
  assert.equal(result.delivered, false);
  assert.equal(result.reason, 'acknowledged');

  // THE assertion. An acknowledgement carries no new information, so starting
  // an agent turn for it is noise.
  assert.equal(runtime.appended.length, 0, 'confirming a default must not wake the agent');
});

test('a CHANGED answer wakes the agent exactly once, as a correction', async () => {
  let store = createStore(createDB(), [ 'group_1', 'q_1' ]);
  let runtime = createRuntime();
  let service = createService(store, runtime);

  let id = await askWithDefault(store);
  await applyDefaultAnswer(store, id, { now: T0 + 60_000 });

  let result = await service.reviseDefaultAnswer(id, {
    answer: 'Postgres 16',
    intent: 'change',
    userID: 'user_1',
  });

  assert.equal(result.revised, true);
  assert.equal(result.acknowledged, false);
  assert.equal(result.delivered, true);

  assert.equal(runtime.appended.length, 1, 'a correction must wake the agent');
  let wake = runtime.appended[0].message;
  assert.equal(wake.targetAgentID, 'agent_1');
  assert.match(wake.content.text, /replacing the default you specified/);
  assert.equal(wake.continuation.kind, 'user-answer');
});

test('an omitted intent behaves as a change and wakes the agent', async () => {
  // The ordinary Inbox path never sends an intent. It must keep waking, or
  // every replacement typed into the box would silently stop reaching the agent
  // that acted on the default.
  let store = createStore(createDB(), [ 'group_1', 'q_1' ]);
  let runtime = createRuntime();
  let service = createService(store, runtime);

  let id = await askWithDefault(store);
  await applyDefaultAnswer(store, id, { now: T0 + 60_000 });

  let result = await service.reviseDefaultAnswer(id, { answer: 'Postgres 16', userID: 'user_1' });

  assert.equal(result.revised, true);
  assert.equal(result.acknowledged, false);
  assert.equal(runtime.appended.length, 1, 'no intent means change means wake');
});

// --- What a confirmation records -----------------------------------------

test('confirming keeps the original answer text and records who confirmed it', async () => {
  let store = createStore(createDB(), [ 'group_1', 'q_1' ]);
  let runtime = createRuntime();
  let service = createService(store, runtime);

  let id = await askWithDefault(store, { defaultAnswer: 'declined to say' });
  await applyDefaultAnswer(store, id, { now: T0 + 60_000 });

  let confirmedAt = T0 + 120_000;
  let result = await service.reviseDefaultAnswer(id, {
    answer: 'declined to say',
    intent: 'confirm',
    userID: 'user_1',
    now: confirmedAt,
  });

  assert.equal(result.question.answer, 'declined to say', 'the text nobody typed is not invented');
  assert.equal(result.question.answerSource, 'default', 'the answer still came from the default');
  assert.equal(result.question.acknowledgedAt, confirmedAt);
  assert.equal(result.question.answeredByUserID, 'user_1', 'a person is credited for confirming');

  // A confirmation is not a correction, so nothing was superseded.
  assert.equal(result.question.supersededDefaultAnswer, null);
  assert.equal(result.question.revisedAt, null);
});

test('a confirmation survives a re-read: acknowledgedAt is not dropped', async () => {
  // The doc allow-list is a whitelist. A field it forgets is silently erased by
  // the next read-modify-write, which would reopen the question and offer the
  // box again on something the user already settled.
  let store = createStore(createDB(), [ 'group_1', 'q_1' ]);
  let id = await askWithDefault(store);
  await applyDefaultAnswer(store, id, { now: T0 + 60_000 });

  await reviseAnswer(store, id, { intent: 'confirm', userID: 'user_1', now: T0 + 90_000 });

  let reread = await store.getQuestion(id);
  assert.equal(reread.acknowledgedAt, T0 + 90_000);
  assert.equal(isAcknowledgedDefaultAnswer(reread), true);
});

test('a confirmed default can still be replaced — a misclick must stay fixable', async () => {
  let store = createStore(createDB(), [ 'group_1', 'q_1' ]);
  let id = await askWithDefault(store);
  await applyDefaultAnswer(store, id, { now: T0 + 60_000 });

  let first = await reviseAnswer(store, id, { intent: 'confirm', userID: 'user_1' });
  assert.equal(first.revised, true);
  assert.equal(first.acknowledged, true);

  // The reason this matters: confirming wakes NOBODY. If it were also terminal,
  // one misclick would strand the asking agent on a wrong answer it was never
  // told about, with no path left to correct it. The correction path therefore
  // stays open underneath an acknowledgement.
  let second = await reviseAnswer(store, id, { answer: 'MySQL', userID: 'user_2' });
  assert.equal(second.revised, true, 'a confirmed default is still correctable');
  assert.equal(second.acknowledged, false);

  let stored = await store.getQuestion(id);
  assert.equal(stored.answer, 'MySQL');
  assert.equal(stored.answerSource, 'user', 'a person typed this, so provenance flips');
  assert.equal(stored.supersededDefaultAnswer, 'declined to say', 'the default is preserved');
  assert.equal(stored.acknowledgedAt, null, 'the acknowledgement belonged to the answer it affirmed');
});

test('a second confirmation is a no-op, not a replay', async () => {
  let store = createStore(createDB(), [ 'group_1', 'q_1' ]);
  let id = await askWithDefault(store);
  await applyDefaultAnswer(store, id, { now: T0 + 60_000 });

  let first = await reviseAnswer(store, id, { intent: 'confirm', userID: 'user_1', now: T0 + 90_000 });
  assert.equal(first.acknowledged, true);
  assert.equal(first.question.acknowledgedAt, T0 + 90_000);

  // A double-click, or a second tab, must not rewrite who confirmed it or when.
  let second = await reviseAnswer(store, id, { intent: 'confirm', userID: 'user_2', now: T0 + 99_000 });
  assert.equal(second.revised, true, 'the intent was already satisfied; nothing to reject');
  assert.equal(second.question.acknowledgedAt, T0 + 90_000, 'the first confirmation stands');
  assert.equal(second.question.answeredByUserID, 'user_1');
});

test('a confirmation needs no text of its own', async () => {
  // The one action that carries no text must not be the one action that
  // requires text. Normalizing unconditionally made every confirm throw.
  let store = createStore(createDB(), [ 'group_1', 'q_1' ]);
  let id = await askWithDefault(store);
  await applyDefaultAnswer(store, id, { now: T0 + 60_000 });

  let result = await reviseAnswer(store, id, { intent: 'confirm', userID: 'user_1' });
  assert.equal(result.revised, true);
  assert.equal(result.acknowledged, true);
});

test('a confirmation leaves a human answer terminal', async () => {
  let store = createStore(createDB(), [ 'group_1', 'q_1' ]);
  let id = await askWithDefault(store);

  await store.answerQuestion(id, { answer: 'Postgres', userID: 'user_1' });

  let result = await reviseAnswer(store, id, { intent: 'confirm', userID: 'user_2' });
  assert.equal(result.revised, false, 'a person already answered; there is no default to confirm');
  assert.match(result.reason, /^not-a-default:answered:user$/);

  let stored = await store.getQuestion(id);
  assert.equal(stored.acknowledgedAt, null, 'nothing was confirmed');
});

test('a confirmation on an open question is refused, not silently accepted', async () => {
  let store = createStore(createDB(), [ 'group_1', 'q_1' ]);
  let id = await askWithDefault(store);

  let result = await reviseAnswer(store, id, { intent: 'confirm', userID: 'user_1' });
  assert.equal(result.revised, false);
  assert.match(result.reason, /^not-a-default:open:null$/);
});

// --- The gate is unchanged for the change path ----------------------------

test('isRevisableDefaultAnswer still refuses everything it refused before', () => {
  assert.equal(isRevisableDefaultAnswer({ status: 'answered', answerSource: 'default' }), true);
  assert.equal(isRevisableDefaultAnswer({ status: 'answered', answerSource: 'user' }), false);
  assert.equal(isRevisableDefaultAnswer({ status: 'answered', answerSource: null }), false);
  assert.equal(isRevisableDefaultAnswer({ status: 'open', answerSource: null }), false);
  assert.equal(isRevisableDefaultAnswer(null), false);

  // A confirmed default does NOT drop out of the revisable set. Confirming is
  // silent, so it must not also be final.
  assert.equal(isRevisableDefaultAnswer({
    status: 'answered',
    answerSource: 'default',
    acknowledgedAt: T0,
  }), true);
});
