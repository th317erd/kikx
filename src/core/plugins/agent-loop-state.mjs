'use strict';

import { AVOIDABLE_DEFERRAL_PATTERNS } from './agent-tool-definitions.mjs';
import {
  normalizeContinuationRequest,
  normalizeForwardTargets,
  normalizeOptionalPromptString,
  normalizeToolResponseContent,
} from './agent-normalizers.mjs';

export function createLoopState() {
  return {
    break: false,
    nullResponse: false,
    finalized: false,
    forwarded: false,
    forwardDispatched: false,
    deferralGuarded: false,
    suppressFinalFrame: false,
    finalFrame: null,
    endTurnNotice: null,
    continuation: null,
    yieldedAgentMessage: false,
    forwards: [],
    usage: null,
  };
}

export function captureProviderDoneUsage(state, output) {
  if (output?.type !== 'Done')
    return;

  let usage = output.content?.usage;
  if (!usage || typeof usage !== 'object' || Array.isArray(usage))
    return;

  state.usage = state.usage ? sumProviderUsage(state.usage, usage) : { ...usage };
}

export function sumProviderUsage(left, right) {
  let result = { ...left };

  for (let [key, value] of Object.entries(right)) {
    if (typeof value === 'number' && Number.isFinite(value))
      result[key] = (typeof result[key] === 'number' ? result[key] : 0) + value;
    else if (result[key] === undefined)
      result[key] = value;
  }

  return result;
}

export function buildLoopDoneContent(state, content = {}) {
  return state.usage
    ? { ...content, usage: state.usage }
    : content;
}

// The closed terminal vocabulary a loop control may end in. Core owns every one of
// these; a plugin extension names its action but must map it onto one of these, so the
// loop's termination paths stay finite and auditable no matter what is installed.
//
//   finalize         - end the turn, optionally with a visible report
//   respond          - end the turn and schedule exactly one continuation
//   break            - stop the loop without a report
//   route            - forward to other agents and stop
//   null-response    - end silently, emitting no frame
//
// There is deliberately no "continue indefinitely" or "wake later" terminal.
export const LOOP_CONTROL_TERMINALS = Object.freeze(new Set([
  'finalize',
  'respond',
  'break',
  'route',
  'null-response',
]));

// Actions the loop already understands. A plugin may not register these names: the
// core's own controls are not replaceable, only extendable.
export const CORE_LOOP_CONTROL_ACTIONS = Object.freeze(new Set([
  'finalize',
  'respond-and-continue',
  'null-response',
  'break',
  'route',
  'forward',
]));

// Apply a terminal state on behalf of a declared control. Kept separate from
// handleLoopControl so the core mapping stays a plain, readable switch and the plugin
// path has exactly one place to be validated.
function applyLoopControlTerminal(terminal, output, state) {
  switch (terminal) {
    case 'finalize':
      state.finalized = true;
      state.continuation = null;
      state.finalFrame = {
        type: 'AgentMessage',
        content: normalizeToolResponseContent(output.content),
      };
      return true;
    case 'respond':
      state.finalized = true;
      state.continuation = normalizeContinuationRequest(output.continuation || output.content);
      state.finalFrame = {
        type: 'AgentMessage',
        content: normalizeToolResponseContent(output.content),
      };
      return true;
    case 'break':
      state.break = true;
      return true;
    case 'null-response':
      state.nullResponse = true;
      return true;
    case 'route':
      recordForward(state, {
        targets: normalizeForwardTargets(output.targets || output.target),
        remove: normalizeForwardTargets(output.remove),
        message: output.message || output.note,
      });
      return true;
    default:
      return false;
  }
}

