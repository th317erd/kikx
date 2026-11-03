'use strict';

// Unit coverage for the recurring-timer rule engine and arm/cancel module.
// The queue-level seams (arm → tracked by ScheduledFrameQueue → fires → plugin
// re-arms → reminder reaches agent routing) belong to the sibling integration
// spec, mirroring question-deadline-integration-spec.mjs; this file pins the
// pure logic and the idempotency contracts. Where the two specs could disagree
// (the limit count), the integration spec — real queue, real plugin — is the
// behavioral authority this file defers to.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_TIMEZONE,
  nextOccurrence,
  normalizeRecurringRule,
  normalizeWallClock,
} from '../../../src/core/scheduling/recurring-rule.mjs';
import {
  RECURRING_TIMER_KIND,
  armRecurringTimer,
  buildRecurringTimerFrame,
  cancelRecurringTimer,
  listRecurringTimers,
  shouldRecur,
} from '../../../src/core/scheduling/recurring-timer-schedule.mjs';

const LA = 'America/Los_Angeles';

function formatInTz(tz, utcMs) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(new Date(utcMs));
}

// ---------------------------------------------------------------------------
// Rule validation
// ---------------------------------------------------------------------------

test('invalid rules normalize to null — refuse, never guess a schedule', () => {
  assert.equal(normalizeRecurringRule(null), null);
  assert.equal(normalizeRecurringRule({ type: 'cron', expr: '* * * * *' }), null);
  assert.equal(normalizeRecurringRule({ type: 'daily', time: '25:00' }), null);
  assert.equal(normalizeRecurringRule({ type: 'daily', time: '9am' }), null);
  assert.equal(normalizeRecurringRule({ type: 'weekly', time: '09:00', days: [] }), null);
  assert.equal(normalizeRecurringRule({ type: 'weekly', time: '09:00', days: [ 9 ] }), null);
  assert.equal(normalizeRecurringRule({ type: 'every', n: 0, unit: 'hour', anchorAt: 1 }), null);
  assert.equal(normalizeRecurringRule({ type: 'every', n: 1.5, unit: 'hour', anchorAt: 1 }), null);
  assert.equal(normalizeRecurringRule({ type: 'every', n: 1, unit: 'fortnight', anchorAt: 1 }), null);
  assert.equal(normalizeRecurringRule({ type: 'every', n: 1, unit: 'hour' }), null, 'every requires an anchor');
  assert.equal(normalizeRecurringRule({ type: 'daily', time: '09:00', timezone: 'Mars/Olympus' }), null, 'invalid IANA zone rejected');
});

test('valid rules normalize, and normalization is idempotent', () => {
  const daily = normalizeRecurringRule({ type: 'daily', time: '09:05' });
  assert.deepEqual(daily, { type: 'daily', time: { hh: 9, mm: 5 }, timezone: DEFAULT_TIMEZONE });
  assert.deepEqual(normalizeRecurringRule(daily), daily, 're-normalizing must be a no-op');

  const weekly = normalizeRecurringRule({ type: 'weekly', time: '9:00', days: [ 1, 1, 3 ], timezone: LA });
  assert.deepEqual(weekly, { type: 'weekly', time: { hh: 9, mm: 0 }, days: [ 1, 3 ], timezone: LA });

  assert.deepEqual(
    normalizeWallClock('00:00'),
    { hh: 0, mm: 0 },
  );
});

// ---------------------------------------------------------------------------
// nextOccurrence — the "exact specified recurring time" contract
// ---------------------------------------------------------------------------

test('daily keeps its exact wall-clock time across a DST transition', () => {
  // US DST 2026 starts Sunday March 8. A daily 09:00 Los Angeles timer must
  // read 09:00 local on both sides of the transition — its UTC instant shifts
  // by an hour, its wall clock must not.
  const rule = normalizeRecurringRule({ type: 'daily', time: '09:00', timezone: LA });

  // Mar 6 20:00 UTC = Mar 6 12:00 PST → next fire Mar 7 09:00 PST = 17:00 UTC.
  const beforeTransition = nextOccurrence(rule, Date.UTC(2026, 2, 6, 20, 0));
  assert.equal(beforeTransition, Date.UTC(2026, 2, 7, 17, 0));
  assert.match(formatInTz(LA, beforeTransition), /09:00/);

  // Mar 8 18:00 UTC = Mar 8 11:00 PDT (already sprang forward) → next fire
  // Mar 9 09:00 PDT = 16:00 UTC. Same wall clock, different UTC instant.
  const afterTransition = nextOccurrence(rule, Date.UTC(2026, 2, 8, 18, 0));
  assert.equal(afterTransition, Date.UTC(2026, 2, 9, 16, 0));
  assert.match(formatInTz(LA, afterTransition), /09:00/);
});

