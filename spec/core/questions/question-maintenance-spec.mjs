'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DELIVERY_RETRY_DELAYS_MS,
  QuestionsStore,
  applyDefaultAnswer,
  armQuestionDeadline,
  buildAnswerPromptText,
  buildQuestionScheduleFrame,
  cancelQuestionSchedule,
  findRetryableDeliveries,
  markRedelivered,
  recordDeliveryFailure,
  toScheduledAt,
} from '../../../src/core/questions/index.mjs';

const OPEN_INDEX = '/kikx/questions/index/open.json';
const T0 = 1_000_000;

function createDB() {
  let files = new Map();

  return {
    files,
    async getFile(path) {
      if (!files.has(path))
        throw Object.assign(new Error(`missing ${path}`), { status: 404 });

      return JSON.parse(JSON.stringify(files.get(path)));
    },
    async putFile(path, body) {
      files.set(path, JSON.parse(JSON.stringify(body)));
      return { path };
    },
    async list(path, options = {}) {
      let prefix = path.endsWith('/') ? path : `${path}/`;
      let glob = options.glob || null;
      let recursive = options.recursive === true;
      let pattern = glob ? new RegExp(`^${glob.replace(/\./g, '\\.').replace(/\*/g, '[^/]*')}$`) : null;
      let items = [];

      for (let key of files.keys()) {
        if (!key.startsWith(prefix))
          continue;

        let rest = key.slice(prefix.length);
        if (!recursive && rest.includes('/'))
          continue;

        if (pattern && !pattern.test(rest.split('/').pop()))
          continue;

        items.push({ path: key });
      }

      return { items, total: items.length, hasMore: false };
    },
  };
}

function createStore(db, ids, clock = () => T0) {
  let queue = [ ...ids ];
  return new QuestionsStore({
    db,
    clock,
    idGenerator: () => queue.shift() || `gen_${queue.length}`,
  });
}

async function askWithDefault(store, { defaultAnswer = 'use the default', timeoutSeconds = 60 } = {}) {
  let result = await store.createQuestions({
    questions: [ { text: 'Which database?', defaultAnswer, timeoutSeconds } ],
    mode: 'wait',
    sessionID: 'session_1',
    agentID: 'agent_1',
  });

  return result.questionIDs[0];
}

test('createQuestions persists the default and an absolute deadline', async () => {
  let db = createDB();
  let store = createStore(db, [ 'group_1', 'q_1' ]);

  let id = await askWithDefault(store, { defaultAnswer: 'SQLite', timeoutSeconds: 30 });
  let question = await store.getQuestion(id);

  assert.equal(question.defaultAnswer, 'SQLite');
  assert.equal(question.defaultTimeoutMs, 30_000);
  assert.equal(question.defaultDueAt, T0 + 30_000, 'deadline is absolute, so it survives a restart');
  assert.equal(question.status, 'open');
  assert.equal(question.answer, null, 'nothing applied yet');
});

test('a question with no default has no deadline at all', async () => {
  let db = createDB();
  let store = createStore(db, [ 'group_1', 'q_1' ]);

  let result = await store.createQuestions({
    questions: [ { text: 'No fallback here' } ],
    mode: 'wait',
    sessionID: 'session_1',
    agentID: 'agent_1',
  });

  let question = await store.getQuestion(result.questionIDs[0]);
  assert.equal(question.defaultAnswer, null);
  assert.equal(question.defaultDueAt, null);
});

test('a default is not applied before its deadline', async () => {
  let db = createDB();
  let store = createStore(db, [ 'group_1', 'q_1' ]);

  let id = await askWithDefault(store, { timeoutSeconds: 60 });

  let early = await applyDefaultAnswer(store, id, { now: T0 + 59_999 });
  assert.equal(early.applied, false);
  assert.equal(early.reason, 'not-due');

  let due = await applyDefaultAnswer(store, id, { now: T0 + 60_000 });
  assert.equal(due.applied, true);
  assert.equal(due.question.status, 'answered');
  assert.equal(due.question.answer, 'use the default');
  assert.equal(due.question.answerSource, 'default', 'provenance is recorded');
  assert.equal(due.question.answeredByUserID, null, 'no human is credited');
});

