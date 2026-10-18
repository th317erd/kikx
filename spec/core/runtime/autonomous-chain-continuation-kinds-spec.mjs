'use strict';

// Regression guard for the coupling the ask-user plan calls out (§5.3 / D-9).
//
// `AUTONOMOUS_CONTINUATION_KINDS` is the fail-safe for self-triggered turn
// chains. A user answering a question must *steer* an in-flight agent or *wake*
// a resting one; it must never be classified as an autonomous continuation, or
// the agent keeps self-driving after the human has taken the wheel — and
// `cancelAutonomousWakes` (frame-runtime-sessions.mjs:24) would start treating
// human input as something it is allowed to retire.
//
// The pre-existing assertions in `autonomous-chain-spec.mjs` use
// `.includes(kind) === true`, which cannot detect an *additional* kind. These
// assertions pin the whole list, so adding `'user-answer'` (or anything else)
// fails here rather than silently widening the fail-safe.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  AUTONOMOUS_CONTINUATION_KINDS,
  isAutonomousContinuation,
} from '../../../src/core/runtime/autonomous-chain.mjs';

const USER_ANSWER_KIND = 'user-answer';
const QUESTION_WAKE_PATH = new URL('../../../src/core/questions/question-wake.mjs', import.meta.url);

test('AUTONOMOUS_CONTINUATION_KINDS is exactly the known set', () => {
  // Pinned as a whole list, not as individual `includes` probes: the hazard is
  // silent *growth* of this set, which `includes` assertions cannot see.
  assert.deepEqual(
    [ ...AUTONOMOUS_CONTINUATION_KINDS ],
    [
      'exec-wake-on-completion',
      'send',
      // Legacy pre-rename kind; tolerated on read so cancel paths retire old frames.
      'agent-respond-and-continue',
    ],
  );
});

test('a user answer is never an autonomous continuation', () => {
  assert.equal(
    AUTONOMOUS_CONTINUATION_KINDS.includes(USER_ANSWER_KIND),
    false,
    `'${USER_ANSWER_KIND}' must not appear in AUTONOMOUS_CONTINUATION_KINDS: a human ` +
    'answer steers or wakes an agent, it is not self-triggered work. Adding it would let ' +
    'cancelAutonomousWakes retire human input and let the chain fail-safe miscount it.',
  );

  assert.equal(isAutonomousContinuation({ kind: USER_ANSWER_KIND }), false);
  // The predicate must not be fooled by shape: a user-answer continuation still
  // carries questionID/groupID and so is a well-formed continuation object.
  assert.equal(
    isAutonomousContinuation({
      kind: USER_ANSWER_KIND,
      questionID: 'q-1',
      groupID: 'g-1',
      targetAgentID: 'ag-1',
    }),
    false,
  );
});

test('the kind emitted by question-wake is the kind this guard protects', () => {
  // Couples the guard to the real producer instead of a hard-coded literal that
  // could drift away from the wake service while still passing.
  const source = readFileSync(QUESTION_WAKE_PATH, 'utf8');
  const kinds = [ ...source.matchAll(/kind:\s*'([^']+)'/g) ].map((match) => match[1]);

  assert.ok(kinds.length > 0, 'question-wake.mjs should emit a continuation kind');
  assert.ok(
    kinds.includes(USER_ANSWER_KIND),
    `question-wake.mjs should emit kind '${USER_ANSWER_KIND}', found: ${JSON.stringify(kinds)}`,
  );

  // Every continuation kind the wake service emits must sit outside the
  // autonomous set, so a future second wake path cannot smuggle one in.
  for (let kind of kinds) {
    assert.equal(
      AUTONOMOUS_CONTINUATION_KINDS.includes(kind),
      false,
      `question-wake.mjs emits '${kind}', which is classified as autonomous`,
    );
  }
});
