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
// A completed tool call is represented by its result frame; rendering both
// repeats the command (and its output) as two adjacent cards. Hide the call
// only when its visible result is in the same window, so a running call remains
// visible until the result arrives.
export function threadVisibleFrames(frames = [], { includeDeleted = false } = {}) {
  let completedCallIDs = new Set();
  let completedCallFrameIDs = new Set();
  // `hidden` is system-only bookkeeping and is dropped unconditionally. `deleted`
  // is soft-deleted content the user may still want back, so it is dropped only
  // while the Deleted reveal is off.
  let isGated = (frame) => frame.hidden === true
    || (frame.deleted === true && includeDeleted !== true);

  for (let frame of frames) {
    if (!frame || isGated(frame) || !isToolResultFrame(frame))
      continue;

    let callID = frame.content?.toolCallID;
    let callFrameID = frame.content?.toolCallFrameID;
    if (typeof callID === 'string' && callID)
      completedCallIDs.add(callID);
    if (typeof callFrameID === 'string' && callFrameID)
      completedCallFrameIDs.add(callFrameID);
  }

  return frames.filter((frame) => {
    if (!frame || isGated(frame) || isLiveThreadFrame(frame))
      return false;

    if (isToolCallFrame(frame)) {
      if (completedCallFrameIDs.has(frame.id))
        return false;

      let callID = frame.content?.toolCallID;
      if (typeof callID === 'string' && completedCallIDs.has(callID))
        return false;
    }

    return true;
  });
}

// The frames the thread should render for one session: the visibility
// predicate above, then the popup's category filters on top. Both the initial
// build and every incremental sync go through here, so the two paths cannot
// disagree about what is on screen.
// What the thread renders.
//
// The server already applied the filter set when it chose this window, so this
// must NOT filter again: a second, partial pass over a loaded window would drop
// frames the server deliberately sent and make the two disagree. The one thing
// still enforced here is `hidden`, which is absolute — a system-only frame is
// never content, whatever the popup says, and this stays true even if a hidden
// frame reaches the client through an event rather than a window fetch.
export function threadRenderFrames(frames = []) {
  return threadVisibleFrames(frames, { includeDeleted: true });
}

// True when the session has frames a person could ever have seen, whether or
// not the current filters keep them. Distinguishes "nothing here yet" from
// "you filtered it away".
//
// Hidden frames are excluded on purpose: they are internal bookkeeping and can
// never be rendered. Soft-deleted frames DO count, because the Deleted row can
// bring them back - a session holding only deleted messages should say "no
// frames match the current filters", not "there is nothing here".
export function hasAnyFrames(frames = []) {
  return (Array.isArray(frames) ? frames : [])
    .some((frame) => frame && frame.hidden !== true);
}

function isToolCallFrame(frame) {
  return frame?.content?.phase === 'call' || frame?.type === 'ToolCall';
}

function isToolResultFrame(frame) {
  return frame?.content?.phase === 'result' || frame?.type === 'ToolResult';
}

function liveText(frame) {
  let content = frame?.content;
  if (!content)
    return '';

  if (typeof content.text === 'string')
    return content.text;

  return typeof content.delta === 'string' ? content.delta : '';
}