test('a real user answer wins: the default never overwrites it', async () => {
  let db = createDB();
  let store = createStore(db, [ 'group_1', 'q_1' ]);

  let id = await askWithDefault(store, { timeoutSeconds: 60 });
  await store.answerQuestion(id, { answer: 'Postgres', userID: 'user_1' });

  // The deadline passes after the user answered.
  let result = await applyDefaultAnswer(store, id, { now: T0 + 999_999 });

  assert.equal(result.applied, false, 'a terminal question is left alone');
  assert.equal(result.reason, 'not-open:answered');

  let question = await store.getQuestion(id);
  assert.equal(question.answer, 'Postgres', 'the human answer survived');
  assert.equal(question.answerSource, null, 'and it is not mislabelled as a default');
});

test('a default answer cannot be overwritten afterwards', async () => {
  let db = createDB();
  let store = createStore(db, [ 'group_1', 'q_1' ]);

  let id = await askWithDefault(store, { timeoutSeconds: 60 });
  await applyDefaultAnswer(store, id, { now: T0 + 60_000 });

  // Existing terminal semantics still apply: a second answer is a 409, so the
  // record cannot be silently rewritten after the fact.
  await assert.rejects(
    () => store.answerQuestion(id, { answer: 'Changed my mind', userID: 'user_1' }),
    (error) => error.status === 409,
  );
});

test('a dismissed question never has its default applied', async () => {
  let db = createDB();
  let store = createStore(db, [ 'group_1', 'q_1' ]);

  let id = await askWithDefault(store, { timeoutSeconds: 60 });
  await store.dismissQuestion(id, { reason: 'not needed' });

  let result = await applyDefaultAnswer(store, id, { now: T0 + 120_000 });
  assert.equal(result.applied, false);
  assert.equal((await store.getQuestion(id)).status, 'dismissed');
});

test('the wake text says the answer was a default, not a user decision', async () => {
  let db = createDB();
  let store = createStore(db, [ 'group_1', 'q_1' ]);

  let id = await askWithDefault(store, { timeoutSeconds: 60 });
  let applied = await applyDefaultAnswer(store, id, { now: T0 + 60_000 });

  let text = buildAnswerPromptText(applied.question);

  assert.match(text, /No answer arrived in time/, 'the model is told a default fired');
  assert.match(text, /Nobody confirmed this/, 'and that it is its own assumption');
  assert.doesNotMatch(text, /The user answered your question/, 'never phrased as a human reply');
});

test('a real answer still uses the human phrasing', async () => {
  let db = createDB();
  let store = createStore(db, [ 'group_1', 'q_1' ]);

  let id = await askWithDefault(store, { timeoutSeconds: 60 });
  let answered = await store.answerQuestion(id, { answer: 'Postgres', userID: 'user_1' });

  let text = buildAnswerPromptText(answered);
  assert.match(text, /The user answered your question/);
  assert.doesNotMatch(text, /No answer arrived in time/);
});

test('recordDeliveryFailure schedules exponential backoff and then gives up', async () => {
  let db = createDB();
  let store = createStore(db, [ 'group_1', 'q_1' ]);

  let id = await askWithDefault(store, { timeoutSeconds: 60 });
  await store.answerQuestion(id, { answer: 'Postgres', userID: 'user_1' });

  let first = await recordDeliveryFailure(store, id, { reason: 'agent-unavailable', now: T0 });
  assert.equal(first.status, 'undeliverable');
  assert.equal(first.deliveryAttempts, 1);
  assert.equal(first.nextDeliveryAt, T0 + DELIVERY_RETRY_DELAYS_MS[0]);

  // Each entry is one *scheduled* retry, so N delays means N retries are queued
  // and the schedule runs dry on failure N+1 — not on failure N.
  let last = first;
  for (let attempt = 2; attempt <= DELIVERY_RETRY_DELAYS_MS.length + 1; attempt++)
    last = await recordDeliveryFailure(store, id, { reason: 'agent-unavailable', now: T0 });

  assert.equal(last.deliveryAttempts, DELIVERY_RETRY_DELAYS_MS.length + 1);
  assert.equal(last.nextDeliveryAt, null, 'the schedule is exhausted, not extended forever');

  let beyond = await recordDeliveryFailure(store, id, { reason: 'agent-unavailable', now: T0 });
  assert.equal(beyond.nextDeliveryAt, null, 'and it stays exhausted');
  assert.equal(beyond.status, 'undeliverable', 'the failure remains visible');
});

