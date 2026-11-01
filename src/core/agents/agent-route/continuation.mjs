'use strict';

import { normalizeOptionalString } from './normalize.mjs';
import { BEHAVIOR_SCRIPT_FIELD } from '../script-limits.mjs';

const DEFAULT_CONTINUATION_DELAY_MS = 1000;
const DEFAULT_CONTINUATION_PROMPT = 'Please continue what you were doing.';

export { DEFAULT_CONTINUATION_DELAY_MS, DEFAULT_CONTINUATION_PROMPT };

export function normalizeContinuation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return null;

  return {
    delayMs: normalizeContinuationDelay(value.delayMs),
    continuationPrompt: normalizeOptionalString(value.continuationPrompt || value.prompt || value.reason || value.message) || DEFAULT_CONTINUATION_PROMPT,
  };
}

export function normalizeContinuationDelay(value) {
  if (value == null || value === '')
    return DEFAULT_CONTINUATION_DELAY_MS;

  let number = Number(value);
  if (!Number.isFinite(number) || number < 0)
    return DEFAULT_CONTINUATION_DELAY_MS;

  return Math.trunc(number);
}

export function buildContinuationPromptText({ agent, responseFrame, continuation }) {
  let priorText = normalizeOptionalString(responseFrame?.content?.text);
  let continuationPrompt = normalizeOptionalString(continuation.continuationPrompt) || DEFAULT_CONTINUATION_PROMPT;
  let behaviorScript = normalizeOptionalString(agent?.[BEHAVIOR_SCRIPT_FIELD]);
  let scriptWake = behaviorScript !== ''
    ? 'Your behaviorScript is active: verify this wake against your todo list, execute the stroke your todo focus selects, then your script\'s sync step. Follow the script\'s exits — end the turn with a reason — rather than stalling; questions never stop the loop.'
    : '';
  return [
    `Your scheduled respond-and-continue prompt has fired for ${agent.name || agent.id}.`,
    continuationPrompt,
    priorText ? `Your previous visible response was:\n${priorText}` : '',
    scriptWake,
    'Take the next concrete step; if the work is now done or you are only waiting, end the turn rather than scheduling another continuation.',
  ].filter(Boolean).join('\n\n');
}
