'use strict';

// Pure helpers for the pinned "thinking" rack.
//
// The rack replaces the old inline thinking/streaming bubble. Two jobs:
//  1. `threadVisibleFrames` pulls live (streamed) frames OUT of the message list
//     so the thread never grows/collapses as an agent streams.
//  2. A small buffer (fed from the raw phantom events) collects each live
//     response's reasoning + streamed answer for the fixed per-agent panel,
//     because the state layer folds thinking/delta phantoms into the response
//     frame and loses the reasoning in the process.

const LIVE_FRAME_TYPES = new Set([
  'AgentThinking',
  'AgentMessageDelta',
  'BeginTyping',
  'EndTyping',
]);

export function isLiveThreadFrame(frame) {
  if (!frame || frame.hidden === true || frame.deleted === true)
    return false;

  if (LIVE_FRAME_TYPES.has(frame.type))
    return true;

  return frame.type === 'AgentMessage' && frame.content?.status === 'streaming';
}

// The frames the thread renders: visible, not deleted, and not live/streaming.
export function threadVisibleFrames(frames = []) {
  return frames.filter((frame) => (
    frame
    && frame.hidden !== true
    && frame.deleted !== true
    && !isLiveThreadFrame(frame)
  ));
}

function liveText(frame) {
  let content = frame?.content;
  if (!content)
    return '';

  if (typeof content.text === 'string')
    return content.text;

  return typeof content.delta === 'string' ? content.delta : '';
}

export function createThinkingBuffer() {
  return { order: [], byResponse: new Map() };
}

function responseIDFor(frame) {
  return frame.responseFrameID || frame.id;
}

// Apply one raw runtime frame to the buffer. Returns true when it changed.
export function applyThinkingFrame(buffer, frame) {
  if (!buffer || !frame?.id)
    return false;

  let type = frame.type;
  let responseID = responseIDFor(frame);

  // The response's AgentMessage stopped streaming: the turn is settling, so the
  // panel goes away (the completed message is a thread item).
  if (
    type === 'AgentMessage'
    && frame.content?.status !== 'streaming'
    && frame.hidden !== true
    && frame.deleted !== true
  )
    return removeThinking(buffer, responseID);

  let isLive = LIVE_FRAME_TYPES.has(type)
    || (type === 'AgentMessage' && frame.content?.status === 'streaming');
  if (!isLive)
    return false;

  let entry = buffer.byResponse.get(responseID);
  if (!entry) {
    entry = { id: responseID, agentID: '', name: '', thinking: '', answer: '' };
    buffer.byResponse.set(responseID, entry);
    buffer.order.push(responseID);
  }

  if (frame.content?.agentID)
    entry.agentID = frame.content.agentID;
  if (frame.content?.agentName)
    entry.name = frame.content.agentName;
  if (!entry.name && frame.authorDisplayName)
    entry.name = frame.authorDisplayName;

  let text = liveText(frame);
  if (text) {
    if (type === 'AgentThinking')
      entry.thinking = text;
    else if (type === 'AgentMessageDelta' || type === 'AgentMessage')
      entry.answer = text;
  }

  return true;
}

function removeThinking(buffer, responseID) {
  if (!buffer.byResponse.has(responseID))
    return false;

  buffer.byResponse.delete(responseID);
  buffer.order = buffer.order.filter((id) => id !== responseID);
  return true;
}

// Ordered list for the rack: [{ id, agentID, name, text }].
export function thinkingAgents(buffer) {
  if (!buffer)
    return [];

  let out = [];
  for (let id of buffer.order) {
    let entry = buffer.byResponse.get(id);
    if (!entry)
      continue;

    let text = [ entry.thinking, entry.answer ]
      .filter((part) => typeof part === 'string' && part.trim() !== '')
      .join('\n');

    out.push({
      id: entry.id,
      agentID: entry.agentID || '',
      name: entry.name || entry.agentID || 'Agent',
      text,
    });
  }

  return out;
}

// The most recent lines of the live text, for the fixed scrolling window.
export function thinkingLines(text, maxLines = 200) {
  let lines = String(text ?? '').split(/\r?\n/);
  if (Number.isInteger(maxLines) && maxLines >= 0 && lines.length > maxLines)
    lines = lines.slice(lines.length - maxLines);

  return lines;
}