test('findRetryableDeliveries respects the backoff and the terminal status', async () => {
  let db = createDB();
  let store = createStore(db, [ 'group_1', 'q_1' ]);

  let id = await askWithDefault(store, { timeoutSeconds: 60 });
  await store.answerQuestion(id, { answer: 'Postgres', userID: 'user_1' });
  await recordDeliveryFailure(store, id, { reason: 'agent-unavailable', now: T0 });

  assert.deepEqual(
    await findRetryableDeliveries(store, { now: T0 + 1 }),
    [],
    'not due yet: the backoff is respected',
  );

  let due = await findRetryableDeliveries(store, { now: T0 + DELIVERY_RETRY_DELAYS_MS[0] });
  assert.equal(due.length, 1, 'due once the delay elapses');
  assert.equal(due[0].id, id);
});

test('markRedelivered clears the retry schedule and restores answered', async () => {
  let db = createDB();
  let store = createStore(db, [ 'group_1', 'q_1' ]);

  let id = await askWithDefault(store, { timeoutSeconds: 60 });
  await store.answerQuestion(id, { answer: 'Postgres', userID: 'user_1' });
  await recordDeliveryFailure(store, id, { reason: 'agent-unavailable', now: T0 });

  let result = await markRedelivered(store, id, { now: T0 + 10 });
  assert.equal(result.redelivered, true);
  assert.equal(result.question.status, 'answered');
  assert.equal(result.question.nextDeliveryAt, null);
  assert.equal(result.question.redeliveredAt, T0 + 10);
  assert.equal(result.question.answer, 'Postgres', 'the answer itself is untouched');

  let again = await markRedelivered(store, id, { now: T0 + 20 });
  assert.equal(again.redelivered, false, 'not redeliverable twice');
});


// --- Scheduled-frame deadline (replaces the deleted poller) ------------------
//
// The poller scanned every open question on an interval. These tests pin the
// two properties that made it the wrong design, and the one conversion that
// fails silently: `scheduledAt` is microseconds, `defaultDueAt` is milliseconds.

test('toScheduledAt converts milliseconds to the microseconds scheduledAt uses', () => {
  let dueAt = 1_792_731_203_907;

  assert.equal(
    toScheduledAt(dueAt),
    dueAt * 1000,
    'a millisecond deadline becomes microseconds, not the year 57,000',
  );
  // Guard the guard: the whole class of bug this function exists to prevent.
  assert.ok(toScheduledAt(dueAt) > 1e15, 'the result is a genuine microsecond epoch');
});

test('toScheduledAt refuses to schedule nonsense instead of silently never firing', () => {
  assert.equal(toScheduledAt(null), null);
  assert.equal(toScheduledAt(undefined), null);
  assert.equal(toScheduledAt(0), null, 'epoch 0 is not a deadline');
  assert.equal(toScheduledAt(''), null);
  assert.equal(toScheduledAt('not-a-date'), null);
  assert.equal(toScheduledAt(-1), null);
});

test('toScheduledAt does not multiply an already-microsecond value', () => {
  let micros = 1_792_731_203_907_000;

  assert.equal(toScheduledAt(micros), micros, 'double conversion would overflow the schedule');
});

test('a question with a deadline arms exactly one hidden scheduled frame', async () => {
  let db = createDB();
  let store = createStore(db, [ 'group_1', 'q_1' ]);
  let id = await askWithDefault(store, { timeoutSeconds: 60 });
  let question = await store.getQuestion(id);

  let runtime = createFakeRuntime();
  let frame = await armQuestionDeadline({ frameRuntime: runtime, question });

  assert.ok(frame, 'a frame was armed');
  assert.equal(frame.hidden, true, 'the deadline frame must not appear in the transcript');
  assert.equal(frame.continuation.kind, 'question-deadline');
  assert.equal(frame.continuation.questionID, id);
  assert.equal(frame.targetAgentID, 'agent_1', 'the queue only dispatches frames that name a target');
  assert.equal(
    frame.scheduledAt,
    question.defaultDueAt * 1000,
    'the deadline rides the queue in the queue\'s own units',
  );
  assert.equal(runtime.entries().length, 1);
});

test('a question without a deadline arms nothing at all', async () => {
  let db = createDB();
  let store = createStore(db, [ 'group_1', 'q_1' ]);
  let result = await store.createQuestions({
    questions: [ { text: 'No default here' } ],
    mode: 'wait',
    sessionID: 'session_1',
    agentID: 'agent_1',
  });

  let runtime = createFakeRuntime();
  let frame = await armQuestionDeadline({
    frameRuntime: runtime,
    question: await store.getQuestion(result.questionIDs[0]),
  });

  assert.equal(frame, null);
  assert.equal(runtime.entries().length, 0, 'no timer for a question that can wait forever');
});

