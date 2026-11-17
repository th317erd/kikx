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

// P5(c) — end-turn gate (plan §12.1, §12.2(8)). Returns the refusal
// message when a scripted agent asks to end its turn without a permitted
// exit, or null when ending is allowed. Permitted = the model-callable
// harness overrides: blocked-on-upstream yield and fatal error. done /
// task-complete is retired until done-semantics exist; step-complete
// rides continue-turn progress frames (§12.6); absent reason = the old
// silent stop — exactly the §12.1(a) complaint.
const PERMITTED_SCRIPT_END_REASONS = new Set([ 'blocked', 'error' ]);

export function refuseScriptedEndTurn({ agent, reason } = {}) {
  if (typeof agent?.behaviorScript !== 'string' || agent.behaviorScript.trim() === '')
    return null;

  let normalizedReason = typeof reason === 'string' ? reason.trim() : '';
  if (PERMITTED_SCRIPT_END_REASONS.has(normalizedReason))
    return null;

  let phase = typeof agent.behaviorScriptPC?.phase === 'string' && agent.behaviorScriptPC.phase !== ''
    ? agent.behaviorScriptPC.phase
    : 'your behaviorScript (no compiled phase — legacy text script)';
  let shown = normalizedReason === '' ? 'none' : normalizedReason;

  return 'Agentic Script execution is not complete — you are at phase "'
    + phase
    + '", and end-turn reason "'
    + shown
    + '" is not a permitted exit (permitted: blocked, error). The script has no terminal exit yet. '
    + 'If you have questions, ask the user with the question-create tool, then continue.';
}
