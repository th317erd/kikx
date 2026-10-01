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

// Build the full ordered message list for a provider request: the session system
// prompt, every projected frame turn (skipping the current trigger frame), then
// the newest prompt as a final user message.
export function buildModelMessages(params = {}, options = {}) {
  let frames = Array.isArray(params.frames) ? params.frames : [];
  let messages = [];
  let currentFrameID = params.frame?.id || null;
  let currentAgentID = params.agent?.id || '';
  let systemPrompt = typeof options.systemPrompt === 'string' ? options.systemPrompt : DEFAULT_SESSION_SYSTEM_PROMPT;

  messages.push({ role: 'system', content: systemPrompt });

  for (let frame of frames) {
    if (currentFrameID && frame?.id === currentFrameID)
      continue;

    let message = frameToModelTurn(frame, {
      currentAgentID,
      currentFrameID,
      registry: options.registry || null,
    });
    if (message)
      messages.push(message);
  }

  messages.push({ role: 'user', content: resolvePromptContent(params) });

  return messages;
}
