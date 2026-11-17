'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveTurnCompletionContinuation } from '../../../src/core/agents/turn-completion.mjs';

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
