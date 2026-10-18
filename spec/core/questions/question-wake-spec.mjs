'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  QuestionAnswerService,
  QuestionsStore,
  buildAnswerPromptText,
} from '../../../src/core/questions/index.mjs';
import { isAutonomousContinuation } from '../../../src/core/runtime/autonomous-chain.mjs';
import { resolveRouteTargets } from '../../../src/core/agents/agent-route/targeting.mjs';

// Plan §8, the answer/wake loop.
//
// The load-bearing requirement is not "an answer is stored" — the store spec
// already covers that. It is "an answered question produces exactly ONE visible,
// single-targeted wake carrying the whole batch", because the wake is what
// restarts the asking agent's turn ([D-9], D-5).

test('answering a question posts exactly one visible targeted UserMessage', async () => {
  let questionsStore = createStore(createClient(), [ 'group_1', 'q_1' ]);
  let runtime = createRuntime();
  let service = createService({ questionsStore, runtime });

  await questionsStore.createQuestions({
    questions: [ { text: 'Which database should this use?' } ],
    mode: 'wait',
    sessionID: 'session_1',
    agentID: 'agent_1',
  });

  let result = await service.submitAnswer('q_1', {
    answer: 'Postgres on 5433.',
    userID: 'user_1',
  });

  assert.equal(result.delivered, true);
  assert.equal(result.sessionID, 'session_1');
  assert.equal(result.agentID, 'agent_1');
  assert.equal(result.frameID, 'frame_1');

  // Exactly one wake; a second message would double-run the asker.
  assert.equal(runtime.appended.length, 1, 'one answered question must post exactly one wake');

  let frame = runtime.appended[0].frame;

  // Single-target + visible: `targetAgentID` is what makes it a wake for ONE
  // agent, and hidden/deleted frames are not routed at all.
  assert.equal(frame.targetAgentID, 'agent_1');
  assert.equal(frame.hidden, false);
  assert.equal(frame.deleted, false);
  assert.equal(frame.authorType, 'user');
  assert.equal(frame.authorID, 'user_1');
  assert.equal(frame.type, 'UserMessage');
  assert.equal(frame.sessionID, 'session_1');

  // The continuation kind is the marker the runtime and the cancel paths key on.
  assert.equal(frame.continuation.kind, 'user-answer');
  assert.equal(frame.continuation.questionID, 'q_1');
  assert.equal(frame.continuation.groupID, 'group_1');
  assert.equal(frame.continuation.mode, 'wait');

  // The wake is what the model sees first, so it must carry the Q and the A.
  assert.equal(frame.content.question.id, 'q_1');
  assert.equal(frame.content.question.status, 'answered');
  assert.ok(frame.content.text.includes('Which database should this use?'));
  assert.ok(frame.content.text.includes('Postgres on 5433.'));

  // Runtime event so the UI can reconcile the answer with its wake frame.
  let answeredEvents = runtime.events.filter((event) => event.type === 'question.answered');
  assert.equal(answeredEvents.length, 1);
  assert.equal(answeredEvents[0].payload.sessionID, 'session_1');
  assert.equal(answeredEvents[0].payload.frameID, 'frame_1');
});

test('the wake routes to the asking agent only, never to the whole session', async () => {
  let questionsStore = createStore(createClient(), [ 'group_1', 'q_1' ]);
  let runtime = createRuntime();
  let service = createService({ questionsStore, runtime });

  await questionsStore.createQuestions({
    questions: [ { text: 'Proceed with the migration?' } ],
    mode: 'wait',
    sessionID: 'session_1',
    agentID: 'agent_1',
  });

  await service.submitAnswer('q_1', { answer: 'Yes, go ahead.', userID: 'user_1' });

  let frame = runtime.appended[0].frame;
  let participantAgentIDs = [ 'agent_1', 'agent_2' ];

  // Load-bearing: with `targetAgentID` the real router short-circuits to the
  // single asking agent, even though another agent is also a participant.
  let targets = resolveRouteTargets({
    frame,
    participantAgentIDs,
    coordinatorAgentID: 'agent_2',
  });
  assert.deepEqual(targets, [ 'agent_1' ]);

  // Without it, routing falls back to the usual rules and the asker — the only
  // agent that holds the question's context — would never be woken.
  let unrouted = resolveRouteTargets({
    frame: { ...frame, targetAgentID: undefined },
    participantAgentIDs,
    coordinatorAgentID: 'agent_2',
  });
  assert.ok(!unrouted.includes('agent_1'), 'without targetAgentID the asker is not woken at all');

  // A target that left the session is not deliverable, so it must not route.
  let stale = resolveRouteTargets({
    frame: { ...frame, targetAgentID: 'agent_gone' },
    participantAgentIDs,
    coordinatorAgentID: 'agent_2',
  });
  assert.deepEqual(stale, []);
});

