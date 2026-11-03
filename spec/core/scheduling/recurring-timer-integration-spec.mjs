'use strict';

// End-to-end coverage for recurring timers on the generic scheduled-frame
// queue, mirroring spec/core/questions/question-deadline-integration-spec.mjs.
// The unit spec pins the pure logic; this file asserts the assembled seams
// that only exist in the real system:
//
//   1. arming a timer is discovered by the real ScheduledFrameQueue
//      (FrameRuntime commit -> trackFrames) with a MICROSECOND scheduledAt
//   2. draining the queue fires the due occurrence exactly once and retires it
//   3. the plugin RE-ARMS the next occurrence (same timerID, one pending frame,
//      occurrence strictly in the future, firedCount incremented)
//   4. the fired frame CONTINUES the router chain — a probe registered after
//      the recurring-timer plugin sees it, which is the seam agent routing
//      sits behind: the reminder prompt (content.text) must reach routing as
//      the wake message
//   5. cancelling first leaves the frame cancelled and nothing re-arms
//   6. a limit-bounded timer does NOT re-arm past its limit (natural end)
//
// The probe plugin stands in for AgentRouteFramePlugin: wiring the real agent
// stack needs agentManager/provider services this harness has no business
// faking. What matters is chain continuation, and the probe measures exactly
// that — with a negative control (plugin reverted) the probe must go silent.

import assert from 'node:assert/strict';
import test from 'node:test';

import { FrameRouter } from '../../../src/core/routing/frame-router.mjs';
import { FrameRuntime } from '../../../src/core/runtime/frame-runtime.mjs';
import { BaseFramePlugin } from '../../../src/core/routing/index.mjs';
import {
  armRecurringTimer,
  cancelRecurringTimer,
} from '../../../src/core/scheduling/recurring-timer-schedule.mjs';
import { normalizeRecurringRule } from '../../../src/core/scheduling/recurring-rule.mjs';
import { registerRecurringTimerRouting } from '../../../src/core/scheduling/recurring-timer-frame-plugin.mjs';

const SESSION_ID = 'ses_1';
const AGENT_ID = 'agent_1';
const TIMER_ID = 'tmr_probe';

