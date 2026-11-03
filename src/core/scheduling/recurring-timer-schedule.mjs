'use strict';

/**
 * Recurring timers on the generic scheduled-frame queue.
 *
 * Same shape as question-deadline-schedule.mjs, by design — that module's
 * header documents why the queue replaced the old poller, and a recurring timer
 * is the same story: a known future time becomes one stored frame, durability
 * and restart-resume come free, and there is no second scheduler next to the
 * generic one.
 *
 * The ONE structural difference: a question deadline fires once and stops; a
 * recurring timer re-arms its next occurrence when it fires. That lives in the
 * frame plugin (recurring-timer-frame-plugin.mjs), which re-arms BEFORE handing
 * the fired frame to agent routing, so a route failure cannot strand the timer.
 *
 * UNITS — the trap, restated: `frame.scheduledAt` is microseconds
 * (`runtime.clock()`), everything here computes in milliseconds. Every
 * conversion goes through toScheduledAt() (imported, not copied) so there is
 * exactly one place to get it right and exactly one place a test can pin.
 */

import { toScheduledAt } from '../questions/question-deadline-schedule.mjs';
import { normalizeRecurringRule, nextOccurrence } from './recurring-rule.mjs';

export const RECURRING_TIMER_KIND = 'recurring-timer';

const SCHEDULE_AUTHOR_ID = 'internal:recurring-timer';

/**
 * Build the hidden pending frame that carries one occurrence.
 *
 * `hidden`: the armed occurrence is a scheduling token, not a message. The
 * frame's content.text IS the reminder prompt — agent routing uses it as the
 * wake message when the queue fires the frame (the owner's "message/prompt
 * delivered upon each wake as a reminder of what to do").
 *
 * `targetAgentID` is required: the queue only dispatches frames that name a
 * target.
 */
export function buildRecurringTimerFrame({ runtime, sessionID, targetAgentID, spec, occurrence, now }) {
  // spec: { timerID, prompt, rule (normalized), timezone, endAt?, limit?, firedCount? }
  const scheduledAt = toScheduledAt(occurrence);
  if (scheduledAt == null)
    return null;

  const id = runtime.idGenerator?.() || null;
  if (!id)
    return null;

  const at = Number(now ?? occurrence);

  return {
    id,
    type: 'UserMessage',
    sessionID,
    interactionID: `recurring-timer:${spec.timerID}`,
    authorType: 'system',
    authorID: SCHEDULE_AUTHOR_ID,
    targetAgentID,
    timestamp: at,
    createdAt: at,
    updatedAt: at,
    hidden: true,
    deleted: false,
    scheduledAt,
    scheduledStatus: 'pending',
    continuation: {
      kind: RECURRING_TIMER_KIND,
      timerID: spec.timerID,
      prompt: spec.prompt,
      rule: spec.rule,
      timezone: spec.timezone,
      endAt: spec.endAt ?? null,
      limit: spec.limit ?? null,
      firedCount: spec.firedCount ?? 0,
      occurrence,
      createdAt: at,
    },
    content: {
      text: spec.prompt,
      status: 'scheduled',
      scheduledKind: RECURRING_TIMER_KIND,
      timerID: spec.timerID,
    },
  };
}

/**
 * Arm one occurrence. Idempotent per timerID: re-arming replaces the previous
 * pending frame instead of stacking a second one, so a double call (or the
 * fire-time re-arm racing a manual re-arm) can never produce two live timers.
 *
 * NB: cancelRecurringTimer deliberately skips `firing` frames — when the frame
 * plugin re-arms during dispatch, the frame being dispatched is mid-flight and
 * is not ours to cancel (its own retire path owns it).
 */
export async function armRecurringTimer({ frameRuntime, sessionID, targetAgentID, spec, now }) {
  if (!frameRuntime?.ensureSessionEntry || !sessionID || !spec?.timerID)
    return null;

  const normalizedRule = normalizeRecurringRule(spec.rule, { anchorAt: spec.rule?.anchorAt ?? now });
  if (!normalizedRule)
    return null;

  const normalizedSpec = { ...spec, rule: normalizedRule };

  const frame = buildRecurringTimerFrame({
    runtime: frameRuntime,
    sessionID,
    targetAgentID,
    spec: normalizedSpec,
    occurrence: spec.occurrence,
    now,
  });
  if (!frame)
    return null;

  const entry = await frameRuntime.ensureSessionEntry(sessionID);
  if (!entry?.frameEngine)
    return null;

  await cancelRecurringTimer({ frameRuntime, timerID: spec.timerID, sessionEntry: entry });

  const merged = entry.frameEngine.merge([ frame ], {
    authorType: 'system',
    authorID: SCHEDULE_AUTHOR_ID,
  });
  await frameRuntime.frameStore?.flush?.();

  return merged?.[0] || frame;
}

