'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { QuestionScheduleFramePlugin } from '../../../src/core/questions/question-schedule-plugin.mjs';

/**
 * The fire-time half of the deadline scheduler.
 *
 * These tests exist because a mutation proved the gap: deleting the status check
 * in `process()` broke nothing, since every other test stops at "the frame was
 * armed" or "the frame was cancelled". Arming and cancelling are necessary but
 * not sufficient — the case the owner asked about is the one where the frame
 * fires anyway, and the only thing standing between that and a spurious agent
 * turn is the check below.
 */

function buildContext({ question, kind = 'question-deadline', scheduledDispatch = true, deliver } = {}) {
  let calls = { next: 0, done: 0, applied: [], delivered: [], patched: [], recorded: [] };

  let docs = new Map();
  let store = {
    clock: () => 5_000,
    questionPath: (id) => `/kikx/questions/${id}.json`,
    async getQuestion(id) {
      if (question === null)
        throw Object.assign(new Error('missing'), { status: 404 });
      return docs.get(id) || { ...question, id };
    },
    async withLock(_id, fn) {
      return await fn();
    },
    async putFile(path, body) {
      docs.set(path.split('/').pop().replace('.json', ''), JSON.parse(JSON.stringify(body)));
      return { path };
    },
    async writeIndexes() {},
    // `applyDefaultAnswer` writes through `store.aeordb.putFile`.
    aeordb: {
      async putFile(path, body) {
        docs.set(path.split('/').pop().replace('.json', ''), JSON.parse(JSON.stringify(body)));
        return { path };
      },
    },
  };

  let services = {
    questionsStore: store,
    questionAnswerService: deliver
      ? {
        async deliverAnswer(q, opts) {
          calls.delivered.push({ id: q.id, opts });
          return deliver(q);
        },
      }
      : null,
    clock: () => 5_000,
    logger: { warn() {}, error() {} },
  };

  let plugin = new QuestionScheduleFramePlugin({
    newFrame: {
      id: 'sched_1',
      type: 'UserMessage',
      sessionID: 'session_1',
      targetAgentID: 'agent_1',
      continuation: { kind, questionID: question?.id || 'q_1' },
    },
    commit: { scheduledDispatch },
    services,
    engine: { get: () => null, merge: () => [] },
    session: { id: 'session_1' },
  });

  return {
    calls,
    docs,
    plugin,
    run: async () => {
      await plugin.process(
        async () => { calls.next++; },
        () => { calls.done++; },
      );
    },
  };
}

test('a fired deadline for an already-answered question is dropped without waking the agent', async () => {
  // This is the edge case: the queue dispatched the frame, but the user answered
  // in the window between the cancel and the dispatch (dispatch awaits a session
  // lookup and a flush). The agent must not be woken, and nothing may be written.
  let ctx = buildContext({
    question: { id: 'q_1', status: 'answered', answer: 'Postgres', defaultAnswer: 'sqlite' },
  });

  await ctx.run();

  assert.equal(ctx.calls.next, 0, 'the chain must stop before agent routing');
  assert.equal(ctx.calls.done, 1);
  assert.deepEqual(ctx.calls.delivered, [], 'no wake for a question already answered');
});

// `applyDefaultAnswer` refuses any question that is not `open`, so for the
// answered/dismissed cases above the plugin's status check is belt-and-braces and
// a mutation removing it survives. This is the case it genuinely owns: a
// soft-deleted question is still `status: 'open'` on disk, so the store would
// happily apply the default and wake the agent for a question the user deleted.
test('a fired deadline for a soft-deleted but still-open question is dropped', async () => {
  let ctx = buildContext({
    question: {
      id: 'q_1',
      status: 'open',
      deleted: true,
      text: 'Which database?',
      defaultAnswer: 'sqlite',
      defaultDueAt: 4_000,
      askedAt: 1_000,
      agentID: 'agent_1',
      sessionID: 'session_1',
      groupID: 'group_1',
    },
    deliver: () => ({ delivered: true, frameID: 'f_1' }),
  });

  await ctx.run();

  assert.deepEqual(
    ctx.calls.delivered,
    [],
    'a deleted question must not wake the agent even though its status is still open',
  );
  assert.equal(ctx.docs.size, 0, 'and its doc must not be rewritten');
});

test('a fired deadline for a dismissed question is likewise dropped', async () => {
  let ctx = buildContext({
    question: { id: 'q_1', status: 'dismissed', defaultAnswer: 'sqlite' },
  });

  await ctx.run();

  assert.equal(ctx.calls.next, 0);
  assert.equal(ctx.calls.done, 1);
  assert.deepEqual(ctx.calls.delivered, []);
});

test('a deleted question doc does not throw or wake anyone', async () => {
  let ctx = buildContext({ question: null });

  await ctx.run();

  assert.equal(ctx.calls.next, 0);
  assert.equal(ctx.calls.done, 1);
});

test('a still-pending frame is ignored: only the queue may dispatch it', async () => {
  // Without `scheduledDispatch`, this is an ordinary commit for a frame with a
  // future `scheduledAt`. Acting on it here would fire the default EARLY — the
  // question is open and its deadline has passed relative to the injected clock,
  // so the only thing preventing an application is the dispatch guard itself.
  // The `deliver` callback is what makes that observable: a mutation removing the
  // guard produced a real delivery in a first draft of this test that omitted it,
  // so the assertion below would have compared an always-empty array.
  let ctx = buildContext({
    question: {
      id: 'q_1',
      status: 'open',
      text: 'Which database?',
      defaultAnswer: 'sqlite',
      defaultDueAt: 5_000,
      askedAt: 1_000,
      agentID: 'agent_1',
      sessionID: 'session_1',
      groupID: 'group_1',
    },
    scheduledDispatch: false,
    deliver: () => ({ delivered: true, frameID: 'f_1' }),
  });

  await ctx.run();

  assert.equal(ctx.calls.next, 0, 'the plugin still owns the frame');
  assert.equal(ctx.calls.done, 1);
  assert.deepEqual(
    ctx.calls.delivered,
    [],
    'an undispatched frame must never apply its default',
  );
  assert.equal(ctx.docs.size, 0, 'and it must not write the question doc either');
});

test('a fired deadline for an open question applies the default and delivers it', async () => {
  let ctx = buildContext({
    question: {
      id: 'q_1',
      status: 'open',
      text: 'Which database?',
      defaultAnswer: 'sqlite',
      defaultDueAt: 4_000,
      askedAt: 1_000,
      agentID: 'agent_1',
      sessionID: 'session_1',
      groupID: 'group_1',
    },
    deliver: () => ({ delivered: true, frameID: 'f_1' }),
  });

  await ctx.run();

  assert.equal(ctx.calls.delivered.length, 1, 'the default is delivered exactly once');
  assert.equal(ctx.calls.delivered[0].opts.authorDisplayName, 'Default answer');
  assert.equal(ctx.calls.delivered[0].opts.flushRouter, false, 'a scheduled delivery must not wait on the routing pass that invoked it');
  assert.equal(ctx.calls.next, 0, 'the plugin owns this frame; agent routing must not also run');
});

test('an unrelated frame kind falls through to the rest of the chain', async () => {
  let ctx = buildContext({
    question: { id: 'q_1', status: 'open' },
    kind: 'exec-wake-on-completion',
  });

  await ctx.run();

  assert.equal(ctx.calls.next, 1, 'other continuations must not be swallowed');
  assert.equal(ctx.calls.done, 0);
});