test('the wake carries the whole batch so one answer stays coherent (D-9)', async () => {
  let questionsStore = createStore(createClient(), [ 'group_1', 'q_1', 'q_2', 'q_3' ]);
  let runtime = createRuntime();
  let service = createService({ questionsStore, runtime });

  await questionsStore.createQuestions({
    questions: [
      { text: 'First question?' },
      { text: 'Second question?' },
      { text: 'Third question?' },
    ],
    mode: 'continue',
    sessionID: 'session_1',
    agentID: 'agent_1',
  });

  await service.submitAnswer('q_2', { answer: 'Only the second one.', userID: 'user_1' });

  assert.equal(runtime.appended.length, 1, 'answering one member of a batch posts one wake');

  let question = runtime.appended[0].frame.content.question;

  assert.equal(question.id, 'q_2');
  assert.equal(question.text, 'Second question?');
  assert.equal(question.answer, 'Only the second one.');
  assert.equal(question.mode, 'continue');

  // The group rides along: without it a stale single answer loses the flow.
  assert.equal(question.group.id, 'group_1');
  assert.equal(question.group.total, 3);
  assert.equal(question.group.index, 2);
  assert.equal(question.group.siblings.length, 3);
  assert.deepEqual(
    question.group.siblings.map((sibling) => sibling.id),
    [ 'q_1', 'q_2', 'q_3' ],
  );

  // Answered sibling is terminal; the two others are still waiting on the user.
  assert.deepEqual(
    question.group.siblings.map((sibling) => sibling.status),
    [ 'open', 'answered', 'open' ],
  );

  let text = runtime.appended[0].frame.content.text;
  assert.ok(text.includes('Only the second one.'));
  assert.ok(text.includes('Batch context: 1 of 3 answered.'));
  assert.ok(text.includes('First question?'));
  assert.ok(text.includes('Third question?'));
});

test('a duplicate answer is a 409 and never posts a second wake', async () => {
  let questionsStore = createStore(createClient(), [ 'group_1', 'q_1' ]);
  let runtime = createRuntime();
  let service = createService({ questionsStore, runtime });

  await questionsStore.createQuestions({
    questions: [ { text: 'Once only?' } ],
    mode: 'wait',
    sessionID: 'session_1',
    agentID: 'agent_1',
  });

  await service.submitAnswer('q_1', { answer: 'first answer', userID: 'user_1' });

  await assert.rejects(
    () => service.submitAnswer('q_1', { answer: 'second answer', userID: 'user_2' }),
    (error) => error.status === 409,
  );

  // The first answer stands and the asker is not woken twice.
  assert.equal(runtime.appended.length, 1, 'a rejected duplicate must not wake the agent again');
  assert.equal(runtime.appended[0].frame.content.question.answer, 'first answer');
});

test('deliverAnswer reports a non-participant asker as undeliverable, without throwing', async () => {
  let questionsStore = createStore(createClient(), [ 'group_1', 'q_1' ]);
  let runtime = createRuntime({ participantAgentIDs: [ 'agent_2' ] });
  let service = createService({ questionsStore, runtime });

  await questionsStore.createQuestions({
    questions: [ { text: 'Anyone there?' } ],
    mode: 'wait',
    sessionID: 'session_1',
    agentID: 'agent_1',
  });
  let answered = await questionsStore.answerQuestion('q_1', { answer: 'still recorded', userID: 'user_1' });

  // Delivery is best-effort by contract: a non-participant asker is a reason,
  // not an exception, so the caller can persist the outcome.
  let delivery = await service.deliverAnswer(answered, { userID: 'user_1' });

  assert.equal(delivery.delivered, false);
  assert.equal(delivery.reason, 'agent-not-participant');
  assert.equal(runtime.appended.length, 0, 'no wake is posted to an agent outside the session');
});

test('deliverAnswer reports a missing origin session as origin-session-missing', async () => {
  let questionsStore = createStore(createClient(), [ 'group_1', 'q_1' ]);
  let runtime = createRuntime({ ensureThrows404: true });
  let service = createService({ questionsStore, runtime });

  await questionsStore.createQuestions({
    questions: [ { text: 'Anyone there?' } ],
    mode: 'wait',
    sessionID: 'session_1',
    agentID: 'agent_1',
  });
  let answered = await questionsStore.answerQuestion('q_1', { answer: 'still recorded', userID: 'user_1' });

  let delivery = await service.deliverAnswer(answered, { userID: 'user_1' });

  assert.equal(delivery.delivered, false);
  assert.equal(delivery.reason, 'origin-session-missing');
  assert.equal(runtime.appended.length, 0);
});

