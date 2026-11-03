'use strict';

// Tool-level coverage for the recurring-timer tools, plus the two REACHABILITY
// seams that a module with only its own specs would leave unproven (the defect
// shape this repo keeps producing — a correct module nothing calls):
//
//   1. registerBuiltInTools must actually register schedule_recurring/list/
//      cancel from the PRODUCTION entry point (register-built-in-tools.mjs),
//   2. create-server.mjs must register RecurringTimerRouting BETWEEN the
//      question-schedule selector and agent routing — order matters, the
//      plugin's whole contract is "re-arm and continue before a turn starts".
//
// The execute() tests drive the real tool classes with a fake context holding
// the real arm/cancel module wired to a fake frameRuntime.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { registerBuiltInTools } from '../../../src/core/tools/register-built-in-tools.mjs';
import {
  ScheduleCancelTool,
  ScheduleListTool,
  ScheduleRecurringTool,
} from '../../../src/core/scheduling/schedule-tools.mjs';

const ROOT = new URL('../../../', import.meta.url);

// --- Seam 1: registration from the production entry point -------------------

test('registerBuiltInTools registers the three schedule tools', () => {
  const registered = new Map();
  const registry = {
    registerTool: (name, ToolClass) => registered.set(name, ToolClass),
    getTool: (name) => registered.get(name),
    registerFrameComponent() {},
    getFrameComponents: () => new Map(),
  };

  registerBuiltInTools(registry);

  assert.ok(registered.has('schedule_recurring'), 'schedule_recurring must be registered');
  assert.ok(registered.has('schedule_list'), 'schedule_list must be registered');
  assert.ok(registered.has('schedule_cancel'), 'schedule_cancel must be registered');
  assert.equal(registered.get('schedule_recurring'), ScheduleRecurringTool);
});

// Seam 1b: the riskLevel convention. Production injects no permissions
// boundary, so a tool inheriting the base default 'high' throws
// PermissionRequiredError on EVERY call (the exact defect this spec caught
// once): pin 'none' on all three classes.
test('all three schedule tools declare riskLevel none (no permissions boundary in production)', () => {
  assert.equal(ScheduleRecurringTool.riskLevel, 'none');
  assert.equal(ScheduleListTool.riskLevel, 'none');
  assert.equal(ScheduleCancelTool.riskLevel, 'none');
});

// --- Seam 2: router registration ORDER in create-server.mjs -----------------

test('create-server registers recurring-timer routing before agent routing, after question schedule', async () => {
  const source = fs.readFileSync(fileURLToPath(new URL('src/server/create-server.mjs', ROOT)), 'utf8');

  const questionIdx = source.indexOf('registerQuestionScheduleRouting(');
  const recurringIdx = source.indexOf('registerRecurringTimerRouting(');
  const agentIdx = source.indexOf('registerAgentRouting(');

  assert.ok(questionIdx > 0, 'question schedule registration present');
  assert.ok(recurringIdx > 0, 'recurring timer registration present — the module must be wired, not just written');
  assert.ok(agentIdx > 0, 'agent routing registration present');

  assert.ok(questionIdx < recurringIdx, 'recurring timers after question schedule');
  assert.ok(recurringIdx < agentIdx, 'recurring timers BEFORE agent routing — the plugin must re-arm and continue before any turn starts');
});

// --- execute() — the real tool classes, a fake context, the real module -----

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
        } else if (merged.scheduledStatus !== 'pending') {
          entries.delete(merged.id);
        }
        return merged;
      });
    },
    get: (id) => engine.frames.get(id) || null,
  };

  return {
    // FrameClock semantics: microseconds (like runtime.clock / defaultUnixMicros).
    clock: () => 1_792_700_000_000 * 1000,
    idGenerator: () => `id_${++seq}`,
    ensureSessionEntry: async () => ({ frameEngine: engine }),
    frameStore: { flush: async () => {} },
    scheduledFrames: { entries },
    _engine: engine,
  };
}

function createToolContext(runtime, { agentID = 'agent_1' } = {}) {
  return {
    session: { id: 'ses_1' },
    agent: { id: agentID, name: 'Probe' },
    frameRuntime: runtime,
    services: { frameRuntime: runtime },
  };
}

test('schedule_recurring.execute() arms a daily timer and reports the first occurrence', async () => {
  const runtime = createFakeRuntime();
  const tool = new ScheduleRecurringTool();
  tool.context = createToolContext(runtime);

  const result = await tool.execute({
    prompt: 'Check the build',
    rule: { type: 'daily', time: '09:00', timezone: 'UTC' },
  });

  assert.equal(result.created, true, JSON.stringify(result));
  assert.ok(result.timerID, 'a timerID is returned for later list/cancel');
  assert.match(result.firstOccurrenceAt, /^\d{4}-\d{2}-\d{2}T/, 'ISO first occurrence');

  const pending = [ ...runtime.scheduledFrames.entries.values() ];
  assert.equal(pending.length, 1, 'exactly one pending occurrence armed');
  assert.equal(pending[0].frame.content.text, 'Check the build', 'wake message is the prompt');
  assert.ok(pending[0].scheduledAt >= 1e14, "stored scheduledAt is microsecond-scale: ~1.8e15 >= 1e14, ms epoch ~1.8e12 < 1e14 (same cutoff as toScheduledAt)");
});

test('schedule_recurring.execute() refuses an invalid rule and arms nothing', async () => {
  const runtime = createFakeRuntime();
  const tool = new ScheduleRecurringTool();
  tool.context = createToolContext(runtime);

  const result = await tool.execute({
    prompt: 'Check the build',
    rule: { type: 'daily', time: '25:99', timezone: 'Nope/Nowhere' },
  });

  assert.equal(result.created, false);
  assert.equal(result.reason, 'invalid-rule');
  assert.equal(runtime.scheduledFrames.entries.size, 0, 'an invalid rule must arm nothing');
});

test('schedule_list + schedule_cancel round-trip through the real tools', async () => {
  const runtime = createFakeRuntime();

  const createTool = new ScheduleRecurringTool();
  createTool.context = createToolContext(runtime);
  const created = await createTool.execute({
    prompt: 'Evening review',
    rule: { type: 'daily', time: '22:00', timezone: 'UTC' },
  });
  assert.equal(created.created, true);

  const listTool = new ScheduleListTool();
  listTool.context = createToolContext(runtime);
  const listed = await listTool.execute({});
  assert.equal(listed.count, 1, 'the armed timer is visible');
  assert.equal(listed.timers[0].timerID, created.timerID);
  assert.match(listed.timersWithNextAt[0].nextOccurrenceISO, /^\d{4}-\d{2}-\d{2}T/);

  const cancelTool = new ScheduleCancelTool();
  cancelTool.context = createToolContext(runtime);
  const cancelled = await cancelTool.execute({ timer_id: created.timerID });
  assert.equal(cancelled.cancelled, 1);
  assert.equal(cancelled.found, true);

  // Idempotent cancel: the tool reports 0 the second time, not a phantom win.
  const again = await cancelTool.execute({ timer_id: created.timerID });
  assert.equal(again.cancelled, 0, 'second cancel reports zero');
  assert.equal(again.found, false);
  assert.ok(again.hint, 'an empty cancel explains itself instead of looking like success');

  const afterCancel = await listTool.execute({});
  assert.equal(afterCancel.count, 0, 'cancelled timer disappears from the list');
});
