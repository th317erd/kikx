'use strict';

/**
 * Fire-time handling for recurring timers.
 *
 * Registered on the router's 'Type:UserMessage' selector, between the question
 * schedule plugin and agent routing (create-server.mjs: question schedule →
 * recurring timers → agent routing). Two jobs, in this order:
 *
 * 1. RE-ARM THE NEXT OCCURRENCE FIRST — before anything that can fail or stop
 *    the chain. The fired frame itself retires (pending → fired) no matter how
 *    the route goes, so if re-arming happened after routing, a route failure
 *    would strand the timer permanently. Arming first means the worst case is a
 *    missed reminder turn with the timer intact; the re-arm is idempotent per
 *    timerID, so a double execution cannot stack occurrences.
 *
 * 2. THEN CONTINUE THE CHAIN (`next`) — unlike QuestionScheduleFramePlugin,
 *    which `done()`s because its work (apply default / deliver answer) fully
 *    replaces the wake, a recurring timer's whole point IS the wake: agent
 *    routing must see the fired frame and start a turn whose message is
 *    content.text — the reminder prompt the owner asked to be "delivered upon
 *    each wake as a reminder of what to do".
 *
 * Only acts on queue dispatches (`commit.scheduledDispatch === true`), same as
 * the question plugin: seeing the frame on any other commit means it is merely
 * pending or cancelled, and the queue owns that decision.
 */

import { BaseFramePlugin } from '../routing/index.mjs';
import {
  RECURRING_TIMER_KIND,
  armRecurringTimer,
  shouldRecur,
} from './recurring-timer-schedule.mjs';
import { nextOccurrence } from './recurring-rule.mjs';

export class RecurringTimerFramePlugin extends BaseFramePlugin {
  static pluginID = 'internal:recurring-timer';

  async process(next, done) {
    const frame = this.context.newFrame;
    const kind = frame?.continuation?.kind;

    if (kind !== RECURRING_TIMER_KIND) {
      await next(this.context);
      return;
    }

    if (this.context.commit?.scheduledDispatch !== true) {
      done();
      return;
    }

    await this.rearmNextOccurrence(frame);
    await next(this.context);
  }

  async rearmNextOccurrence(frame) {
    const services = this.context.services || {};
    const frameRuntime = services.frameRuntime || services.context?.require?.('frameRuntime') || null;
    const logger = services.logger || null;

    if (!frameRuntime) {
      logger?.warn?.('recurring-timer: no frameRuntime in services; occurrence not re-armed');
      return null;
    }

    const cont = frame.continuation || {};
    const frameNow = Number(frameRuntime.clock?.() ?? Date.now());

    // Base the next lookup on max(occurrence, now): the queue dispatches due
    // frames immediately on boot after downtime, and an occurrence whose whole
    // interval elapsed must not be re-armed in the past (which would fire in a
    // tight catch-up loop, one wake per missed interval). The late wake itself
    // still happens — the queue already dispatched this frame; we only skip
    // stacking the missed ones.
    const occurrence = Number(cont.occurrence);
    const base = Number.isFinite(occurrence) ? Math.max(occurrence, frameNow) : frameNow;

    const nextAt = nextOccurrence(cont.rule, base, cont.timezone || null);
    const firedCount = Number(cont.firedCount ?? 0) + 1;

    if (!shouldRecur({
      rule: cont.rule,
      endAt: cont.endAt,
      limit: cont.limit,
      firedCount,
      nextAt,
      now: frameNow,
    })) {
      // Timer complete: reached its limit or endAt, or no future occurrence
      // exists. The fired frame retires normally; nothing re-arms. This is the
      // intended end state, not an error, so it is not logged as one.
      return null;
    }

    try {
      return await armRecurringTimer({
        frameRuntime,
        sessionID: frame.sessionID,
        targetAgentID: frame.targetAgentID,
        spec: {
          timerID: cont.timerID,
          prompt: cont.prompt,
          rule: cont.rule,
          timezone: cont.timezone,
          endAt: cont.endAt ?? null,
          limit: cont.limit ?? null,
          firedCount,
          occurrence: nextAt,
        },
        now: frameNow,
      });
    } catch (error) {
      // A failed re-arm must not swallow this wake: log and continue, the
      // fired frame still reaches agent routing below. The timer is lost at
      // this point — silence would look exactly like "the timer stopped on its
      // own", so it is logged as an error.
      logger?.error?.('recurring-timer: failed to re-arm next occurrence', error);
      return null;
    }
  }
}

export function registerRecurringTimerRouting(frameRouter) {
  if (!frameRouter?.registerSelector)
    throw new TypeError('registerRecurringTimerRouting() requires a FrameRouter');

  frameRouter.registerSelector(
    'Type:UserMessage',
    RecurringTimerFramePlugin,
    RecurringTimerFramePlugin.pluginID,
  );
}
