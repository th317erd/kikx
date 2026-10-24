'use strict';

// End-to-end coverage for question deadlines on the generic scheduled-frame
// queue. The sibling `question-schedule-plugin-spec.mjs` calls the plugin with a
// hand-built context; that proves the plugin's internal branches but not that
// the wiring around it is real. Those specs could pass with the queue never
// discovering the armed frame, or with `scheduledDispatch` never arriving.
//
// This spec builds the actual FrameRuntime (and therefore the actual
// ScheduledFrameQueue), a real FrameRouter with the question-schedule plugin
// registered, and a real QuestionsStore over an in-memory client. It asserts the
// three seams that only exist in the assembled system:
//
//   1. arming a deadline is registered by the queue at all
//      (FrameRuntime.connectFrameEngine -> trackFrames)
//   2. draining the queue applies the default and writes the answer
//   3. answering first leaves the frame cancelled with the default never applied
//
// CLOCKS — the reason this spec exists at all. Two clocks run here and they do
// not share a unit: `QuestionsStore` works in milliseconds, `FrameRuntime` in
// microseconds (defaultUnixMicros). `routerServices()` hands the runtime clock to
// the plugin as `services.clock`, so a plugin that derives one `now` and writes it
// to the question doc stamps microsecond values into `updatedAt`. A hand-built
// context with a single fake clock cannot see that, because there is only one
// number. Test 2 below pins it: the stored `updatedAt` must be plausible in
// milliseconds.

import assert from 'node:assert/strict';
import test from 'node:test';

import { FrameRouter } from '../../../src/core/routing/frame-router.mjs';
import { FrameRuntime } from '../../../src/core/runtime/frame-runtime.mjs';
import { QuestionsStore } from '../../../src/core/questions/questions-store.mjs';
import { QuestionAnswerService } from '../../../src/core/questions/question-wake.mjs';
import {
  armQuestionDeadline,
  cancelQuestionSchedule,
} from '../../../src/core/questions/question-deadline-schedule.mjs';
import { registerQuestionScheduleRouting } from '../../../src/core/questions/question-schedule-plugin.mjs';

const SESSION_ID = 'ses_1';
const AGENT_ID = 'agent_1';

// A real millisecond clock, offset from the runtime's microsecond clock. The
// store and the runtime must not be given the same number: that is precisely the
// confusion under test.
function createClocks() {
  let millis = 1_792_700_000_000;
  let micros = millis * 1000;
  return {
    millis: () => millis,
    micros: () => micros,
    advance(ms) {
      millis += ms;
      micros += ms * 1000;
    },
  };
}

function quietLogger() {
  return { info() {}, warn() {}, error() {}, debug() {} };
}

// Minimal AeorDB-shaped client: enough for FrameStore (sessions, frames) and for
// QuestionsStore (putFile/getFile/listDirectory). No conditional writes, same as
// the real driver — which is why QuestionsStore serialises with its own locks.
function createClient() {
  let files = new Map();

  return {
    files,
    async putFile(path, body) {
      files.set(path, JSON.parse(JSON.stringify(body)));
      return { path };
    },
    async getFile(path) {
      return files.has(path) ? JSON.parse(JSON.stringify(files.get(path))) : null;
    },
    async deleteFile(path) {
      files.delete(path);
      return { path };
    },
    async listDirectory(path, options = {}) {
      let prefix = `${String(path).replace(/\/+$/, '')}/`;
      let items = [];

      for (let filePath of files.keys()) {
        if (!filePath.startsWith(prefix))
          continue;

        // The frame store lists `**/frames/*.json`; the question store lists its
        // own root. Honour the glob loosely rather than pretending to implement
        // matching the harness does not need.
        if (options.glob === '**/frames/*.json' && !/^\/kikx\/sessions\/[^/]+\/frames\/[^/]+\.json$/.test(filePath))
          continue;

        if (options.glob === '*/session.json' && !/^\/kikx\/sessions\/[^/]+\/session\.json$/.test(filePath))
          continue;

        items.push({ path: filePath });
      }

      return { items };
    },
  };
}

/**
 * Build the assembled system: real store, real runtime, real router, real plugin.
 */
