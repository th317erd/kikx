'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AUTONOMOUS_CONTINUATION_KINDS,
  isAutonomousContinuation,
} from '../../../src/core/runtime/autonomous-chain.mjs';

test('isAutonomousContinuation recognises current and legacy continuation kinds', () => {
  assert.equal(isAutonomousContinuation({ kind: 'exec-wake-on-completion' }), true);
  assert.equal(isAutonomousContinuation({ kind: 'send' }), true);
  // Legacy pre-rename frames must still be recognised so the cancel/sweep paths
  // retire them instead of letting them fire.
  assert.equal(isAutonomousContinuation({ kind: 'agent-respond-and-continue' }), true);
  assert.equal(isAutonomousContinuation({ kind: 'user-scheduled' }), false);
  assert.equal(isAutonomousContinuation(null), false);
  assert.equal(AUTONOMOUS_CONTINUATION_KINDS.includes('agent-respond-and-continue'), true);
});
