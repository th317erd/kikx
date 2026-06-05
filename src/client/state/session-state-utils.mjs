'use strict';

export function createSessionStateSnapshot(input = {}) {
  return {
    sessionIDs: Array.isArray(input.sessionIDs) ? [ ...input.sessionIDs ] : [],
    sessionDetailsByID: { ...(input.sessionDetailsByID || {}) },
    framesBySessionID: { ...(input.framesBySessionID || {}) },
  };
}

export function mergeSessions(state, nextSessions) {
  let snapshot = createSessionStateSnapshot(state);
  let sessionIDs = [];
  let sessionDetailsByID = {};

  for (let session of Array.isArray(nextSessions) ? nextSessions : []) {
    if (!session?.id)
      continue;

    let previous = snapshot.sessionDetailsByID[session.id] || {};
    sessionIDs.push(session.id);
    sessionDetailsByID[session.id] = mergeSessionDetail(previous, session);
  }

  return {
    ...snapshot,
    sessionIDs,
    sessionDetailsByID,
  };
}

export function upsertSessionState(state, session) {
  let snapshot = createSessionStateSnapshot(state);
  if (!session?.id)
    return snapshot;

  let sessionIDs = snapshot.sessionIDs.includes(session.id)
    ? snapshot.sessionIDs
    : [ session.id, ...snapshot.sessionIDs ];

  return {
    ...snapshot,
    sessionIDs,
    sessionDetailsByID: {
      ...snapshot.sessionDetailsByID,
      [session.id]: mergeSessionDetail(snapshot.sessionDetailsByID[session.id], session),
    },
  };
}

export function setSessionFramesState(state, sessionID, frames) {
  let snapshot = createSessionStateSnapshot(state);
  let safeFrames = sortFrames(Array.isArray(frames) ? [ ...frames ] : []);
  let next = {
    ...snapshot,
    framesBySessionID: {
      ...snapshot.framesBySessionID,
      [sessionID]: safeFrames,
    },
  };

  if (!sessionID)
    return next;

  let previous = snapshot.sessionDetailsByID[sessionID];
  if (!previous)
    return next;

  return {
    ...next,
    sessionDetailsByID: {
      ...next.sessionDetailsByID,
      [sessionID]: {
        ...previous,
        messageCount: typeof previous.messageCount === 'number'
          ? previous.messageCount
          : countMessageFrames(safeFrames),
      },
    },
  };
}

export function upsertFrameState(state, sessionID, frame) {
  let snapshot = createSessionStateSnapshot(state);
  if (!sessionID || !frame?.id)
    return snapshot;

  let frames = snapshot.framesBySessionID[sessionID] || [];
  let normalizedFrame = normalizeLiveFrame(frame);
  if (isResponseFramePhantom(normalizedFrame))
    return upsertResponseFramePhantom(snapshot, sessionID, frames, normalizedFrame);

  let transitionFrames = removeFramesForLiveTransition(frames, normalizedFrame);
  let existingIndex = transitionFrames.findIndex((candidate) => candidate?.id === normalizedFrame.id);

  if (normalizedFrame.type === 'EndTyping')
    return setSessionFramesState(snapshot, sessionID, transitionFrames);

  let nextFrame = {
    ...normalizedFrame,
    hidden: normalizedFrame.hidden ?? false,
  };

  if (existingIndex !== -1 && isPlainObject(nextFrame.content))
    nextFrame.content = mergeContent(transitionFrames[existingIndex]?.content || {}, nextFrame.content);

  if (normalizedFrame.phantom && LIVE_VISIBLE_PHANTOM_TYPES.has(normalizedFrame.type))
    nextFrame.hidden = false;

  let nextFrames = existingIndex === -1
    ? [ ...transitionFrames, nextFrame ]
    : transitionFrames.map((candidate, index) => index === existingIndex ? nextFrame : candidate);

  return setSessionFramesState(snapshot, sessionID, nextFrames);
}

export function countMessageFrames(frames) {
  return (Array.isArray(frames) ? frames : []).filter((frame) => frame?.type === 'UserMessage').length;
}

function mergeSessionDetail(previous = {}, next = {}) {
  let merged = {
    ...previous,
    ...next,
  };

  if (typeof next.messageCount !== 'number' && typeof previous.messageCount === 'number')
    merged.messageCount = previous.messageCount;

  return merged;
}

function normalizeLiveFrame(frame) {
  if (frame?.type === 'BeginTyping' || frame?.type === 'EndTyping') {
    let agentID = frame.authorID || frame.content?.agentID || 'default';
    return {
      ...frame,
      id: `typing:${agentID}`,
      authorID: agentID,
      hidden: false,
    };
  }

  if (frame?.phantom && frame.groupID)
    return { ...frame, id: frame.groupID };

  return frame;
}

function removeFramesForLiveTransition(frames, frame) {
  if (!Array.isArray(frames))
    return [];

  if (frame.type === 'EndTyping')
    return frames.filter((candidate) => candidate?.id !== frame.id);

  if (frame.type === 'AgentMessage')
    return frames.filter((candidate) => {
      if (!candidate)
        return false;

      if (candidate.id === frame.id)
        return true;

      if (candidate.parentID !== frame.parentID)
        return true;

      return candidate.type !== 'AgentThinking' && candidate.type !== 'AgentMessageDelta';
    });

  return frames.slice();
}

function isResponseFramePhantom(frame) {
  return frame?.phantom === true
    && typeof frame.responseFrameID === 'string'
    && frame.responseFrameID.trim() !== ''
    && (frame.type === 'AgentThinking' || frame.type === 'AgentMessageDelta');
}

