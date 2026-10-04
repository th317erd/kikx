'use strict';

// Shared mapping from Kikx frames to model chat turns.
//
// Every agent provider adapter (Ollama, OpenAI/Codex, future providers) needs
// the same "which frames become model turns, and as which role" decision. The
// decision now lives in the frame-type class hierarchy: each frame type maps
// itself to a neutral turn via `toAgentMessage()`. This module is the thin
// consumer that builds the typed frame and delegates, so a new frame type is
// handled once — and a plugin can override a frame type through the registry.
//
// Compaction frames are the motivating case: they are hidden from the UI but are
// the model's only memory of the turns they replaced, so they must be projected
// into the prompt even though they are hidden.

import { createTypedFrame } from '../frames/frame-types/create-typed-frame.mjs';
import { selectCompactionLevels } from '../compaction/compaction-summary.mjs';
import { shouldSendStartBrief, markStartBriefSent } from './agent-brief-state.mjs';
import {
  buildMessageBrief,
  buildStartBrief,
} from './agent-script-template.mjs';

export { isCompactionFrame } from '../frames/frame-types/frame-type-helpers.mjs';

const DEFAULT_SESSION_SYSTEM_PROMPT = 'You are an agent participating in a Kikx session. Use the cached session history as conversational memory. Respond only to the newest user message unless the user asks about prior context.';

export const SESSION_SYSTEM_PROMPT = DEFAULT_SESSION_SYSTEM_PROMPT;

// Resolve the text a provider should treat as the prompt for the current turn:
// an explicit prompt wins, else the triggering frame's text.
export function resolvePromptContent(params = {}) {
  if (typeof params.prompt === 'string' && params.prompt.trim() !== '')
    return params.prompt;

  if (typeof params.frame?.content?.text === 'string')
    return params.frame.content.text;

  return '';
}

// Map one frame to a neutral model turn `{ role, content }`, or null when the
// frame does not belong in the model context. The frame-type class owns the
// decision; an optional `options.registry` lets a plugin override the type.
export function frameToModelTurn(frame, options = {}) {
  let typed = createTypedFrame(frame, { registry: options.registry || null });
  return typed.toAgentMessage(options);
}

// Build the full ordered message list for a provider request (two-tier, P3):
//
//   [system]                        — stable session base
//   [Brief A as a user turn]        — ONLY when shouldSendStartBrief (P4)
//   [history…]                      — projected frame turns, trigger skipped
//   [Brief B as the final user turn]
//
// The trigger/message text appears exactly once, inside Brief B.
export function buildModelMessages(params = {}, options = {}) {
  let frames = Array.isArray(params.frames) ? params.frames : [];
  let messages = [];
  let currentFrameID = params.frame?.id || null;
  let currentAgentID = params.agent?.id || '';
  let systemPrompt = typeof options.systemPrompt === 'string' ? options.systemPrompt : DEFAULT_SESSION_SYSTEM_PROMPT;
  let isRawPrompt = params.rawPrompt === true || params.compaction === true || params.oneShot === true;
  // Which compaction priority levels this model's window can afford (P7). An
  // unknown window yields every level, so this never filters when unsure.
  let compactionLevels = selectCompactionLevels(resolveContextWindowTokens(params));

  messages.push({ role: 'system', content: systemPrompt });

  if (!isRawPrompt && shouldSendStartBrief(params).send) {
    let startBrief = buildStartBrief(params);
    if (startBrief.text.trim() !== '') {
      messages.push({ role: 'user', content: startBrief.text });
      markStartBriefSent(params);
    }
  }

  for (let frame of frames) {
    if (currentFrameID && frame?.id === currentFrameID)
      continue;

    let message = frameToModelTurn(frame, {
      currentAgentID,
      currentFrameID,
      registry: options.registry || null,
      compactionLevels,
    });
    if (message)
      messages.push(message);
  }

  // Raw-prompt mode: one-shot/compaction turns (P3) carry their own bespoke
  // prompt rather than a session message. Keep it as-is so the compaction
  // contract is preserved; only the normal agent turn gets Brief A + Brief B.
  if (isRawPrompt) {
    messages.push({ role: 'user', content: resolvePromptContent(params) });
    return messages;
  }

  let messageBrief = buildMessageBrief({ ...params, messageText: resolvePromptContent(params) });
  // A hidden/continuation frame must still carry its message. Providers fall back
  // to `frame.content.text` when the prompt is empty, so only substitute that
  // fallback when no brief text can be produced at all.
  let briefContent = messageBrief.text.trim() !== ''
    ? messageBrief.text
    : resolvePromptContent(params);
  messages.push({ role: 'user', content: briefContent });

  return messages;
}

// Total context window available to this request. Providers may pass a resolved
// window as `params.contextWindow`; otherwise the agent config override
// (`contextWindowTokens`) is used. Returns null when neither is known, which
// tells `selectCompactionLevels` not to filter.
export function resolveContextWindowTokens(params = {}) {
  for (let value of [ params.contextWindow, params.config?.contextWindowTokens ]) {
    if (value == null || value === '')
      continue;

    let number = Number(value);
    if (Number.isFinite(number) && number > 0)
      return number;
  }

  return null;
}
