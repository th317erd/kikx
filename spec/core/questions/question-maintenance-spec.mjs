'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DELIVERY_RETRY_DELAYS_MS,
  QuestionMaintenanceService,
  QuestionsStore,
  applyDefaultAnswer,
  buildAnswerPromptText,
  findDueDefaults,
  findRetryableDeliveries,
  markRedelivered,
  recordDeliveryFailure,
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

test('findDueDefaults reads through the open index and reports the deadline', async () => {
  let db = createDB();
  let store = createStore(db, [ 'group_1', 'q_1' ]);

  let id = await askWithDefault(store, { timeoutSeconds: 60 });

  assert.deepEqual(await findDueDefaults(store, { now: T0 + 10 }), []);

  let due = await findDueDefaults(store, { now: T0 + 60_000 });
  assert.equal(due.length, 1);
  assert.equal(due[0].id, id);
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

test('QuestionMaintenanceService applies due defaults and delivers them', async () => {
  let db = createDB();
  let store = createStore(db, [ 'group_1', 'q_1' ]);
  let delivered = [];

  let id = await askWithDefault(store, { timeoutSeconds: 60 });

  let service = new QuestionMaintenanceService({
    questionsStore: store,
    questionAnswerService: {
      async deliverAnswer(question) {
        delivered.push(question.id);
        return { delivered: true, frameID: 'f_1' };
      },
    },
    clock: () => T0 + 60_000,
  });

  let summary = await service.runOnce();

  assert.deepEqual(summary.defaults.applied, [ id ]);
  assert.deepEqual(delivered, [ id ], 'the default was delivered to the asking agent');
});

test('QuestionMaintenanceService retries an undeliverable answer and marks it redelivered', async () => {
  let db = createDB();
  let store = createStore(db, [ 'group_1', 'q_1' ]);

  let id = await askWithDefault(store, { timeoutSeconds: 60 });
  await store.answerQuestion(id, { answer: 'Postgres', userID: 'user_1' });
  await recordDeliveryFailure(store, id, { reason: 'agent-unavailable', now: T0 });

  let attempts = 0;
  let service = new QuestionMaintenanceService({
    questionsStore: store,
    questionAnswerService: {
      async deliverAnswer() {
        attempts++;
        return { delivered: true, frameID: 'f_2' };
      },
    },
    clock: () => T0 + DELIVERY_RETRY_DELAYS_MS[0],
  });

  let summary = await service.runOnce();

  assert.equal(attempts, 1);
  assert.deepEqual(summary.retries.retried, [ id ]);
  assert.equal((await store.getQuestion(id)).status, 'answered', 'delivered answers stop retrying');
});

test('QuestionMaintenanceService extends the backoff when delivery fails again', async () => {
  let db = createDB();
  let store = createStore(db, [ 'group_1', 'q_1' ]);

  let id = await askWithDefault(store, { timeoutSeconds: 60 });
  await store.answerQuestion(id, { answer: 'Postgres', userID: 'user_1' });
  await recordDeliveryFailure(store, id, { reason: 'agent-unavailable', now: T0 });

  let now = T0 + DELIVERY_RETRY_DELAYS_MS[0];
  let service = new QuestionMaintenanceService({
    questionsStore: store,
    questionAnswerService: {
      async deliverAnswer() {
        return { delivered: false, reason: 'still-gone' };
      },
    },
    clock: () => now,
  });

  let summary = await service.runOnce();

  assert.deepEqual(summary.retries.failed, [ id ]);
  let question = await store.getQuestion(id);
  assert.equal(question.deliveryAttempts, 2, 'the attempt was counted');
  assert.equal(
    question.nextDeliveryAt,
    now + DELIVERY_RETRY_DELAYS_MS[1],
    'the next attempt is scheduled further out',
  );
});

test('QuestionMaintenanceService start/stop is safe and never keeps the process alive', async () => {
  let db = createDB();
  let store = createStore(db, [ 'group_1', 'q_1' ]);

  let service = new QuestionMaintenanceService({ questionsStore: store, intervalMs: 5_000 });

  assert.equal(service.start(), true);
  assert.equal(service.start(), false, 'starting twice is a no-op');
  assert.equal(service.stop(), true);
  assert.equal(service.stop(), false, 'stopping twice is a no-op');

  let disabled = new QuestionMaintenanceService({ questionsStore: store, intervalMs: 0 });
  assert.equal(disabled.start(), false, 'interval 0 disables the tick');
});

test('a run that is already in progress is skipped rather than overlapped', async () => {
  let db = createDB();
  let store = createStore(db, [ 'group_1', 'q_1' ]);

  let release = null;
  let gate = new Promise((resolve) => { release = resolve; });

  let service = new QuestionMaintenanceService({
    questionsStore: store,
    questionAnswerService: {
      async deliverAnswer() {
        await gate;
        return { delivered: true, frameID: 'f_3' };
      },
    },
  });

  await askWithDefault(store, { timeoutSeconds: 0 });

  let first = service.runOnce({ now: T0 + 1 });
  let second = await service.runOnce({ now: T0 + 1 });
  assert.deepEqual(second, { skipped: 'already-running' });

  release();
  await first;
});
