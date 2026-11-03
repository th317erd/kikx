'use strict';

/**
 * Agent tools for recurring timers: schedule_recurring / schedule_list /
 * schedule_cancel.
 *
 * Context contract matches the other built-ins: session from
 * context.session (injected `_sessionID` fallback), agent from context.agent
 * (injected `_agentID` fallback). A timer targets the agent that created it —
 * that is the agent whose turn should be woken with the reminder prompt; a
 * coordinator setting a reminder for itself is the Miri use case.
 *
 * Authority: riskLevel 'none', the built-in convention (exec, ask-user, cwd, ...).
 * Production never injects a permissions boundary into tool context, so anything
 * inheriting the base class default 'high' would throw PermissionRequiredError
 * on every call — no new grantable action; a reminder is scoped to the session
 * and agent that already own the conversation.
 */

import { PluginInterface } from '../plugins/index.mjs';
import {
  armRecurringTimer,
  cancelRecurringTimer,
  listRecurringTimers,
} from './recurring-timer-schedule.mjs';
import { nextOccurrence, normalizeRecurringRule } from './recurring-rule.mjs';

const RULE_SCHEMA = {
  type: 'object',
  description: 'Recurrence rule. Exactly one of the three forms.',
  properties: {
    type: {
      type: 'string',
      enum: [ 'every', 'daily', 'weekly' ],
      description: "'every' = fixed interval from anchor_at; 'daily' = exact time each day; 'weekly' = exact time on the given weekdays.",
    },
    n: { type: 'integer', minimum: 1, description: "every: interval count, e.g. 15." },
    unit: {
      type: 'string',
      enum: [ 'minute', 'hour', 'day', 'week' ],
      description: 'every: interval unit.',
    },
    anchor_at: {
      type: [ 'string', 'number' ],
      description: 'every: interval anchor (ISO string or epoch ms). Defaults to now; the first fire is the first interval boundary strictly after now.',
    },
    time: { type: 'string', pattern: '^\\d{1,2}:\\d{2}$', description: 'daily/weekly: exact local time HH:MM.' },
    days: {
      type: 'array',
      items: { type: 'integer', minimum: 0, maximum: 6 },
      description: 'weekly: weekdays, 0=Sunday..6=Saturday.',
    },
    timezone: { type: 'string', description: 'IANA zone, e.g. America/Los_Angeles. Default UTC. daily/weekly keep this exact wall-clock time across DST.' },
  },
  required: [ 'type' ],
};

function frameRuntime(context) {
  const runtime = context.frameRuntime
    || context.services?.frameRuntime
    || context.services?.context?.require?.('frameRuntime');
  if (!runtime)
    throw new Error('recurring timer tools require frameRuntime');
  return runtime;
}

function sessionID(context, params) {
  const id = context.session?.id || params?._sessionID;
  if (!id)
    throw new Error('recurring timer tools require a session context');
  return id;
}

function agentID(context, params) {
  const id = context.agent?.id || params?._agentID;
  if (!id)
    throw new Error('recurring timer tools require an agent context');
  return id;
}