test('daily fires again the same day when the time has not passed', () => {
  const rule = normalizeRecurringRule({ type: 'daily', time: '09:00', timezone: 'UTC' });
  const after = Date.UTC(2026, 5, 1, 8, 0);
  assert.equal(nextOccurrence(rule, after), Date.UTC(2026, 5, 1, 9, 0), '08:00 → today 09:00');
  assert.equal(nextOccurrence(rule, Date.UTC(2026, 5, 1, 9, 30)), Date.UTC(2026, 5, 2, 9, 0), '09:30 → tomorrow 09:00');
});

test('weekly picks the next matching weekday only', () => {
  const rule = normalizeRecurringRule({ type: 'weekly', time: '09:00', days: [ 1 ], timezone: 'UTC' }); // Mondays
  // 2026-06-03 is a Wednesday.
  const next = nextOccurrence(rule, Date.UTC(2026, 5, 3, 12, 0));
  assert.equal(next, Date.UTC(2026, 5, 8, 9, 0), 'next Monday 09:00');
  assert.equal(new Date(next).getUTCDay(), 1, 'must land on Monday');
});

test('every-N is a fixed interval, strictly after the given instant', () => {
  const anchor = Date.UTC(2026, 0, 1, 0, 0);
  const every15 = normalizeRecurringRule({ type: 'every', n: 15, unit: 'minute', anchorAt: anchor });

  assert.equal(nextOccurrence(every15, anchor - 1), anchor, 'before anchor → the anchor itself');
  assert.equal(nextOccurrence(every15, anchor), anchor + 15 * 60_000, 'at the anchor → next step, strictly after');
  assert.equal(nextOccurrence(every15, anchor + 16 * 60_000), anchor + 30 * 60_000);

  // Every 2 hours from the anchor: occurrences are anchor+0h, +2h, +4h…
  // After anchor+2h+1ms the next one is anchor+4h.
  const every2h = normalizeRecurringRule({ type: 'every', n: 2, unit: 'hour', anchorAt: anchor });
  assert.equal(nextOccurrence(every2h, anchor + 7_200_001), anchor + 4 * 3_600_000);
});

test('nextOccurrence rejects non-finite instants and invalid rules with null', () => {
  assert.equal(nextOccurrence({ type: 'daily', time: '09:00' }, Number.NaN), null);
  assert.equal(nextOccurrence({ type: 'bogus' }, Date.now()), null);
});

// ---------------------------------------------------------------------------
// Frame build — the unit conversion pin
// ---------------------------------------------------------------------------

const SPEC = {
  timerID: 'tmr_1',
  prompt: 'Review the inbox',
  rule: { type: 'daily', time: '09:00', timezone: 'UTC' },
  timezone: 'UTC',
  endAt: null,
  limit: null,
  firedCount: 0,
};

test('the armed frame carries a MICROSECOND scheduledAt built from a millisecond occurrence', () => {
  let seq = 0;
  const frame = buildRecurringTimerFrame({
    runtime: { idGenerator: () => `id_${++seq}` },
    sessionID: 'ses_1',
    targetAgentID: 'agent_1',
    spec: { ...SPEC, rule: normalizeRecurringRule(SPEC.rule) },
    occurrence: Date.UTC(2026, 5, 1, 9, 0),
    now: 1_792_700_000_000,
  });

  assert.ok(frame?.id);
  assert.equal(frame.type, 'UserMessage');
  assert.equal(frame.hidden, true, 'armed occurrences are scheduling tokens, not messages');
  assert.equal(frame.scheduledStatus, 'pending');
  assert.equal(frame.targetAgentID, 'agent_1', 'the queue only dispatches frames that name a target');
  assert.equal(frame.continuation.kind, RECURRING_TIMER_KIND);
  assert.equal(frame.content.text, SPEC.prompt, 'the wake message is the reminder prompt');

  // The unit pin: a millisecond occurrence MUST be stored as microseconds.
  // If toScheduledAt were bypassed, scheduledAt would equal the ms value and
  // the queue would never fire (or fire in year 57,000 if double-scaled the
  // other way) — silent in both directions, which is why it is pinned here.
  assert.equal(frame.scheduledAt, frame.continuation.occurrence * 1000);
  assert.ok(frame.scheduledAt >= 1e14, `scheduledAt must be microsecond-scale, got ${frame.scheduledAt}`);
});

