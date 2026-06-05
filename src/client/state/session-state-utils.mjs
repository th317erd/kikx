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
  let safeFrames = Array.isArray(frames) ? [ ...frames ] : [];
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
  let existingIndex = frames.findIndex((candidate) => candidate?.id === frame.id);
  let nextFrames = existingIndex === -1
    ? [ ...frames, frame ]
    : frames.map((candidate, index) => index === existingIndex ? frame : candidate);

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