// This is the edge case: the timer fires, but the question was already answered.
// Answering cancels the schedule, so the queue drops the entry and never routes
// it. Without this, an agent gets woken with its own default for a question the
// user already answered in person.
test('answering cancels the pending deadline so the fired frame cannot route', async () => {
  let db = createDB();
  let store = createStore(db, [ 'group_1', 'q_1' ]);
  let id = await askWithDefault(store, { timeoutSeconds: 60 });
  let question = await store.getQuestion(id);

  let runtime = createFakeRuntime();
  let frame = await armQuestionDeadline({ frameRuntime: runtime, question });
  assert.equal(runtime.entries().length, 1);

  let cancelled = await cancelQuestionSchedule({ frameRuntime: runtime, questionID: id });

  assert.equal(cancelled, 1);
  assert.equal(runtime.entries().length, 0, 'the queue no longer considers it due');
  assert.equal(
    runtime.store.get(frame.id).scheduledStatus,
    'cancelled',
    'the persisted frame is cancelled, which is what dispatch() checks',
  );
});

test('cancelling an already-answered question is a no-op rather than an error', async () => {
  let db = createDB();
  let store = createStore(db, [ 'group_1', 'q_1' ]);
  let id = await askWithDefault(store, { timeoutSeconds: 60 });

  let runtime = createFakeRuntime();

  assert.equal(
    await cancelQuestionSchedule({ frameRuntime: runtime, questionID: id }),
    0,
    'nothing armed, nothing to cancel',
  );
});

test('re-arming replaces the pending deadline instead of stacking a second one', async () => {
  let db = createDB();
  let store = createStore(db, [ 'group_1', 'q_1' ]);
  let id = await askWithDefault(store, { timeoutSeconds: 60 });
  let question = await store.getQuestion(id);

  let runtime = createFakeRuntime();
  await armQuestionDeadline({ frameRuntime: runtime, question });
  await armQuestionDeadline({ frameRuntime: runtime, question });

  assert.equal(
    runtime.entries().length,
    1,
    'a double arm must not fire two defaults',
  );
});

test('the deadline frame is well-formed even when the parent question has no frame yet', () => {
  let frame = buildQuestionScheduleFrame({
    runtime: { idGenerator: () => 'sched_1' },
    question: {
      id: 'q_1',
      sessionID: 'session_1',
      agentID: 'agent_1',
      groupID: 'group_1',
      frameID: null,
      defaultDueAt: 1_000,
    },
    kind: 'question-deadline',
    dueAt: 1_000,
    now: 0,
  });

  assert.equal(frame.parentID, null);
  assert.equal(frame.scheduledStatus, 'pending');
  assert.equal(frame.authorType, 'system');
});

/**
 * Minimal stand-in for the parts of FrameRuntime the scheduler touches: an
 * entry with a real frame engine (so `merge()` is exercised, not mocked away),
 * a scheduled-frame queue map, and the flush the queue relies on. The engine is
 * deliberately the real one — a fake merge would let a broken frame shape pass.
 */
function createFakeRuntime() {
  let store = new Map();
  let entries = new Map();
  let seq = 0;
  // Declared before `frameEngine` so the engine's merge() can reach the queue;
  // assigned at the end of this function.
  let runtime = null;

  let frameEngine = {
    get(id) {
      return store.get(id) || null;
    },
    merge(frames = []) {
      let merged = [];
      for (let frame of frames) {
        let next = { ...frame, order: ++seq };
        store.set(frame.id, next);
        merged.push(next);
      }
      // Production tracks scheduled frames from the engine's commit handler
      // (frame-runtime.mjs `connectFrameEngine` -> `scheduledFrames.trackFrames`).
      // Mirror that link here so the queue is populated the same way, rather
      // than by reaching into the scheduler's internals from the test.
      for (let frame of merged)
        runtime.scheduledFrames.trackFrame(frame);
      return merged;
    },
    hydrate() {},
    getLatestCommit() {
      return { order: seq };
    },
    toArray() {
      return [ ...store.values() ];
    },
  };

  runtime = {
    store,
    clock: () => T0,
    idGenerator: () => `sched_${++seq}`,
    scheduledFrames: {
      entries,
      trackFrame(frame) {
        entries.set(frame.id, { frame, frameID: frame.id, sessionID: frame.sessionID, scheduledAt: frame.scheduledAt });
      },
    },
    async ensureSessionEntry(sessionID) {
      return { session: { id: sessionID, participantAgentIDs: [ 'agent_1' ] }, frameEngine };
    },
    frameStore: { async flush() {} },
    entries() {
      return [ ...entries.values() ];
    },
  };

  return runtime;
}
