'use strict';

import {
  countMessageFrames as countProjectedMessageFrames,
  projectFrameMessages,
  upsertFrameMessages,
} from '../../shared/frame-manager/frame-manager.mjs';

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
  let messages = projectFrameMessages(frames);
  let next = {
    ...snapshot,
    framesBySessionID: {
      ...snapshot.framesBySessionID,
      [sessionID]: messages,
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
        messageCount: mergeLoadedFrameCount(previous.messageCount, countMessageFrames(messages)),
      },
    },
  };
}

export function upsertFrameState(state, sessionID, frame) {
  let snapshot = createSessionStateSnapshot(state);
  if (!sessionID || !frame?.id)
    return snapshot;

  let messages = upsertFrameMessages(snapshot.framesBySessionID[sessionID] || [], [ frame ]);
  return setSessionFramesState(snapshot, sessionID, messages);
}

export function upsertFramesState(state, framesBySessionID) {
  let snapshot = createSessionStateSnapshot(state);
  let next = snapshot;

  for (let [sessionID, frames] of normalizeFrameBatch(framesBySessionID)) {
    let messages = upsertFrameMessages(next.framesBySessionID[sessionID] || [], frames);
    next = setSessionFramesState(next, sessionID, messages);
  }

  return next;
}

export function countMessageFrames(frames) {
  return countProjectedMessageFrames(frames);
}

function mergeLoadedFrameCount(previousCount, loadedFrameCount) {
  let loaded = Number.isFinite(loadedFrameCount) && loadedFrameCount > 0
    ? Math.trunc(loadedFrameCount)
    : 0;

  if (typeof previousCount === 'number' && Number.isFinite(previousCount) && previousCount >= 0)
    return Math.max(Math.trunc(previousCount), loaded);

  return loaded;
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

function normalizeFrameBatch(input) {
  if (!input || typeof input !== 'object')
    return [];

  if (input instanceof Map)
    return Array.from(input.entries())
      .filter(([sessionID, frames]) => typeof sessionID === 'string' && sessionID && Array.isArray(frames));

  return Object.entries(input)
    .filter(([sessionID, frames]) => typeof sessionID === 'string' && sessionID && Array.isArray(frames));
}