test('a disabled or deleted agent is undeliverable rather than silently woken', async () => {
  let questionsStore = createStore(createClient(), [ 'group_1', 'q_1' ]);
  let runtime = createRuntime();
  let service = createService({
    questionsStore,
    runtime,
    agentManager: { async getAgent() { return { id: 'agent_1', enabled: false }; } },
  });

  await questionsStore.createQuestions({
    questions: [ { text: 'Still running?' } ],
    mode: 'wait',
    sessionID: 'session_1',
    agentID: 'agent_1',
  });
  let answered = await questionsStore.answerQuestion('q_1', { answer: 'yes', userID: 'user_1' });

  let delivery = await service.deliverAnswer(answered, { userID: 'user_1' });

  assert.equal(delivery.delivered, false);
  assert.equal(delivery.reason, 'agent-unavailable');
  assert.equal(runtime.appended.length, 0);
});

test('an undeliverable answer is never dropped, whichever path records it', async () => {
  let aeordb = createClient();
  let questionsStore = createStore(aeordb, [ 'group_1', 'q_1' ]);
  let runtime = createRuntime({ participantAgentIDs: [ 'agent_2' ] });
  let service = createService({ questionsStore, runtime });

  await questionsStore.createQuestions({
    questions: [ { text: 'Anyone there?' } ],
    mode: 'wait',
    sessionID: 'session_1',
    agentID: 'agent_1',
  });

  let outcome = null;
  try {
    outcome = await service.submitAnswer('q_1', { answer: 'kept no matter what', userID: 'user_1' });
  } catch (error) {
    outcome = { threw: error };
  }

  // Whatever the service does with the failure, the user's words survive: the
  // doc is terminal and still carries the text, and nothing was delivered.
  let persisted = aeordb.files.get('/kikx/questions/q_1.json');
  assert.equal(persisted.answer, 'kept no matter what', 'a user answer must never be silently dropped');
  assert.equal(persisted.answeredByUserID, 'user_1');
  assert.notEqual(persisted.status, 'open', 'an undeliverable answer must still close the question');
  assert.equal(runtime.appended.length, 0, 'an undeliverable answer must not post a wake');
  assert.ok(outcome, 'submitAnswer must settle');
});

// RESOLVED SOURCE DIVERGENCE (plan §8 vs src/core/questions/question-wake.mjs).
//
// Formerly `submitAnswer` answered the question first (status 'answered') and
// only then called `QuestionsStore.markUndeliverable()`, whose `assertOpen()`
// rejects terminal questions with a 409 — so the call threw instead of
// returning `{ delivered:false, reason }`.
//
// `markUndeliverable` now uses `assertCanMarkUndeliverable()`, which admits
// 'open' and the post-persist terminal 'answered', so the undeliverable path
// settles and the status becomes 'undeliverable'. These tests are ordinary
// blocking assertions again — keep them that way.

test('submitAnswer records an undeliverable answer instead of throwing', async () => {
  let aeordb = createClient();
  let questionsStore = createStore(aeordb, [ 'group_1', 'q_1' ]);
  let runtime = createRuntime({ participantAgentIDs: [ 'agent_2' ] });
  let service = createService({ questionsStore, runtime });

  await questionsStore.createQuestions({
    questions: [ { text: 'Anyone there?' } ],
    mode: 'wait',
    sessionID: 'session_1',
    agentID: 'agent_1',
  });

  let result = await service.submitAnswer('q_1', { answer: 'kept anyway', userID: 'user_1' });

  assert.equal(result.delivered, false);
  assert.equal(result.reason, 'agent-not-participant');
  assert.equal(result.question.status, 'undeliverable');
  assert.equal(result.question.answer, 'kept anyway');
  assert.equal(aeordb.files.get('/kikx/questions/q_1.json').status, 'undeliverable');

  // The state change is announced so the UI stops showing a pending question.
  let updated = runtime.events.filter((event) => event.type === 'question.updated');
  assert.equal(updated.length, 1);
  assert.equal(updated[0].payload.reason, 'agent-not-participant');
});

test('submitAnswer records a deleted origin session as undeliverable', async () => {
  let aeordb = createClient();
  let questionsStore = createStore(aeordb, [ 'group_1', 'q_1' ]);
  let runtime = createRuntime({ ensureThrows404: true });
  let service = createService({ questionsStore, runtime });

  await questionsStore.createQuestions({
    questions: [ { text: 'Anyone there?' } ],
    mode: 'wait',
    sessionID: 'session_1',
    agentID: 'agent_1',
  });

  let result = await service.submitAnswer('q_1', { answer: 'kept anyway', userID: 'user_1' });

  assert.equal(result.delivered, false);
  assert.equal(result.reason, 'origin-session-missing');
  assert.equal(result.question.status, 'undeliverable');
  assert.equal(result.question.answer, 'kept anyway');
});

