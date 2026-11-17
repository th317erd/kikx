'use strict';

// P5(b) — turn-completion hook (plan §12.2(6)): "scheduler re-wake —
// silence does not escape the loop." Called at the route seam where a turn
// finishes (agent-route-frame-plugin.mjs, where continuation was only ever
// scheduled if the model itself called continue-turn).
//
// Rules, owner-approved 2026-11-16:
// - a continuation already supplied (continue-turn) is the model's own
//   answer and passes through untouched;
// - `finalized` (end-turn ran) still stops the turn — exits outrank the
//   re-wake until P5(c) gates end-turn itself;
// - unscripted agents keep legacy behavior (empty behaviorScript = legacy);
// - a scripted agent that simply went silent gets re-woken with an active
//   line; the scheduled wake prompt is already script-aware (P2), so this
//   continuation only needs direction and zero delay.

export const REWAKE_NEXT_ACTION =
  'Agentic Script execution is not complete: resume your behaviorScript '
  + 'at your current phase and proceed. If you have questions, ask the user '
  + 'with question-create, then continue.';

export function resolveTurnCompletionContinuation({ agent, continuation, finalized } = {}) {
  if (continuation)
    return continuation;
  if (finalized)
    return null;
  if (!agent?.behaviorScript)
    return null;
  return { continuationPrompt: REWAKE_NEXT_ACTION, delayMs: 0 };
}
