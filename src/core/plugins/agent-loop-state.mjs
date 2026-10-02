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
    completionReviewed: false,
    deferralGuarded: false,
    suppressFinalFrame: false,
    finalFrame: null,
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

export function handleLoopControl(output, state) {
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

export function mergeCompletionReviewFrame(finalFrame, reviewFrame) {
  if (!reviewFrame?.content)
    return finalFrame;

  return {
    ...(finalFrame || {}),
    ...reviewFrame,
    content: {
      ...(finalFrame?.content && typeof finalFrame.content === 'object' && !Array.isArray(finalFrame.content)
        ? finalFrame.content
        : {}),
      ...(reviewFrame.content && typeof reviewFrame.content === 'object' && !Array.isArray(reviewFrame.content)
        ? reviewFrame.content
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

export function isCompletionReviewMetaResponseContent(content = {}) {
  let text = normalizeOptionalPromptString(content.text || content.markdown || content.html);
  if (!text)
    return false;

  let prefix = text.slice(0, 240).toLowerCase();
  return (
    prefix.includes('self-review')
    || prefix.includes('self review')
    || prefix.includes('completion self-review')
    || prefix.includes('audit of the draft')
  )
    && /(?:have i completed|what did i miss|what did i forget|what could i have done better|requested tasks)/i.test(text);
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