/** Accept epoch ms or ISO string; null when unparseable. */
function parseInstant(value) {
  if (value == null || value === '')
    return null;
  if (typeof value === 'number')
    return Number.isFinite(value) ? Math.trunc(value) : null;

  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

export class ScheduleRecurringTool extends PluginInterface {
  static pluginID = 'internal:recurring-timers';
  static featureName = 'schedule_recurring';
  static displayName = 'Schedule a recurring reminder';
  static description = 'Create a recurring timer that wakes the calling agent at an exact recurring time, delivering a reminder prompt on each wake. Rules: every N minutes/hours/days/weeks, or daily/weekly at HH:MM in an IANA timezone (DST-correct).';
  static frameType = 'ScheduleRecurringToolFrame';
  static riskLevel = 'none';
  static inputSchema = {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: 'The reminder delivered as the wake message on every fire — write it as an instruction to your future self.',
      },
      rule: RULE_SCHEMA,
      timezone: { type: 'string', description: 'Shorthand for rule.timezone.' },
      end_at: { type: [ 'string', 'number' ], description: 'Optional stop after this instant (ISO or epoch ms): no occurrence may start after it.' },
      limit: { type: 'integer', minimum: 1, description: 'Optional maximum number of fires.' },
      first_at: { type: [ 'string', 'number' ], description: 'Optional explicit first occurrence (ISO or epoch ms). Defaults to the next instant matching the rule.' },
    },
    required: [ 'prompt', 'rule' ],
    additionalProperties: false,
  };
  static help = 'Use schedule_recurring for reminders that repeat ("every weekday 09:00", "daily 22:00", "every 15 minutes"). One-shot future work belongs to continue-turn; a question to the user belongs to ask-user. The timer is durable: it survives restarts and fires through the scheduled-frame queue.';

  async _execute(params = {}) {
    const runtime = frameRuntime(this.context);
    const nowMs = Number(runtime.clock?.() ?? Date.now());
    // Frame clocks are microseconds; rule math is milliseconds. A µs "now"
    // would make nextOccurrence return microsecond-scale occurrences and arm
    // the year 57,000 — the same unit trap as scheduledAt, caught here.
    const now = nowMs >= 1e14 ? Math.trunc(nowMs / 1000) : nowMs;

    const timezone = params.timezone || params.rule?.timezone || null;
    const rawRule = timezone
      ? { ...params.rule, timezone }
      : params.rule;

    const rule = normalizeRecurringRule(rawRule, {
      anchorAt: parseInstant(params.rule?.anchor_at ?? params.first_at),
    });
    if (!rule)
      return { created: false, reason: 'invalid-rule', hint: 'rule failed validation — check type/time/days/timezone/anchor_at; nothing was scheduled.' };

    const endAt = parseInstant(params.end_at);
    if (params.end_at != null && endAt == null)
      return { created: false, reason: 'invalid-end-at', hint: 'end_at could not be parsed; nothing was scheduled.' };

    const firstAt = parseInstant(params.first_at);
    const occurrence = firstAt ?? nextOccurrence(rule, now);
    if (occurrence == null || occurrence <= now)
      return { created: false, reason: 'no-occurrence', hint: 'the rule produces no future occurrence; nothing was scheduled.' };

    const timerID = runtime.idGenerator?.() || `tmr_${now}_${Math.floor(Math.random() * 1e6)}`;

    const armed = await armRecurringTimer({
      frameRuntime: runtime,
      sessionID: sessionID(this.context, params),
      targetAgentID: agentID(this.context, params),
      spec: {
        timerID,
        prompt: String(params.prompt),
        rule,
        timezone: rule.timezone,
        endAt,
        limit: params.limit ?? null,
        firedCount: 0,
        occurrence,
      },
      now,
    });

    if (!armed)
      return { created: false, reason: 'arm-failed', hint: 'arming refused — nothing was scheduled.' };

    return {
      created: true,
      timerID,
      frameID: armed.id,
      firstOccurrenceAt: new Date(occurrence).toISOString(),
      rule,
      endAt: endAt != null ? new Date(endAt).toISOString() : null,
      limit: params.limit ?? null,
    };
  }
}

export class ScheduleListTool extends PluginInterface {
  static pluginID = 'internal:recurring-timers';
  static featureName = 'schedule_list';
  static displayName = 'List recurring timers';
  static description = 'List this session’s pending recurring timers: prompt, rule, fired count, and next occurrence.';
  static frameType = 'ScheduleListToolFrame';
  static riskLevel = 'none';
  static inputSchema = {
    type: 'object',
    properties: {},
    additionalProperties: false,
  };
  static help = 'Use schedule_list to see what recurring reminders exist before creating a duplicate or cancelling one.';

  async _execute(params = {}) {
    const timers = listRecurringTimers(frameRuntime(this.context), {
      sessionID: sessionID(this.context, params),
    });

    return {
      timers,
      count: timers.length,
      timersWithNextAt: timers.map((timer) => ({
        ...timer,
        nextOccurrenceISO: timer.nextOccurrenceAt != null
          ? new Date(timer.nextOccurrenceAt).toISOString()
          : null,
      })),
    };
  }
}

export class ScheduleCancelTool extends PluginInterface {
  static pluginID = 'internal:recurring-timers';
  static featureName = 'schedule_cancel';
  static displayName = 'Cancel a recurring timer';
  static description = 'Cancel a pending recurring timer by id, stopping all future wakes for it.';
  static frameType = 'ScheduleCancelToolFrame';
  static riskLevel = 'none';
  static inputSchema = {
    type: 'object',
    properties: {
      timer_id: { type: 'string', description: 'The timer id returned by schedule_recurring.' },
    },
    required: [ 'timer_id' ],
    additionalProperties: false,
  };
  static help = 'Use schedule_cancel with a timer_id from schedule_list or schedule_recurring. Cancelling is idempotent: cancelling twice reports cancelled 0, not a phantom success.';

  async _execute(params = {}) {
    const timerID = String(params.timer_id || '').trim();
    if (!timerID)
      throw new TypeError('timer_id is required');

    const cancelled = await cancelRecurringTimer({
      frameRuntime: frameRuntime(this.context),
      timerID,
      now: null,
    });

    return {
      timerID,
      cancelled,
      found: cancelled > 0,
      ...(cancelled === 0 ? { hint: 'no pending occurrence for that timer_id — it may already be cancelled or fired out.' } : {}),
    };
  }
}
