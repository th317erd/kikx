'use strict';

// Shared mapping from Kikx frames to model chat turns.
//
// Every agent provider adapter (Ollama, OpenAI/Codex, future providers) needs
// the same "which frames become model turns, and as which role" decision. It
// lives here, in core, so a new frame type is handled once instead of having to
// be taught to every adapter — an internal frame that an adapter does not know
// about must never silently vanish from the model context.
//
// Compaction frames are the motivating case: they are hidden from the UI but are
// the model's only memory of the turns they replaced, so they must be projected
// into the prompt even though they are hidden.

const DEFAULT_SESSION_SYSTEM_PROMPT = 'You are an agent participating in a Kikx session. Use the cached session history as conversational memory. Respond only to the newest user message unless the user asks about prior context.';

export const SESSION_SYSTEM_PROMPT = DEFAULT_SESSION_SYSTEM_PROMPT;

export function isCompactionFrame(frame) {
  return frame?.type === 'CompactionFrame' || frame?.content?.kind === 'compaction_frame';
}

export function normalizeAgentDisplayName(frame) {
  for (let value of [
    frame?.authorDisplayName,
    frame?.content?.agentName,
    frame?.authorID,
  ]) {
    if (typeof value === 'string' && value.trim() !== '')
      return value.trim();
  }

  return 'Agent';
}

export function escapeAttribute(value) {
  return String(value).replace(/[&"<>]/g, (char) => {
    if (char === '&')
      return '&amp;';

    if (char === '"')
      return '&quot;';

    if (char === '<')
      return '&lt;';

    return '&gt;';
  });
}

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
// frame does not belong in the model context. The compaction case is handled
// before the hidden guard on purpose.
export function frameToModelTurn(frame, options = {}) {
  if (!frame || frame.deleted)
    return null;

  if (isCompactionFrame(frame))
    return compactionFrameToTurn(frame);

  if (frame.hidden)
    return null;

  let text = frame.content?.text || frame.content?.html || '';
  if (typeof text !== 'string' || text.trim() === '')
    return null;

  if (frame.type === 'UserMessage')
    return { role: 'user', content: text };

  if (frame.type === 'AgentMessage') {
    if (!frame.authorID || frame.authorID === options.currentAgentID)
      return { role: 'assistant', content: text };

    let displayName = normalizeAgentDisplayName(frame);
    return {
      role: 'user',
      content: `<agent-message source="${escapeAttribute(frame.authorID)}" display-name="${escapeAttribute(displayName)}">${text}</agent-message>`,
    };
  }

  if (frame.type === 'CommandResult')
    return { role: 'user', content: `[System command result]\n${text}` };

  return null;
}

function compactionFrameToTurn(frame) {
  let summary = frame?.content?.summary || frame?.content?.text || '';
  if (typeof summary !== 'string' || summary.trim() === '')
    return null;

  return {
    role: 'user',
    content: `[Compacted context memory — earlier turns summarized]\n${summary}`,
  };
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

    let message = frameToModelTurn(frame, { currentAgentID, currentFrameID });
    if (message)
      messages.push(message);
  }

  messages.push({ role: 'user', content: resolvePromptContent(params) });

  return messages;
}
