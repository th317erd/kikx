'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COORDINATOR_DELEGATION_NUDGE_LINES,
  COORDINATOR_PREAMBLE_LINES,
} from '../../../src/core/plugins/agent-precepts.mjs';
import { getBehaviorScript } from '../../../src/core/scripts/script-registry.mjs';

test('coordinator-loop drifts toward visionary questions while planning', () => {
  let { script, description } = getBehaviorScript('coordinator-loop');
  assert.match(script, /drift toward visionary/);
  assert.match(script, /flesh out the overall plan/);
  assert.match(script, /lean visionary/);
  assert.match(script, /question-create/);
  assert.match(description, /visionary planning questions/);
});

test('the questions-never-stall stance still holds alongside the drift', () => {
  let { script } = getBehaviorScript('coordinator-loop');
  assert.match(script, /Questions never stall the loop/);
  assert.match(script, /keep\s+planning with your best interpretation/s);
});

test('the coordinator preamble carries the visionary planning posture', () => {
  let text = COORDINATOR_PREAMBLE_LINES.join('\n');
  assert.match(text, /drift toward visionary questions about the project/);
  assert.match(text, /questions inform planning,\s+never stall it/s);
});

test('the every-turn coordinator nudge asks for one visionary question', () => {
  let text = COORDINATOR_DELEGATION_NUDGE_LINES.join('\n');
  assert.match(text, /Ask one visionary question/);
  assert.match(text, /flesh it out, then keep the goal moving/);
});
