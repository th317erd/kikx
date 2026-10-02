'use strict';

import { isStartBriefText } from './agent-precepts.mjs';

// Model-aware token budgeting and trim-from-end for provider requests.
//
// Kikx assembles prompts with no regard for the model's context window. Small
// local models (for example a llama-server started with `--ctx-size 32768`)
// then reject a request with HTTP 400 once history plus the current prompt plus
// tool schemas exceed the window. This module is the pure, testable decision
// layer every provider uses to keep a request inside the window:
//
//   - estimate token counts (chars/4 fallback, matching AgentInterface),
//   - compute an available input budget from the context window,
//   - trim the OLDEST non-protected messages first.
//
// It is deliberately side-effect free and deterministic so it can be unit
// tested without a provider or a server. Nothing here mutates the input.

const DEFAULT_CHARS_PER_TOKEN = 4;

// Rough token estimate for a block of text. Mirrors
// AgentInterface.estimateTokens so a provider and this module agree.
export function estimateTokens(text) {
  let value = typeof text === 'string' ? text : JSON.stringify(text ?? '');
  return Math.max(1, Math.ceil(value.length / DEFAULT_CHARS_PER_TOKEN));
}

// Available input token budget for a model request.
//
// `contextWindow` is the total window (input + output). We subtract:
//   - `toolsChars` (serialized tool schemas, re-estimated at chars/4),
//   - `reserveChars` (provider-specific fixed overhead such as tool schemas or
//     the prompt scaffolding),
//   - `promptReserveTokens` (a safety margin for the completion-review prompt),
//   - `maxOutputTokens` (space the model needs for its own completion).
//
// Returns a non-negative integer; an unknown context window falls back to the
// provided `defaultContextWindow`.
export function budgetForModel({
  contextWindow,
  toolsChars = 0,
  reserveChars = 0,
  promptReserveTokens = 0,
  maxOutputTokens = 0,
  defaultContextWindow = 32768,
} = {}) {
  let window = normalizePositiveInteger(contextWindow, normalizePositiveInteger(defaultContextWindow, 32768));
  let outputReserve = normalizeNonNegativeInteger(maxOutputTokens, 0);
  let promptReserve = normalizeNonNegativeInteger(promptReserveTokens, 0);
  let schemaTokens = Math.ceil(normalizeNonNegativeInteger(toolsChars, 0) / DEFAULT_CHARS_PER_TOKEN)
    + Math.ceil(normalizeNonNegativeInteger(reserveChars, 0) / DEFAULT_CHARS_PER_TOKEN);
  let available = window - schemaTokens - promptReserve - outputReserve;
  return Math.max(0, Math.trunc(available));
}

// Trim a message list to fit `budgetTokens`, dropping the OLDEST non-protected
// messages first.
//
// Guarantees (this is the owner constraint — "trim from the end; I'd rather
// trim off preamble than the user's message"):
//   - the `system` message is always kept,
//   - the newest `user` message is always kept (the current trigger),
//   - the last `keepRecent` messages (default 2) are always kept,
//   - any `protectedRoles`/`protectedIndexes` entries are always kept.
//
// The protected set is a prefix-relative suffix: only messages that are NOT
// protected may be dropped, and they are dropped from the oldest end of the
// non-protected prefix. Returns `{ messages, trimmed, droppedCount }` where
// `trimmed` is a boolean and `droppedCount` is how many were removed. The input
// array is not mutated.
export function fitMessagesToBudget(messages, {
  budgetTokens,
  estimate = estimateTokens,
  protectedRoles = [ 'system' ],
  protectedIndexes = [],
  protectStartBrief = true,
  keepRecent = 2,
} = {}) {
  let list = Array.isArray(messages) ? messages.slice() : [];
  if (list.length === 0)
    return { messages: [], trimmed: false, droppedCount: 0 };

  let budget = normalizeNonNegativeInteger(budgetTokens, 0);
  let keep = normalizeNonNegativeInteger(keepRecent, 2);
  let total = countTokens(list, estimate);
  if (total <= budget)
    return { messages: list, trimmed: false, droppedCount: 0 };

  let protectedSet = buildProtectedSet(list, {
    protectedRoles,
    protectedIndexes,
    protectStartBrief,
    keepRecent: keep,
  });

  // Only the non-protected prefix can be trimmed. Walk oldest-first and drop
  // while the total still exceeds the budget.
  let dropped = new Set();
  let remaining = total;
  for (let index = 0; index < list.length; index++) {
    if (remaining <= budget)
      break;

    if (protectedSet.has(index))
      continue;

    // Do not trim past the newest user trigger even if it is not explicitly
    // protected: trimming works on the non-protected prefix only.
    if (isNewestUserIndex(list, index))
      continue;

    dropped.add(index);
    remaining -= estimateMessage(list[index], estimate);
  }

  if (dropped.size === 0)
    return { messages: list, trimmed: false, droppedCount: 0 };

  let next = list.filter((_message, index) => !dropped.has(index));
  return {
    messages: next,
    trimmed: true,
    droppedCount: dropped.size,
  };
}

