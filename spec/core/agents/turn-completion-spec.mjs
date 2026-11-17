'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  refuseScriptedEndTurn,
  resolveTurnCompletionContinuation,
} from '../../../src/core/agents/turn-completion.mjs';

// P5(b) (plan §12.2(6), §7 P5): the turn-completion hook decision, pure.
// Seam evidence: agent-route-frame-plugin.mjs:241 initializes continuation
// null and only schedules at :396 when a continue-turn supplied one — so a
// scripted agent going silent ended its run (the §12.1(a) complaint).
// end-turn marks state.finalized = true (agent-loop-tools.mjs:51), which is
// the legitimate-exit signal until P5(c) gates the tool itself.

const SCRIPTED = { id: 'a1', behaviorScript: 'SCRIPT coordinator_v6 ... END' };
const UNSCRIPTED = { id: 'a2', behaviorScript: '' };

test('scripted agent going silent gets a re-wake continuation', () => {
  let continuation = resolveTurnCompletionContinuation({
    agent: SCRIPTED,
    continuation: null,
    finalized: false,
  });
  assert.ok(continuation, 'expected a re-wake continuation, got null');
  assert.equal(typeof continuation.continuationPrompt, 'string');
  assert.ok(continuation.continuationPrompt.length > 0);
  assert.equal(continuation.delayMs, 0);
});

test('unscripted agents keep the legacy silent end', () => {
  assert.equal(
    resolveTurnCompletionContinuation({ agent: UNSCRIPTED, continuation: null, finalized: false }),
    null,
  );
  assert.equal(
    resolveTurnCompletionContinuation({ agent: undefined, continuation: null, finalized: false }),
    null,
  );
});

test('end-turn (finalized) still stops — exits outrank the re-wake', () => {
  assert.equal(
    resolveTurnCompletionContinuation({ agent: SCRIPTED, continuation: null, finalized: true }),
    null,
  );
});

test('an existing continue-turn continuation passes through untouched', () => {
  let existing = { nextAction: 'next stroke', delayMs: 250 };
  assert.equal(
    resolveTurnCompletionContinuation({ agent: SCRIPTED, continuation: existing, finalized: false }),
    existing,
  );
});

// P5(c) — the end-turn gate (plan §12.1, §12.2(8)): a scripted agent may
// not end its turn until the script says so. Allowed exits are exactly the
// model-callable harness overrides: blocked-on-upstream yield, fatal error.
// task-complete/done is retired until done-semantics exist; step-complete
// rides continue-turn progress frames (§12.6).

test('P5(c): scripted end-turn with no permitted reason is refused with the §12.1 message', () => {
  let message = refuseScriptedEndTurn({
    agent: {
      behaviorScript: 'SCRIPT coordinator_v6 ... END',
      behaviorScriptPC: { phase: '4_implement', lap: 2, updatedAt: 'x' },
    },
    reason: '',
  });
  assert.equal(typeof message, 'string', 'expected a refusal message');
  assert.match(message, /not complete/i);
  assert.match(message, /4_implement/);
  assert.match(message, /question-create/);
  assert.match(message, /continue/i);
});

test('P5(c): done and step-complete are refused for scripted agents', () => {
  let agent = { behaviorScript: 'SCRIPT x ... END', behaviorScriptPC: { phase: '5_prove', lap: 1 } };
  for (let reason of [ 'done', 'task-complete', 'step-complete', 'nonsense' ])
    assert.equal(typeof refuseScriptedEndTurn({ agent, reason }), 'string', `reason ${reason} must refuse`);
});

test('P5(c): blocked and error remain permitted overrides', () => {
  let agent = { behaviorScript: 'SCRIPT x ... END', behaviorScriptPC: { phase: '4_implement', lap: 1 } };
  assert.equal(refuseScriptedEndTurn({ agent, reason: 'blocked' }), null);
  assert.equal(refuseScriptedEndTurn({ agent, reason: 'error' }), null);
});

test('P5(c): unscripted agents are never refused', () => {
  assert.equal(refuseScriptedEndTurn({ agent: { behaviorScript: '' }, reason: '' }), null);
  assert.equal(refuseScriptedEndTurn({ agent: undefined, reason: 'done' }), null);
});

test('P5(c): legacy text-only scripts (PC null) are refused with generic phase wording', () => {
  let message = refuseScriptedEndTurn({ agent: { behaviorScript: 'SCRIPT legacy ... END' }, reason: '' });
  assert.equal(typeof message, 'string');
  assert.match(message, /behaviorScript/i);
});