test('an unrepresentable occurrence refuses to build (null), never a bogus frame', () => {
  const frame = buildRecurringTimerFrame({
    runtime: { idGenerator: () => 'id_x' },
    sessionID: 'ses_1',
    targetAgentID: 'agent_1',
    spec: { ...SPEC, rule: normalizeRecurringRule(SPEC.rule) },
    occurrence: null,
    now: 1,
  });
  assert.equal(frame, null);
});

// ---------------------------------------------------------------------------
// arm / cancel idempotency — a fake frameRuntime with the real entry semantics
// ---------------------------------------------------------------------------

function createFakeRuntime() {
  const entries = new Map();
  let seq = 0;

  const engine = {
    frames: new Map(),
    merge(list) {
      return list.map((frame) => {
        const merged = { ...(this.frames.get(frame.id) || {}), ...frame };
        this.frames.set(frame.id, merged);
        if (merged.scheduledStatus === 'pending' && merged.deleted !== true) {
          entries.set(merged.id, {
            frame: merged,
            frameID: merged.id,
            sessionID: merged.sessionID,
            scheduledAt: merged.scheduledAt,
          });
        } else if (merged.scheduledStatus === 'cancelled' || merged.scheduledStatus === 'fired') {
          entries.delete(merged.id);
        }
        return merged;
      });
    },
    get(id) {
      return this.frames.get(id) || null;
    },
  };

  return {
    idGenerator: () => `id_${++seq}`,
    clock: () => 1_792_700_000_000,
    ensureSessionEntry: async () => ({ frameEngine: engine }),
    frameStore: { flush: async () => {} },
    scheduledFrames: { entries },
    _engine: engine,
  };
}

function pendingFor(runtime, timerID) {
  return [ ...runtime.scheduledFrames.entries.values() ]
    .filter((entry) => entry.frame?.continuation?.timerID === timerID
      && entry.frame?.scheduledStatus === 'pending');
}

test('arming twice leaves exactly one pending occurrence (idempotent per timerID)', async () => {
  const runtime = createFakeRuntime();
  const spec = { ...SPEC, rule: normalizeRecurringRule(SPEC.rule), occurrence: Date.UTC(2026, 5, 1, 9, 0) };

  const first = await armRecurringTimer({
    frameRuntime: runtime,
    sessionID: 'ses_1',
    targetAgentID: 'agent_1',
    spec,
    now: runtime.clock(),
  });
  const second = await armRecurringTimer({
    frameRuntime: runtime,
    sessionID: 'ses_1',
    targetAgentID: 'agent_1',
    spec: { ...spec, occurrence: Date.UTC(2026, 5, 2, 9, 0) },
    now: runtime.clock(),
  });

  assert.ok(first?.id && second?.id, 'each arm merges a frame');
  assert.notEqual(first.id, second.id, 're-arm replaces with a new frame');
  assert.equal(pendingFor(runtime, SPEC.timerID).length, 1, 'exactly ONE pending occurrence may exist');
  assert.equal(
    runtime._engine.get(first.id).scheduledStatus,
    'cancelled',
    'the superseded occurrence is cancelled, not left pending',
  );
});

test('arming with an invalid rule refuses (null) and arms nothing', async () => {
  const runtime = createFakeRuntime();
  const armed = await armRecurringTimer({
    frameRuntime: runtime,
    sessionID: 'ses_1',
    targetAgentID: 'agent_1',
    spec: { ...SPEC, rule: { type: 'cron', expr: 'x' }, occurrence: Date.UTC(2026, 5, 1, 9, 0) },
    now: runtime.clock(),
  });

  assert.equal(armed, null, 'an invalid rule must never produce a timer');
  assert.equal(runtime.scheduledFrames.entries.size, 0);
});

test('cancel removes the pending occurrence and reports the count', async () => {
  const runtime = createFakeRuntime();
  const spec = { ...SPEC, rule: normalizeRecurringRule(SPEC.rule), occurrence: Date.UTC(2026, 5, 1, 9, 0) };
  await armRecurringTimer({ frameRuntime: runtime, sessionID: 'ses_1', targetAgentID: 'agent_1', spec, now: runtime.clock() });

  const cancelled = await cancelRecurringTimer({ frameRuntime: runtime, timerID: SPEC.timerID, now: runtime.clock() });
  assert.equal(cancelled, 1);
  assert.equal(pendingFor(runtime, SPEC.timerID).length, 0, 'a cancelled timer must not remain in the queue');

  const again = await cancelRecurringTimer({ frameRuntime: runtime, timerID: SPEC.timerID, now: runtime.clock() });
  assert.equal(again, 0, 'cancelling twice reports zero, not a phantom success');
});

