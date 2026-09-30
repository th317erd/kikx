'use strict';

import { normalizeOptionalString } from './normalize.mjs';

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
  return [
    `Your scheduled respond-and-continue prompt has fired for ${agent.name || agent.id}.`,
    continuationPrompt,
    priorText ? `Your previous visible response was:\n${priorText}` : '',
    'Decide whether to use tools, respond visibly, schedule another continuation, or stay silent.',
  ].filter(Boolean).join('\n\n');
}
