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
  let transitionFrames = removeFramesForLiveTransition(frames, normalizedFrame);
  let existingIndex = transitionFrames.findIndex((candidate) => candidate?.id === normalizedFrame.id);

  if (normalizedFrame.type === 'EndTyping')
    return setSessionFramesState(snapshot, sessionID, transitionFrames);

  let nextFrame = {
    ...normalizedFrame,
    hidden: normalizedFrame.hidden ?? false,
  };

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

const LIVE_VISIBLE_PHANTOM_TYPES = new Set([
  'AgentThinking',
  'AgentMessageDelta',
]);

function sortFrames(frames) {
  return frames
    .map((frame, index) => ({ frame, index }))
    .sort((a, b) => {
      let order = frameSortOrder(a.frame) - frameSortOrder(b.frame);
      if (order !== 0)
        return order;

      return a.index - b.index;
    })
    .map((entry) => entry.frame);
}

function frameSortOrder(frame) {
  if (typeof frame?.commitOrder === 'number' && Number.isFinite(frame.commitOrder))
    return frame.commitOrder;

  if (typeof frame?.order === 'number' && Number.isFinite(frame.order))
    return frame.order;

  return Number.MAX_SAFE_INTEGER;
}
