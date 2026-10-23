'use strict';

/**
 * Question deadlines on the generic scheduled-frame queue.
 *
 * Both halves of the ask-user lifecycle are "something must happen at a future
 * time": a default answer becoming due, and an answer whose wake has to be
 * retried after a backoff. Both used to be driven by a periodic poller
 * (`QuestionMaintenanceService`) that scanned every open question on an
 * interval. That poller is gone.
 *
 * Why the queue instead, given the poller worked:
 *
 * - It already exists. `ScheduledFrameQueue` is generic, predates the poller by
 *   four months, and is what agent continuations, process wakes and recovery
 *   already use. A parallel scheduler next to a generic one is a duplicate.
 * - The full scan was an artifact of polling, not a requirement. A deadline is
 *   known the moment the question is asked, so O(1) work per question replaces
 *   O(open questions) per tick.
 * - Durability comes for free. The deadline is a stored frame, so a restart
 *   resumes it; the poller had to recompute from docs on every boot.
 *
 * UNITS — the one thing that silently breaks this. Two clocks are in play and
 * they do not share a unit:
 *
 *   `defaultDueAt` / `nextDeliveryAt`  → milliseconds (`Date.now()` epoch)
 *   `frame.scheduledAt`                → microseconds (`runtime.clock()`,
 *                                        i.e. `defaultUnixMicros`)
 *
 * The queue compares `normalizeScheduledAt(frame.scheduledAt)` against
 * `runtime.clock()` with no conversion. Writing a millisecond value there
 * schedules the frame ~50,000 years out: it never fires, it never errors, and
 * the only symptom is a question that quietly stays open forever. Every
 * conversion goes through the two functions below so there is exactly one place
 * to get it right, and exactly one place a test can pin it.
 */

export const QUESTION_DEADLINE_KIND = 'question-deadline';
export const QUESTION_RETRY_KIND = 'question-retry';
export const QUESTION_SCHEDULE_KINDS = [ QUESTION_DEADLINE_KIND, QUESTION_RETRY_KIND ];

const SCHEDULE_AUTHOR_ID = 'internal:question-deadline';

/**
 * Milliseconds → the microseconds `scheduledAt` is expressed in.
 *
 * Guards the plausible mistakes explicitly rather than letting `Number()` turn
 * them into silent nonsense: `null` becomes `null` (not 1970), a non-finite
 * value becomes `null` (not `NaN`, which would compare false against everything
 * and never fire), and an already-microsecond value is detected and passed
 * through rather than multiplied a second time.
 */
export function toScheduledAt(value) {
  if (value == null)
    return null;

  let millis = Number(value);
  if (!Number.isFinite(millis) || millis <= 0)
    return null;

  // A genuine millisecond epoch is ~1.7e12 today; a microsecond epoch is
  // ~1.7e15. Treat anything already in the microsecond range as such, so a
  // caller that hands us the wrong unit cannot schedule the year 57,000.
  if (millis >= 1e14)
    return Math.trunc(millis);

  return Math.trunc(millis * 1000);
}

/**
 * Build the hidden frame that carries a question's next scheduled action.
 *
 * `hidden` keeps it out of the transcript: it is a scheduling token, not a
 * message. It is given `targetAgentID` because the queue only dispatches frames
 * that name a target, and because the plugin that handles it acts on the asking
 * agent's behalf.
 */
export function buildQuestionScheduleFrame({ runtime, question, kind, dueAt, now }) {
  let scheduledAt = toScheduledAt(dueAt);
  if (scheduledAt == null)
    return null;

  let at = Number(now ?? dueAt);
  let id = runtime.idGenerator?.() || null;
  if (!id)
    return null;

  return {
    id,
    type: 'UserMessage',
    sessionID: question.sessionID,
    interactionID: `question-schedule:${question.id}:${kind}`,
    parentID: question.frameID || null,
    authorType: 'system',
    authorID: SCHEDULE_AUTHOR_ID,
    targetAgentID: question.agentID,
    timestamp: at,
    createdAt: at,
    updatedAt: at,
    hidden: true,
    deleted: false,
    scheduledAt,
    scheduledStatus: 'pending',
    continuation: {
      kind,
      questionID: question.id,
      groupID: question.groupID || null,
      dueAt: Number(dueAt),
      createdAt: at,
    },
    content: {
      // Never rendered (the frame is hidden), but a content block keeps the
      // shape uniform with every other scheduled continuation frame.
      text: kind === QUESTION_DEADLINE_KIND
        ? `Question ${question.id} reaches its default-answer deadline.`
        : `Question ${question.id} retries an undelivered answer.`,
      status: 'scheduled',
      questionID: question.id,
      scheduledKind: kind,
    },
  };
}