function normalizeID(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// Buffer keys are internal and include the session, so the same agent thinking
// in two sessions cannot share (or leak) one panel.
function ownerKey(sessionID, kind, id) {
  return `${sessionID}\u0000${kind}:${id}`;
}

export function createThinkingBuffer() {
  return { order: [], byResponse: new Map(), agentByResponse: new Map() };
}

// Resolve every live frame to a stable owner. BeginTyping carries both the
// response frame and the agent id, so record that link and use the agent id for
// that response's thinking/delta frames too. Different responses from the same
// agent therefore collapse into a single brain. The response id is also kept as
// a fallback so terminal frames can clear an entry created before the link was
// known (for example after a missed BeginTyping).
function resolveOwner(buffer, frame, fallbackSessionID = '') {
  let sessionID = typeof frame?.sessionID === 'string'
    ? frame.sessionID
    : (typeof fallbackSessionID === 'string' ? fallbackSessionID : '');
  let responseID = normalizeID(frame?.responseFrameID);
  let agentID = normalizeID(frame?.content?.agentID || frame?.authorID);
  let responseKey = responseID ? ownerKey(sessionID, 'response', responseID) : '';
  let agentKey = agentID ? ownerKey(sessionID, 'agent', agentID) : '';
  let mappedKey = responseKey ? buffer.agentByResponse.get(responseKey) || '' : '';

  if (responseKey && agentKey)
    buffer.agentByResponse.set(responseKey, agentKey);

  let key = agentKey
    || mappedKey
    || responseKey
    || ownerKey(sessionID, 'frame', normalizeID(frame?.id));
  let previousKey = mappedKey && mappedKey !== key ? mappedKey : '';
  if (agentKey && responseKey && buffer.byResponse.has(responseKey))
    previousKey = responseKey;

  return {
    sessionID,
    responseID,
    agentID,
    responseKey,
    agentKey,
    key,
    previousKey,
  };
}

// Apply one raw runtime frame to the buffer. Returns true when it changed.
export function applyThinkingFrame(buffer, frame, fallbackSessionID = '') {
  if (!buffer || !frame?.id)
    return false;

  let type = frame.type;
  let owner = resolveOwner(buffer, frame, fallbackSessionID);

  // These frames are terminal for the response, even when the provider emits no
  // visible final AgentMessage (an empty/silenced turn, an aborted request, ...).
  // Without this, a brain could stay on screen until a reload.
  if (
    type === 'EndTyping'
    || type === 'MessageDone'
    || type === 'AgentError'
    || (type === 'AgentMessage' && frame.content?.status !== 'streaming')
  )
    return removeThinking(buffer, owner);

  let isLive = LIVE_FRAME_TYPES.has(type)
    || (type === 'AgentMessage' && frame.content?.status === 'streaming');
  if (!isLive)
    return false;

  // A response that started before its BeginTyping link was known was keyed by
  // its response id. Fold that entry into the stable agent entry now.
  if (owner.previousKey)
    mergeOwner(buffer, owner.previousKey, owner.key);

  let entry = buffer.byResponse.get(owner.key);
  if (!entry) {
    entry = {
      id: owner.agentID || owner.responseID || frame.id,
      sessionID: owner.sessionID,
      agentID: owner.agentID,
      name: '',
      thinking: '',
      answer: '',
    };
    buffer.byResponse.set(owner.key, entry);
    buffer.order.push(owner.key);
  }

  // A new response for an agent starts a fresh panel; do not resurrect the
  // previous turn's reasoning/answer text.
  if (type === 'BeginTyping') {
    entry.thinking = '';
    entry.answer = '';
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

function mergeOwner(buffer, fromKey, toKey) {
  let from = buffer.byResponse.get(fromKey);
  if (!from)
    return false;

  let to = buffer.byResponse.get(toKey);
  if (!to) {
    buffer.byResponse.set(toKey, from);
    buffer.byResponse.delete(fromKey);
    buffer.order = buffer.order.map((id) => (id === fromKey ? toKey : id));
    return true;
  }

  if (!to.thinking && from.thinking)
    to.thinking = from.thinking;
  if (!to.answer && from.answer)
    to.answer = from.answer;
  if (!to.name && from.name)
    to.name = from.name;
  if (!to.agentID && from.agentID)
    to.agentID = from.agentID;

  buffer.byResponse.delete(fromKey);
  buffer.order = buffer.order.filter((id) => id !== fromKey);
  return true;
}

function removeThinking(buffer, owner) {
  let keys = new Set();
  if (owner.key)
    keys.add(owner.key);
  if (owner.agentID)
    keys.add(ownerKey(owner.sessionID, 'agent', owner.agentID));
  if (owner.responseID)
    keys.add(ownerKey(owner.sessionID, 'response', owner.responseID));
  if (owner.responseKey)
    keys.add(owner.responseKey);

  // Also catch an entry created before the response -> agent link existed, and
  // any alias for the same agent in this session.
  for (let [candidateKey, entry] of buffer.byResponse) {
    if (entry.sessionID !== owner.sessionID)
      continue;
    if ((owner.agentID && entry.agentID === owner.agentID) || (owner.responseID && entry.id === owner.responseID))
      keys.add(candidateKey);
  }

  let changed = false;
  for (let key of keys) {
    if (buffer.byResponse.delete(key))
      changed = true;
  }

  buffer.order = buffer.order.filter((id) => buffer.byResponse.has(id));

  // Drop response links that pointed at any removed owner so a later frame
  // cannot resurrect a stale brain.
  for (let [responseKey, mappedOwner] of buffer.agentByResponse) {
    if (keys.has(mappedOwner) || keys.has(responseKey))
      buffer.agentByResponse.delete(responseKey);
  }

  return changed;
}

// Ordered list for the rack: [{ id, agentID, sessionID, name, text }].
// Pass a sessionID to show only that session's agents; entries for the same
// agent are coalesced so a stale response alias cannot create a second brain.
export function thinkingAgents(buffer, sessionID = '') {
  if (!buffer)
    return [];

  let out = [];
  let byOwner = new Map();

  for (let key of buffer.order) {
    let entry = buffer.byResponse.get(key);
    if (!entry)
      continue;
    if (sessionID && entry.sessionID !== sessionID)
      continue;

    let text = [ entry.thinking, entry.answer ]
      .filter((part) => typeof part === 'string' && part.trim() !== '')
      .join('\n');
    let owner = `${entry.sessionID}\u0000${entry.agentID || entry.id}`;
    let existing = byOwner.get(owner);

    if (!existing) {
      existing = {
        id: entry.agentID || entry.id,
        agentID: entry.agentID || '',
        sessionID: entry.sessionID || '',
        name: entry.name || entry.agentID || 'Agent',
        text,
      };
      byOwner.set(owner, existing);
      out.push(existing);
      continue;
    }

    if (entry.name)
      existing.name = entry.name;
    if (text)
      existing.text = text;
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