// Serialized-size helper for provider tool schemas.
export function charsOf(value) {
  try {
    return JSON.stringify(value ?? '')?.length || 0;
  } catch (_error) {
    return 0;
  }
}

// Whether an item carries image/multimodal content that a text token estimate
// cannot capture. Providers can use this to be more conservative.
export function hasNonTextContent(message) {
  if (!message)
    return false;

  let content = message.content;
  if (Array.isArray(content))
    return content.some((part) => part && part.type && part.type !== 'input_text' && part.type !== 'text');

  return false;
}

function buildProtectedSet(list, { protectedRoles, protectedIndexes, protectStartBrief, keepRecent }) {
  let set = new Set();
  let roles = new Set(Array.isArray(protectedRoles) ? protectedRoles : [ protectedRoles ]);

  for (let index = 0; index < list.length; index++) {
    let message = list[index];
    if (message?.role && roles.has(message.role))
      set.add(index);
  }

  // The start brief is a large, once-per-(re)start user turn. Treat it as
  // non-trimmable like `system` so a small-context model never loses Brief A to
  // history trimming. Detected by its stable version banner so no extra marker
  // is needed on the provider message objects.
  if (protectStartBrief) {
    for (let index = 0; index < list.length; index++) {
      let message = list[index];
      if (message?.role === 'user' && isStartBriefText(message.content))
        set.add(index);
    }
  }

  for (let index of Array.isArray(protectedIndexes) ? protectedIndexes : []) {
    if (Number.isInteger(index) && index >= 0 && index < list.length)
      set.add(index);
  }

  // Always keep the newest N messages, regardless of role. This keeps the most
  // recent exchange (the current prompt and its immediate context) intact.
  for (let index = Math.max(0, list.length - keepRecent); index < list.length; index++)
    set.add(index);

  return set;
}

function isNewestUserIndex(list, index) {
  if (list[index]?.role !== 'user')
    return false;

  for (let cursor = list.length - 1; cursor > index; cursor--) {
    if (list[cursor]?.role === 'user')
      return false;
  }

  return true;
}

function countTokens(list, estimate) {
  let total = 0;
  for (let message of list)
    total += estimateMessage(message, estimate);

  return total;
}

function estimateMessage(message, estimate) {
  if (message == null)
    return 0;

  if (typeof message === 'string')
    return estimate(message);

  let content = message.content;
  if (Array.isArray(content))
    return estimate(content.map((part) => (typeof part === 'string' ? part : part?.text || '')).join('\n'));

  if (content != null)
    return estimate(content);

  // Non-chat item (for example an OpenAI Responses `function_call` or
  // `function_call_output`): estimate the whole payload, not just its content.
  let { role: _role, ...rest } = message;
  return estimate(rest);
}

function normalizePositiveInteger(value, fallback) {
  let number = Number(value);
  if (!Number.isFinite(number) || number < 1)
    return fallback;

  return Math.trunc(number);
}

function normalizeNonNegativeInteger(value, fallback) {
  let number = Number(value);
  if (!Number.isFinite(number) || number < 0)
    return fallback;

  return Math.trunc(number);
}