function upsertResponseFramePhantom(snapshot, sessionID, frames, frame) {
  let responseFrameID = frame.responseFrameID.trim();
  let transitionFrames = removeResponseFramePhantoms(frames, frame);
  let existingIndex = transitionFrames.findIndex((candidate) => candidate?.id === responseFrameID);
  let existing = existingIndex === -1 ? null : transitionFrames[existingIndex];
  let nextFrame = mergeResponseFramePhantom(existing, frame, responseFrameID);
  let nextFrames = existingIndex === -1
    ? [ ...transitionFrames, nextFrame ]
    : transitionFrames.map((candidate, index) => index === existingIndex ? nextFrame : candidate);

  return setSessionFramesState(snapshot, sessionID, nextFrames);
}

function removeResponseFramePhantoms(frames, frame) {
  if (!Array.isArray(frames))
    return [];

  let responseFrameID = frame.responseFrameID;
  return frames.filter((candidate) => {
    if (!candidate)
      return false;

    if (candidate.id === frame.id && candidate.id !== responseFrameID)
      return false;

    if (candidate.phantom && candidate.responseFrameID === responseFrameID && candidate.id !== responseFrameID)
      return false;

    return true;
  });
}

function mergeResponseFramePhantom(existing, frame, responseFrameID) {
  let content = mergeContent(existing?.content || {}, responseFramePhantomContent(frame));
  let hasOutputText = typeof content.text === 'string' && content.text.length > 0;
  let shouldShow = frame.type === 'AgentMessageDelta' || existing?.hidden === false || hasOutputText;

  return {
    ...(existing || {}),
    id: responseFrameID,
    type: existing?.type || 'AgentMessage',
    sessionID: existing?.sessionID || frame.sessionID,
    interactionID: existing?.interactionID || frame.interactionID,
    parentID: existing?.parentID ?? frame.parentID ?? null,
    authorType: existing?.authorType || frame.authorType || 'agent',
    authorID: existing?.authorID || frame.authorID || frame.content?.agentID || null,
    order: existing?.order ?? frame.order,
    commitOrder: existing?.commitOrder ?? frame.commitOrder,
    timestamp: existing?.timestamp || frame.timestamp,
    createdAt: existing?.createdAt || frame.createdAt,
    updatedAt: frame.updatedAt || existing?.updatedAt,
    createdClock: existing?.createdClock || frame.createdClock,
    updatedClock: frame.updatedClock || existing?.updatedClock,
    hidden: shouldShow ? false : existing?.hidden ?? true,
    deleted: existing?.deleted ?? frame.deleted ?? false,
    phantom: false,
    responseFrameID,
    content,
  };
}

function responseFramePhantomContent(frame) {
  let content = frame.content || {};

  if (frame.type === 'AgentThinking') {
    return {
      thinking: content.thinking || {
        text: content.text || '',
        status: 'streaming',
      },
    };
  }

  if (frame.type === 'AgentMessageDelta') {
    return {
      ...content,
      status: content.status || 'streaming',
    };
  }

  return content;
}

function mergeContent(previous, patch) {
  let output = { ...previous };

  for (let [key, value] of Object.entries(patch || {})) {
    if (isPlainObject(value) && isPlainObject(output[key]))
      output[key] = mergeContent(output[key], value);
    else
      output[key] = value;
  }

  return output;
}

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

const LIVE_VISIBLE_PHANTOM_TYPES = new Set([
  'AgentThinking',
  'AgentMessageDelta',
]);

function sortFrames(frames) {
  return frames
    .map((frame, index) => ({ frame, index }))
    .sort((a, b) => {
      let order = compareFrameOrder(a.frame, b.frame);
      if (order !== 0)
        return order;

      return a.index - b.index;
    })
    .map((entry) => entry.frame);
}

function compareFrameOrder(a, b) {
  return compareNumber(liveSortWeight(a), liveSortWeight(b))
    || compareClock(sortUpdatedClock(a), sortUpdatedClock(b))
    || compareNumber(sortUpdatedAt(a), sortUpdatedAt(b))
    || compareClock(a?.createdClock, b?.createdClock)
    || compareNumber(a?.createdAt, b?.createdAt)
    || compareNumber(sortCommitOrder(a), sortCommitOrder(b))
    || compareNumber(a?.order, b?.order)
    || String(a?.id || '').localeCompare(String(b?.id || ''));
}

function liveSortWeight(frame) {
  return frame?.type === 'BeginTyping' ? 1 : 0;
}

function sortUpdatedClock(frame) {
  return stringOr(frame?.updatedClock, frame?.createdClock);
}

function sortUpdatedAt(frame) {
  return numberOr(frame?.updatedAt, frame?.createdAt || 0);
}

function sortCommitOrder(frame) {
  if (typeof frame?.commitOrder === 'number' && Number.isFinite(frame.commitOrder))
    return frame.commitOrder;

  if (typeof frame?.order === 'number' && Number.isFinite(frame.order))
    return frame.order;

  return Number.MAX_SAFE_INTEGER;
}

function compareClock(a, b) {
  if (!a || !b)
    return 0;

  if (a && b && a !== b)
    return String(a).localeCompare(String(b));

  return 0;
}

function compareNumber(a, b) {
  let left = (typeof a === 'number' && Number.isFinite(a)) ? a : 0;
  let right = (typeof b === 'number' && Number.isFinite(b)) ? b : 0;
  return left - right;
}

function numberOr(value, fallback) {
  return (typeof value === 'number' && Number.isFinite(value)) ? value : fallback;
}

function stringOr(value, fallback = null) {
  return (typeof value === 'string' && value.trim() !== '') ? value : fallback;
}