/**
 * Arm the deadline for one question. Idempotent per question+kind: re-arming
 * replaces the previous pending frame instead of stacking a second one, so a
 * double call can never produce two defaults.
 */
export async function armQuestionSchedule({ frameRuntime, question, kind, dueAt, now }) {
  if (!frameRuntime?.ensureSessionEntry || !question?.sessionID || !question?.id)
    return null;

  let frame = buildQuestionScheduleFrame({
    runtime: frameRuntime,
    question,
    kind,
    dueAt,
    now,
  });
  if (!frame)
    return null;

  let entry = await frameRuntime.ensureSessionEntry(frame.sessionID);
  if (!entry?.frameEngine)
    return null;

  await cancelQuestionSchedule({ frameRuntime, questionID: question.id, kind, sessionEntry: entry });

  let merged = entry.frameEngine.merge([ frame ], {
    authorType: 'system',
    authorID: SCHEDULE_AUTHOR_ID,
  });
  await frameRuntime.frameStore?.flush?.();

  return merged?.[0] || frame;
}

/**
 * Cancel the pending schedule for a question.
 *
 * This is the primary guard for "the timer fired but the question was already
 * answered": the user answers, we cancel here, and the queue's `dispatch()`
 * re-reads the frame, sees `scheduledStatus !== 'pending'` and drops the entry
 * before anything routes. The fire-time plugin then re-checks the question
 * status as an independent backstop, because `dispatch()` awaits (session
 * lookup, flush) between selecting an entry and acting on it, and an answer can
 * land in that window.
 */
export async function cancelQuestionSchedule({ frameRuntime, questionID, kind = null, sessionEntry = null, now = null }) {
  if (!frameRuntime || !questionID)
    return 0;

  let entries = frameRuntime.scheduledFrames?.entries;
  if (!entries)
    return 0;

  let targets = [];
  for (let candidate of entries.values()) {
    let frame = candidate?.frame;
    if (frame?.continuation?.questionID !== questionID)
      continue;
    if (kind && frame.continuation.kind !== kind)
      continue;
    if (frame.scheduledStatus === 'fired' || frame.scheduledStatus === 'cancelled')
      continue;
    targets.push(candidate);
  }

  if (targets.length === 0)
    return 0;

  let at = Number(now ?? frameRuntime.clock?.() ?? Date.now());
  let cancelled = 0;

  for (let candidate of targets) {
    let entry = sessionEntry;
    if (!entry && candidate.sessionID) {
      try {
        entry = await frameRuntime.ensureSessionEntry(candidate.sessionID);
      } catch (_error) {
        entry = null;
      }
    }

    if (!entry?.frameEngine) {
      // No reachable engine: still drop it from the queue so this process stops
      // considering it. The persisted frame stays `pending` and a future boot
      // will reload it — where the fire-time status check takes over.
      entries.delete(candidate.frameID);
      cancelled++;
      continue;
    }

    let live = entry.frameEngine.get(candidate.frameID) || candidate.frame;
    let updated = {
      ...live,
      scheduledStatus: 'cancelled',
      scheduledCancelledAt: at,
      scheduledCancelReason: `answered-before-${live?.continuation?.kind || 'schedule'}`,
      updatedAt: at,
    };

    entry.frameEngine.merge([ updated ], {
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

/** Convenience wrappers so call sites read as intent, not as plumbing. */
export async function armQuestionDeadline({ frameRuntime, question, now }) {
  if (question?.defaultDueAt == null)
    return null;

  return await armQuestionSchedule({
    frameRuntime,
    question,
    kind: QUESTION_DEADLINE_KIND,
    dueAt: question.defaultDueAt,
    now,
  });
}

export async function armQuestionRetry({ frameRuntime, question, now }) {
  if (question?.nextDeliveryAt == null)
    return null;

  return await armQuestionSchedule({
    frameRuntime,
    question,
    kind: QUESTION_RETRY_KIND,
    dueAt: question.nextDeliveryAt,
    now,
  });
}