async function createHarness() {
  let clocks = createClocks();
  let client = createClient();

  // Questions get their own ids from the store, exactly as in production. Tests
  // read the id off the created question rather than assuming one.
  let questionSeq = 0;
  let questionsStore = new QuestionsStore({
    db: client,
    clock: clocks.millis,
    idGenerator: () => `q_${++questionSeq}`,
  });

  let router = new FrameRouter({ logger: quietLogger() });
  registerQuestionScheduleRouting(router);

  // SEAM 0, and the one that made the first draft of this spec fail: the plugin
  // reaches the question store through `context.services`, which comes from
  // `FrameRuntime.routerServices()`. A runtime built without `services` yields a
  // plugin with no store, which correctly does nothing — so the queue would fire
  // and silently no-op in the harness while working in production. Wiring it here
  // is what makes the rest of this file measure the real path.
  let runtime = new FrameRuntime({
    aeordb: client,
    frameRouter: router,
    services: { questionsStore, logger: quietLogger() },
    clock: clocks.micros,
    idGenerator: (() => {
      let index = 0;
      return () => `id_${++index}`;
    })(),
    logger: quietLogger(),
  });

  let session = await runtime.createSession({ id: SESSION_ID, title: 'Question deadlines' });

  return { clocks, client, questionsStore, router, runtime, session };
}

/** Ask a question through the store, exactly as ask-user does. */
async function askQuestion(harness, { timeoutMs = 30_000, defaultAnswer = 'sqlite' } = {}) {
  let { questionsStore } = harness;

  // `createQuestions` is the production entry point: it normalises the batch,
  // computes the absolute `defaultDueAt` from the store's millisecond clock, and
  // writes the open index. Hand-writing a doc would bypass all three.
  let created = await questionsStore.createQuestions({
    sessionID: SESSION_ID,
    agentID: AGENT_ID,
    questions: [ {
      text: 'Which database should I provision?',
      defaultAnswer,
      timeoutMs,
    } ],
  });

  return created.questions[0];
}

test('arming a deadline registers the frame with the real queue', async () => {
  let harness = await createHarness();
  let question = await askQuestion(harness);

  let armed = await armQuestionDeadline({
    frameRuntime: harness.runtime,
    question,
    now: harness.clocks.micros(),
  });

  assert.ok(armed?.id, 'arming must return the merged frame');

  // SEAM 1: the runtime's commit handler must have handed the frame to the
  // queue. If connectFrameEngine stopped calling trackFrames, this is empty and
  // no deadline would ever fire in production.
  assert.equal(
    harness.runtime.scheduledFrames.entries.has(armed.id),
    true,
    'the armed deadline must be tracked by ScheduledFrameQueue',
  );

  let entry = harness.runtime.scheduledFrames.entries.get(armed.id);
  assert.equal(entry.sessionID, SESSION_ID);
  // The queue stores the normalised (microsecond) instant. A millisecond value
  // here means toScheduledAt() was bypassed.
  assert.equal(
    entry.scheduledAt,
    question.defaultDueAt * 1000,
    'the tracked instant must be the deadline converted ms -> us',
  );
});

test('draining the queue applies the default and stamps millisecond timestamps', async () => {
  let harness = await createHarness();
  let question = await askQuestion(harness, { timeoutMs: 30_000 });

  await armQuestionDeadline({
    frameRuntime: harness.runtime,
    question,
    now: harness.clocks.micros(),
  });

  // Not due yet: draining must do nothing at all.
  let early = await harness.runtime.processScheduledFrames();
  assert.deepEqual(early, [], 'a deadline that is not due must not fire');
  assert.equal(
    (await harness.questionsStore.getQuestion(question.id)).status,
    'open',
    'the question must still be open before its deadline',
  );

  harness.clocks.advance(30_000);

  let fired = await harness.runtime.processScheduledFrames();
  assert.equal(fired.length, 1, 'the due deadline must fire exactly once');

  let stored = await harness.questionsStore.getQuestion(question.id);
  assert.equal(stored.status, 'answered', 'the default must resolve the question');
  assert.equal(stored.answer, 'sqlite');
  assert.equal(stored.answerSource, 'default');

  // SEAM 2 (the clock units). A microsecond value written here is ~1000x in the
  // future; a millisecond value is "now". Assert against the store's own clock
  // rather than a literal so the test states the contract, not a magic number.
  let storeNow = harness.clocks.millis();
  assert.ok(
    Math.abs(stored.updatedAt - storeNow) < 1_000,
    `updatedAt must be milliseconds (got ${stored.updatedAt}, expected ~${storeNow})`,
  );
  // NB: `answeredByDefaultAt` is written by applyDefaultAnswer but has no key in
  // `normalizeQuestionDoc`, so it is stripped on every read and cannot be asserted
  // here. `answerSource` is the durable evidence that a default was applied.
  assert.equal(stored.answerSource, 'default');

  // The frame is retired, so a second drain cannot double-apply.
  assert.equal(
    harness.runtime.scheduledFrames.entries.has(
      [ ...harness.runtime.scheduledFrames.entries.values() ][0]?.frameID || 'gone',
    ),
    false,
  );
  let again = await harness.runtime.processScheduledFrames();
  assert.deepEqual(again, [], 'a fired deadline must not fire twice');
});