test('cancel never touches a frame that is mid-dispatch (firing)', async () => {
  const runtime = createFakeRuntime();
  const spec = { ...SPEC, rule: normalizeRecurringRule(SPEC.rule), occurrence: Date.UTC(2026, 5, 1, 9, 0) };
  const armed = await armRecurringTimer({ frameRuntime: runtime, sessionID: 'ses_1', targetAgentID: 'agent_1', spec, now: runtime.clock() });

  // The queue has marked the frame firing and is inside dispatch — this is
  // exactly the moment the fire-time re-arm runs armRecurringTimer for the
  // same timerID. Cancelling the in-flight frame here would race the queue's
  // own retire path.
  const firing = { ...runtime._engine.get(armed.id), scheduledStatus: 'firing' };
  runtime._engine.merge([ firing ], { authorType: 'system', authorID: 'queue' });
  runtime.scheduledFrames.entries.set(armed.id, {
    frame: firing,
    frameID: armed.id,
    sessionID: 'ses_1',
    scheduledAt: firing.scheduledAt,
  });

  const cancelled = await cancelRecurringTimer({ frameRuntime: runtime, timerID: SPEC.timerID, now: runtime.clock() });
  assert.equal(cancelled, 0, 'a firing frame must be skipped');
  assert.ok(runtime.scheduledFrames.entries.has(armed.id), 'the in-flight entry must stay in the queue');
});

test('listRecurringTimers reports what will actually fire', async () => {
  const runtime = createFakeRuntime();
  const occurrence = Date.UTC(2026, 5, 1, 9, 0);
  const spec = { ...SPEC, rule: normalizeRecurringRule(SPEC.rule), occurrence, firedCount: 3 };
  await armRecurringTimer({ frameRuntime: runtime, sessionID: 'ses_1', targetAgentID: 'agent_1', spec, now: runtime.clock() });

  const timers = listRecurringTimers(runtime, { sessionID: 'ses_1' });
  assert.equal(timers.length, 1);
  assert.equal(timers[0].timerID, SPEC.timerID);
  assert.equal(timers[0].prompt, SPEC.prompt);
  assert.equal(timers[0].firedCount, 3);
  assert.equal(timers[0].nextOccurrenceAt, occurrence);

  assert.equal(listRecurringTimers(runtime, { sessionID: 'other' }).length, 0, 'other sessions see nothing');
  assert.equal(listRecurringTimers(runtime, { agentID: 'someone_else' }).length, 0, 'other agents see nothing');

  await cancelRecurringTimer({ frameRuntime: runtime, timerID: SPEC.timerID, now: runtime.clock() });
  assert.equal(listRecurringTimers(runtime).length, 0, 'a cancelled timer disappears from the list');
});

test('shouldRecur enforces endAt, limit, and the strictly-in-the-future guard', () => {
  // COUNTING CONTRACT (see the source docblock): firedCount counts fires that
  // have ALREADY happened — the plugin passes the current fire included. So
  // limit 5 permits exactly 5 fires: after fire 4 (firedCount 4) it re-arms the
  // 5th; after fire 5 (firedCount 5) it stops. The integration spec proves the
  // same contract end-to-end (limit 2 → exactly two wakes); this pins it at the
  // unit level so a regression fails in the cheaper place too. This test was
  // WRITTEN WRONG first (it expected firedCount 4 to stop) and was corrected
  // only because the integration spec caught the real off-by-one against the
  // live queue — the integration spec is the behavioral authority.
  const now = 1_000_000;
  assert.equal(shouldRecur({ nextAt: now + 1, firedCount: 0, now }), true);
  assert.equal(shouldRecur({ nextAt: now, firedCount: 0, now }), false, 'never arm an instant that is already due');
  assert.equal(shouldRecur({ nextAt: now + 1, endAt: now, firedCount: 0, now }), false, 'past endAt stops the timer');
  assert.equal(shouldRecur({ nextAt: now + 1, limit: 5, firedCount: 5, now }), false, 'the 5th fire was the last, no 6th arm');
  assert.equal(shouldRecur({ nextAt: now + 1, limit: 5, firedCount: 4, now }), true, 'fire 4 of 5 re-arms fire 5');
  assert.equal(shouldRecur({ nextAt: null, now }), false);
});
