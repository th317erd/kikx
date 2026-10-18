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
  return { order: [], byResponse: new Map(), agentByResponse: new Map() };
}

// One brain per agent: resolve every live frame to a stable owner. BeginTyping
// carries both the response frame and the agent id, so record that link and use
// the agent id for that response's thinking/delta frames too. Different responses
// from the same agent therefore collapse into a single brain.
function resolveOwnerID(buffer, frame) {
  let responseID = frame?.responseFrameID || null;
  let agentID = frame?.content?.agentID || frame?.authorID || null;

  if (responseID && agentID)
    buffer.agentByResponse.set(responseID, agentID);
  if (agentID)
    return agentID;
  if (responseID && buffer.agentByResponse.has(responseID))
    return buffer.agentByResponse.get(responseID);

  return responseID || frame?.id;
}

// Apply one raw runtime frame to the buffer. Returns true when it changed.
export function applyThinkingFrame(buffer, frame) {
  if (!buffer || !frame?.id)
    return false;

  let type = frame.type;
  let ownerID = resolveOwnerID(buffer, frame);

  // The response's AgentMessage stopped streaming: the turn is settling, so the
  // panel goes away (the completed message is a thread item).
  if (
    type === 'AgentMessage'
    && frame.content?.status !== 'streaming'
    && frame.hidden !== true
    && frame.deleted !== true
  )
    return removeThinking(buffer, ownerID);

  let isLive = LIVE_FRAME_TYPES.has(type)
    || (type === 'AgentMessage' && frame.content?.status === 'streaming');
  if (!isLive)
    return false;

  let entry = buffer.byResponse.get(ownerID);
  if (!entry) {
    entry = { id: ownerID, agentID: '', name: '', thinking: '', answer: '' };
    buffer.byResponse.set(ownerID, entry);
    buffer.order.push(ownerID);
  }

  if (frame.content?.agentID)
    entry.agentID = frame.content.agentID;
  else if (frame.authorID)
    entry.agentID = frame.authorID;
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

function removeThinking(buffer, ownerID) {
  let changed = false;
  if (buffer.byResponse.delete(ownerID)) {
    buffer.order = buffer.order.filter((id) => id !== ownerID);
    changed = true;
  }

  // Drop the response->agent links that pointed at this owner so a later frame
  // cannot resurrect a stale brain.
  for (let [responseID, agentID] of buffer.agentByResponse) {
    if (agentID === ownerID)
      buffer.agentByResponse.delete(responseID);
  }

  return changed;
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