// Returns true when the output was a loop control the loop understood and applied.
//
// options.resolveTerminal maps a plugin-declared action to its terminal state; without
// it only the core actions are recognised. A false return is NOT permission to fall
// through - the caller treats an unrecognised control as a hard stop, because ignoring
// it would let a buggy or hostile control keep the loop alive silently.
export function handleLoopControl(output, state, options = {}) {
  if (!output || output.type !== 'LoopControl')
    return false;

  if (output.action === 'finalize') {
    state.finalized = true;
    state.continuation = null;
    state.finalFrame = {
      type: 'AgentMessage',
      content: normalizeToolResponseContent(output.content),
    };
    return true;
  }

  if (output.action === 'respond-and-continue') {
    state.finalized = true;
    state.continuation = normalizeContinuationRequest(output.continuation || output.content);
    state.finalFrame = {
      type: 'AgentMessage',
      content: normalizeToolResponseContent(output.content),
    };
    return true;
  }

  if (output.action === 'null-response') {
    state.nullResponse = true;
    return true;
  }

  if (output.action === 'break') {
    state.break = true;
    return true;
  }

  if (output.action === 'forward' || output.action === 'route') {
    recordForward(state, {
      targets: normalizeForwardTargets(output.targets || output.target),
      remove: normalizeForwardTargets(output.remove),
      message: output.message || output.note,
    });
    return true;
  }

  // Plugin-declared extensions. The registry has already refused any terminal outside
  // LOOP_CONTROL_TERMINALS, so this can only apply a fixed, auditable outcome.
  let resolveTerminal = options?.resolveTerminal;
  if (typeof resolveTerminal === 'function') {
    let terminal = resolveTerminal(output.action);
    if (terminal)
      return applyLoopControlTerminal(terminal, output, state);
  }

  return false;
}

export function recordForward(state, forward) {
  state.forwarded = true;
  let normalized = {
    targets: normalizeForwardTargets(forward.targets || forward.target),
    remove: normalizeForwardTargets(forward.remove),
    message: forward.message || forward.note,
  };
  let key = JSON.stringify(normalized);
  if (!state.forwards.some((existing) => JSON.stringify(existing) === key))
    state.forwards.push(normalized);
}

export function mergeFinalizedProviderFrame(providerFrame, finalFrame) {
  if (!finalFrame?.content)
    return providerFrame;

  return {
    ...providerFrame,
    content: {
      ...(providerFrame.content && typeof providerFrame.content === 'object' && !Array.isArray(providerFrame.content)
        ? providerFrame.content
        : {}),
      ...(finalFrame.content && typeof finalFrame.content === 'object' && !Array.isArray(finalFrame.content)
        ? finalFrame.content
        : {}),
    },
  };
}

// When a visible user turn's draft is an "avoidable deferral" (asking the user
// whether to continue, or which obvious next step to take), we schedule an
// immediate self-continuation so the agent keeps working instead of stalling.
//
// Fix A: never REPLACE the visible answer. The original draft text is dropped
// from view (suppressed) rather than being swapped for a canned meta sentence —
// the user should either see the real answer from the continuation, or nothing
// yet, never a robotic "I'm going to continue…". Fires at most once per turn
// chain so a still-deferring continuation cannot loop.
export function applyAvoidableDeferralGuard(context = {}, state = {}) {
  if (state.continuation || state.deferralGuarded || !state.finalFrame?.content || !isVisibleUserTurn(context))
    return;

  let text = finalFrameText(state.finalFrame);
  if (!isAvoidableDeferralQuestion(text))
    return;

  state.deferralGuarded = true;
  state.suppressFinalFrame = true;
  state.continuation = {
    delayMs: 0,
    continuationPrompt: [
      'Your previous draft stopped to ask the user whether to continue or which obvious safe next step to take.',
      'The user expects you to infer the next safe implied step and continue without asking for permission.',
      'Continue now. Use tools if needed. Ask only if there is a real blocker, a destructive/risky action, or a genuinely important decision that cannot be inferred.',
    ].join(' '),
  };
}

export function isVisibleUserTurn(context = {}) {
  let frame = context.frame || {};
  return frame.authorType === 'user'
    && frame.hidden !== true
    && frame.deleted !== true;
}

export function finalFrameText(frame) {
  let content = frame?.content || {};
  return normalizeOptionalPromptString(content.text || content.markdown || content.html);
}

export function isAvoidableDeferralQuestion(text) {
  let value = normalizeOptionalPromptString(text);
  if (!value)
    return false;

  return AVOIDABLE_DEFERRAL_PATTERNS.some((pattern) => pattern.test(value));
}

export function isInternalStreamingOutput(output) {
  if (!output)
    return false;

  if (output.phantom === true)
    return true;

  return output.type === 'AgentThinking'
    || output.type === 'AgentMessageDelta'
    || output.type === 'BeginTyping'
    || output.type === 'EndTyping';
}