/**
 * Cancel every pending occurrence of a timer. Returns how many were cancelled.
 *
 * Mirrors cancelQuestionSchedule: the primary guard for "the timer was
 * cancelled between queue selection and dispatch" is the status re-read the
 * queue already does (`isPendingScheduledFrame` drops anything not pending);
 * an entry whose engine is unreachable is still dropped from this process's
 * queue, and a future boot reloads the persisted frame — where the fire-time
 * status check takes over.
 */
export async function cancelRecurringTimer({ frameRuntime, timerID, sessionEntry = null, now = null }) {
  if (!frameRuntime || !timerID)
    return 0;

  const entries = frameRuntime.scheduledFrames?.entries;
  if (!entries)
    return 0;

  const targets = [];
  for (const candidate of entries.values()) {
    const frame = candidate?.frame;
    if (frame?.continuation?.timerID !== timerID)
      continue;
    if (frame.scheduledStatus === 'fired'
      || frame.scheduledStatus === 'cancelled'
      || frame.scheduledStatus === 'firing')
      continue;
    targets.push(candidate);
  }

  if (targets.length === 0)
    return 0;

  const at = Number(now ?? frameRuntime.clock?.() ?? Date.now());
  let cancelled = 0;

  for (const candidate of targets) {
    let entry = sessionEntry;
    if (!entry && candidate.sessionID) {
      try {
        entry = await frameRuntime.ensureSessionEntry(candidate.sessionID);
      } catch (_error) {
        entry = null;
      }
    }

    if (!entry?.frameEngine) {
      entries.delete(candidate.frameID);
      cancelled++;
      continue;
    }

    const live = entry.frameEngine.get(candidate.frameID) || candidate.frame;
    entry.frameEngine.merge([ {
      ...live,
      scheduledStatus: 'cancelled',
      scheduledCancelledAt: at,
      scheduledCancelReason: 'recurring-timer-cancelled',
      updatedAt: at,
    } ], {
      authorType: 'system',
      authorID: SCHEDULE_AUTHOR_ID,
      silent: true,
    });
    await frameRuntime.frameStore?.flush?.();
    entries.delete(candidate.frameID);
    cancelled++;
  }

  return cancelled;
}

/**
 * Summaries of a session's (or agent's) live recurring timers — what the
 * schedule_list tool reports. Reads the queue's entries, so it reflects what
 * will actually fire, not a parallel bookkeeping copy.
 */
export function listRecurringTimers(frameRuntime, { sessionID = null, agentID = null } = {}) {
  const entries = frameRuntime?.scheduledFrames?.entries;
  if (!entries)
    return [];

  const timers = [];
  for (const candidate of entries.values()) {
    const frame = candidate?.frame;
    if (frame?.continuation?.kind !== RECURRING_TIMER_KIND)
      continue;
    if (frame.scheduledStatus === 'fired' || frame.scheduledStatus === 'cancelled')
      continue;
    if (sessionID && frame.sessionID !== sessionID)
      continue;
    if (agentID && frame.targetAgentID !== agentID)
      continue;

    const cont = frame.continuation;
    timers.push({
      timerID: cont.timerID,
      sessionID: frame.sessionID,
      targetAgentID: frame.targetAgentID,
      prompt: cont.prompt,
      rule: cont.rule,
      timezone: cont.timezone,
      firedCount: cont.firedCount ?? 0,
      limit: cont.limit ?? null,
      endAt: cont.endAt ?? null,
      nextOccurrenceAt: cont.occurrence ?? null,
      scheduledAt: frame.scheduledAt ?? null,
      status: frame.scheduledStatus,
    });
  }

  return timers.sort((a, b) => (a.nextOccurrenceAt ?? 0) - (b.nextOccurrenceAt ?? 0));
}

/**
 * Whether another occurrence should be armed after this fire — the bounds check
 * shared by the tool layer and the frame plugin.
 *
 * COUNTING CONTRACT: `firedCount` counts fires that have ALREADY happened — the
 * frame plugin passes `firedCount + 1` (the current fire included) before
 * calling this, and the tool layer passes 0 at creation (no fire yet). So
 * `limit` is the total number of fires allowed, checked as `firedCount >= limit`:
 * with limit 2, fire #1 (firedCount 1) re-arms, fire #2 (firedCount 2) stops.
 * The unit test and the integration test must agree on this; the integration
 * spec (real queue, real plugin) is the behavioral authority.
 *
 * `nextAt` is epoch ms.
 */
export function shouldRecur({ endAt, limit, firedCount, nextAt, now }) {
  if (nextAt == null)
    return false;
  if (endAt != null && nextAt > Number(endAt))
    return false;
  if (limit != null && Number(firedCount ?? 0) >= Number(limit))
    return false;
  if (nextAt <= Number(now))
    return false;

  return true;
}