test('cancelling on answer leaves the frame cancelled and the default unapplied', async () => {
  let harness = await createHarness();
  let question = await askQuestion(harness, { timeoutMs: 30_000 });

  await armQuestionDeadline({
    frameRuntime: harness.runtime,
    question,
    now: harness.clocks.micros(),
  });

  // The user answers before the deadline, exactly as the answer route does.
  await harness.questionsStore.answerQuestion(question.id, {
    answer: 'postgres',
    userID: 'usr_1',
  });

  let cancelled = await cancelQuestionSchedule({
    frameRuntime: harness.runtime,
    questionID: question.id,
    now: harness.clocks.millis(),
  });
  assert.equal(cancelled, 1, 'the pending deadline must be cancelled');

  harness.clocks.advance(60_000);

  let fired = await harness.runtime.processScheduledFrames();
  assert.deepEqual(fired, [], 'a cancelled deadline must not fire');

  let stored = await harness.questionsStore.getQuestion(question.id);
  assert.equal(stored.answer, 'postgres', 'the real answer must survive');
  assert.notEqual(stored.answerSource, 'default', 'no default application may be recorded');
  assert.notEqual(stored.answer, 'sqlite', 'the default must never overwrite a user answer');
});

test('an already-answered question whose frame still fires is dropped by the plugin', async () => {
  let harness = await createHarness();
  let question = await askQuestion(harness, { timeoutMs: 30_000 });

  await armQuestionDeadline({
    frameRuntime: harness.runtime,
    question,
    now: harness.clocks.micros(),
  });

  // Simulates the race the plugin exists for: the answer lands AFTER the queue
  // selected the due entry and passed the cancel window, so the cancel never saw
  // a pending frame to act on.
  await harness.questionsStore.answerQuestion(question.id, {
    answer: 'postgres',
    userID: 'usr_1',
  });

  harness.clocks.advance(30_000);

  let fired = await harness.runtime.processScheduledFrames();
  // The queue still dispatches and retires the frame; what must not happen is
  // the default being applied or the agent being woken.
  assert.equal(fired.length, 1, 'the due frame is still dispatched and retired');

  let stored = await harness.questionsStore.getQuestion(question.id);
  assert.equal(stored.answer, 'postgres', 'the fire-time check must not overwrite the user answer');
  assert.notEqual(stored.answerSource, 'default', 'no default application may be recorded');
});

test('a soft-deleted but still-open question never receives its default', async () => {
  let harness = await createHarness();
  let question = await askQuestion(harness, { timeoutMs: 30_111 });

  await armQuestionDeadline({
    frameRuntime: harness.runtime,
    question,
    now: harness.clocks.micros(),
  });

  // Soft delete keeps `status: 'open'`, so `applyDefaultAnswer` would happily
  // resolve it. Only the plugin's `deleted` check stands in the way.
  let doc = await harness.questionsStore.getQuestion(question.id);
  await harness.questionsStore.aeordb.putFile(
    harness.questionsStore.questionPath(question.id),
    { ...doc, deleted: true },
  );

  harness.clocks.advance(30_111);
  await harness.runtime.processScheduledFrames();

  let stored = await harness.questionsStore.getQuestion(question.id);
  assert.equal(stored.status, 'open', 'a deleted question must stay unresolved');
  assert.equal(stored.answer ?? null, null, 'no default may be written to a deleted question');
});