test('user-answer is not an autonomous continuation, so a human answer is never cancelled (D-5)', async () => {
  // Autonomous wakes are cancelled as chatter; a human answer must never be in
  // that set or a real reply could be retired before the agent ever sees it.
  assert.equal(isAutonomousContinuation({ kind: 'user-answer' }), false);
  assert.equal(isAutonomousContinuation(null), false);

  // Contrast: the chain-fail-safe kinds are still autonomous.
  assert.equal(isAutonomousContinuation({ kind: 'exec-wake-on-completion' }), true);
  assert.equal(isAutonomousContinuation({ kind: 'send' }), true);
});

test('buildAnswerPromptText stands on its own for a stale answer', () => {
  let question = {
    id: 'q_1',
    text: 'Should the sidebar show answered questions?',
    answer: 'Yes, but collapsed by default.',
    askedAt: 0,
    answeredAt: 120_000,
    mode: 'wait',
    contextRefs: [],
  };

  let text = buildAnswerPromptText(question, null);

  // The model may see this text long after the question scrolled away, so it
  // must contain both halves of the exchange.
  assert.ok(text.includes('Should the sidebar show answered questions?'), 'wake text must quote the question');
  assert.ok(text.includes('Yes, but collapsed by default.'), 'wake text must carry the answer');
  assert.ok(text.includes('2m ago'), 'wake text should say how stale the question is');
  assert.ok(text.includes('Continue from here.'), 'wait-mode wakes resume the turn');

  // Steering text differs: an answer that arrives mid-turn supersedes the work.
  let steer = buildAnswerPromptText({ ...question, mode: 'continue' }, null);
  assert.ok(steer.includes('supersedes it'));

  // An answered member of a batch still names its unanswered siblings.
  let batch = buildAnswerPromptText({ ...question, id: 'q_2', text: 'Second?' }, {
    id: 'group_1',
    total: 2,
    siblings: [
      { id: 'q_1', text: 'First?', status: 'answered' },
      { id: 'q_2', text: 'Second?', status: 'answered' },
    ],
  });
  assert.ok(batch.includes('Batch context: 2 of 2 answered.'));
});

// A fake runtime exposing only what QuestionAnswerService touches. `frame`
// mirrors the construction in FrameRuntime#appendUserMessage (visible, user
// authored, content built from `content.text` plus merged extra keys).
function createRuntime({
  participantAgentIDs = [ 'agent_1' ],
  ensureThrows404 = false,
  deletedAt = null,
} = {}) {
  let runtime = {
    appended: [],
    events: [],
    async ensureSessionEntry(sessionID) {
      if (ensureThrows404) {
        let error = new Error('Session not found');
        error.status = 404;
        throw error;
      }

      return {
        session: { id: sessionID, participantAgentIDs: [ ...participantAgentIDs ], deletedAt },
      };
    },
    async appendUserMessage(sessionID, input) {
      let frame = {
        id: input.id,
        type: 'UserMessage',
        sessionID,
        interactionID: input.interactionID,
        parentID: input.parentID || null,
        authorType: 'user',
        authorID: input.userID || null,
        authorDisplayName: input.authorDisplayName || null,
        timestamp: input.timestamp,
        hidden: false,
        deleted: false,
        recipients: [],
        content: {
          text: input.content.text,
          ...input.content,
        },
      };

      if (input.targetAgentID)
        frame.targetAgentID = input.targetAgentID;

      if (input.continuation)
        frame.continuation = input.continuation;

      runtime.appended.push({ sessionID, input, frame });
      return { frame };
    },
    frameStore: { flush: async () => {} },
    clock: () => 5000,
    idGenerator: (() => {
      let index = 0;
      return () => `frame_${++index}`;
    })(),
    emitRuntimeEvent(type, payload) {
      runtime.events.push({ type, payload });
    },
  };

  return runtime;
}

function createService({ questionsStore, runtime, agentManager = null }) {
  return new QuestionAnswerService({
    questionsStore,
    frameRuntime: runtime,
    agentManager,
    logger: { warn() {}, error() {} },
  });
}

function createStore(aeordb, ids) {
  let queue = [ ...ids ];
  return new QuestionsStore({
    aeordb,
    clock: (() => {
      let now = 1000;
      return () => now++;
    })(),
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