function createClocks() {
  // Start well inside a fixed interval so tests can advance deterministically.
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

/** A probe registered AFTER the recurring-timer plugin on the same selector. */
class RoutingProbePlugin extends BaseFramePlugin {
  static pluginID = 'probe:routing';
  static seen = [];

  async process(next, done) {
    RoutingProbePlugin.seen.push({
      frame: this.context.newFrame,
      scheduledDispatch: this.context.commit?.scheduledDispatch === true,
    });
    await next(this.context);
  }
}

async function createHarness() {
  let clocks = createClocks();
  let client = createClient();

  let router = new FrameRouter({ logger: quietLogger() });
  registerRecurringTimerRouting(router);
  registerRoutingProbe(router);

  let runtime = new FrameRuntime({
    aeordb: client,
    frameRouter: router,
    services: { logger: quietLogger() },
    clock: clocks.micros,
    idGenerator: (() => {
      let index = 0;
      return () => `id_${++index}`;
    })(),
    logger: quietLogger(),
  });

  let session = await runtime.createSession({ id: SESSION_ID, title: 'Recurring timers' });
  RoutingProbePlugin.seen = [];

  return { clocks, client, router, runtime, session };
}

function registerRoutingProbe(router) {
  router.registerSelector('Type:UserMessage', RoutingProbePlugin, RoutingProbePlugin.pluginID);
}

function fixedIntervalRule(harness, { everyMs = 60_000, n = 1, unit = 'minute' } = {}) {
  return normalizeRecurringRule({
    type: 'every',
    n,
    unit,
    anchorAt: harness.clocks.millis(),
  });
}

async function armTimer(harness, { occurrenceInMs = 60_000, rule = null, limit = null } = {}) {
  return await armRecurringTimer({
    frameRuntime: harness.runtime,
    sessionID: SESSION_ID,
    targetAgentID: AGENT_ID,
    spec: {
      timerID: TIMER_ID,
      prompt: 'Check the build status',
      rule: rule || fixedIntervalRule(harness),
      timezone: 'UTC',
      endAt: null,
      limit,
      firedCount: 0,
      occurrence: harness.clocks.millis() + occurrenceInMs,
    },
    now: harness.clocks.micros(),
  });
}

function pendingEntries(harness) {
  return [ ...harness.runtime.scheduledFrames.entries.values() ];
}

test('arming registers with the real queue at microsecond precision', async () => {
  let harness = await createHarness();
  let armed = await armTimer(harness, { occurrenceInMs: 60_000 });

  assert.ok(armed?.id, 'arming must return the merged frame');

  // SEAM 1: the runtime's commit handler must have handed the frame to the
  // queue. If trackFrames stopped being called, nothing would ever fire in
  // production while every pure-function test stayed green.
  assert.equal(
    harness.runtime.scheduledFrames.entries.has(armed.id),
    true,
    'the armed timer must be tracked by ScheduledFrameQueue',
  );

  let entry = harness.runtime.scheduledFrames.entries.get(armed.id);
  assert.equal(entry.sessionID, SESSION_ID);
  let occurrenceMs = harness.clocks.millis() + 60_000;
  assert.equal(
    entry.scheduledAt,
    occurrenceMs * 1000,
    'the tracked instant must be the occurrence converted ms -> µs',
  );
  assert.ok(entry.scheduledAt >= 1e14, 'microsecond scale, not milliseconds');
});

test('a due timer fires once, re-arms the next occurrence, and continues the chain with the prompt', async () => {
  let harness = await createHarness();
  let armed = await armTimer(harness, { occurrenceInMs: 60_000 });

  // Not due: draining must do nothing at all.
  let early = await harness.runtime.processScheduledFrames();
  assert.deepEqual(early, [], 'a future occurrence must not fire');
  assert.equal(RoutingProbePlugin.seen.length, 0, 'nothing may reach routing before the due time');

  harness.clocks.advance(61_000);

  let fired = await harness.runtime.processScheduledFrames();
  assert.equal(fired.length, 1, 'the due occurrence must fire exactly once');

  // SEAM 4: the fired frame continued past the recurring-timer plugin to the
  // probe — this is what agent routing sits behind. The wake message must be
  // the reminder prompt.
  let probeHit = RoutingProbePlugin.seen.find((hit) => hit.frame?.id === armed.id);
  assert.ok(probeHit, 'the fired frame must continue the router chain (agent routing seam)');
  assert.equal(probeHit.scheduledDispatch, true, 'continuation carries scheduledDispatch, like every queue dispatch');
  assert.equal(probeHit.frame.content.text, 'Check the build status', 'the wake message is the reminder prompt');

  // SEAM 3: the plugin re-armed the next occurrence BEFORE routing: exactly
  // one pending frame for this timer, occurrence strictly in the future.
  let pending = pendingEntries(harness).filter((entry) => entry.frame?.continuation?.timerID === TIMER_ID);
  assert.equal(pending.length, 1, 'exactly ONE pending occurrence must be re-armed');
  let rearm = pending[0];
  assert.notEqual(rearm.frameID, armed.id, 'the re-arm is a new frame, not the fired one');
  assert.ok(
    rearm.scheduledAt > harness.clocks.micros(),
    'the re-armed occurrence must be strictly in the future (no catch-up loop)',
  );
  assert.equal(rearm.frame.continuation.firedCount, 1, 'firedCount incremented');
  assert.equal(rearm.frame.content.text, 'Check the build status', 'the prompt carries over');

  // The fired frame itself is retired: a second drain cannot re-fire it.
  let again = await harness.runtime.processScheduledFrames();
  assert.deepEqual(again, [], 'a fired occurrence must not fire twice');
  assert.equal(RoutingProbePlugin.seen.filter((hit) => hit.frame?.id === armed.id).length, 1, 'exactly one wake per occurrence');
});

test('advancing to the re-armed occurrence fires it too — the recurrence actually recurs', async () => {
  let harness = await createHarness();
  await armTimer(harness, { occurrenceInMs: 60_000 });

  harness.clocks.advance(61_000);
  let first = await harness.runtime.processScheduledFrames();
  assert.equal(first.length, 1, 'first fire');

  // The interval is 60s from the anchor; the re-arm is the next boundary.
  harness.clocks.advance(61_000);
  let second = await harness.runtime.processScheduledFrames();
  assert.equal(second.length, 1, 'second fire — the timer recurs');

  let pending = pendingEntries(harness).filter((entry) => entry.frame?.continuation?.timerID === TIMER_ID);
  assert.equal(pending.length, 1, 'still exactly one pending occurrence after two fires');
  assert.equal(pending[0].frame.continuation.firedCount, 2, 'firedCount tracks each fire');
  assert.equal(RoutingProbePlugin.seen.length, 2, 'one wake per fire, no duplicates');
});

test('cancelling first leaves the frame cancelled and nothing ever fires', async () => {
  let harness = await createHarness();
  await armTimer(harness, { occurrenceInMs: 60_000 });

  let cancelled = await cancelRecurringTimer({ frameRuntime: harness.runtime, timerID: TIMER_ID, now: harness.clocks.millis() });
  assert.equal(cancelled, 1, 'the pending occurrence must be cancelled');

  harness.clocks.advance(120_000);
  let fired = await harness.runtime.processScheduledFrames();
  assert.deepEqual(fired, [], 'a cancelled timer must not fire');
  assert.equal(RoutingProbePlugin.seen.length, 0, 'a cancelled timer must not wake anyone');
  assert.equal(pendingEntries(harness).length, 0, 'nothing pending remains');
});

test('a limit-bounded timer does not re-arm past its limit (natural end)', async () => {
  let harness = await createHarness();
  await armTimer(harness, { occurrenceInMs: 60_000, limit: 2 });

  // Fire 1.
  harness.clocks.advance(61_000);
  assert.equal((await harness.runtime.processScheduledFrames()).length, 1);
  assert.equal(
    pendingEntries(harness).filter((entry) => entry.frame?.continuation?.timerID === TIMER_ID).length,
    1,
    'fire 1 of 2 re-arms fire 2',
  );

  // Fire 2 — the limit is reached; no re-arm may remain.
  harness.clocks.advance(61_000);
  assert.equal((await harness.runtime.processScheduledFrames()).length, 1);
  assert.equal(
    pendingEntries(harness).filter((entry) => entry.frame?.continuation?.timerID === TIMER_ID).length,
    0,
    'after the final allowed fire, the timer must stop re-arming',
  );

  // And nothing more ever fires.
  harness.clocks.advance(600_000);
  assert.deepEqual(await harness.runtime.processScheduledFrames(), [], 'an exhausted timer stays silent');
  assert.equal(RoutingProbePlugin.seen.length, 2, 'exactly `limit` wakes, no more');
});

test('a late dispatch after downtime re-arms in the FUTURE (no missed-interval catch-up loop)', async () => {
  let harness = await createHarness();
  await armTimer(harness, { occurrenceInMs: 60_000 });

  // Simulate the process being down for a day: the queue dispatches the
  // overdue occurrence only after the clock has jumped. Re-arming from the
  // stale occurrence would schedule an instant in the past, which the queue
  // would then fire immediately — once per missed interval, a tight wake loop.
  harness.clocks.advance(86_400_000);

  let fired = await harness.runtime.processScheduledFrames();
  assert.equal(fired.length, 1, 'the overdue occurrence still fires once (the late wake itself)');

  let pending = pendingEntries(harness).filter((entry) => entry.frame?.continuation?.timerID === TIMER_ID);
  assert.equal(pending.length, 1, 're-armed');
  assert.ok(
    pending[0].scheduledAt > harness.clocks.micros(),
    `re-arm must be strictly in the future after downtime, got ${pending[0].scheduledAt} vs now ${harness.clocks.micros()}`,
  );
});
