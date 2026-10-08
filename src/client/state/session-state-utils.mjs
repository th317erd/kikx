'use strict';

import {
  countMessageFrames as countProjectedMessageFrames,
  projectFrameMessages,
  upsertFrameMessages,
} from '../../shared/frame-manager/frame-manager.mjs';

// Hard cap on the number of projected ("visual") messages held per session.
// Phantoms are already folded away by projection, so this bounds the live DOM:
// each retained message owns at most one UI element. Older pages are trimmed as
// the user scrolls up; the newest end is trimmed only when prepending, and the
// client refetches the newest window when the user scrolls back down.
export const MAX_SESSION_MESSAGES = 200;

// Add-only per-session caches (loaded frame windows, paging, previews) are
// bounded so a long-lived tab cannot grow without limit. These are caches, not
// user-visible state: the selected session is NEVER evicted, and a session that
// falls out is re-fetched on demand when the user opens it again.
export const MAX_CACHED_SESSION_FRAME_SETS = 40;
export const MAX_SESSION_PREVIEWS = 200;

export function createSessionStateSnapshot(input = {}) {
  return {
    sessionIDs: Array.isArray(input.sessionIDs) ? [ ...input.sessionIDs ] : [],
    sessionDetailsByID: { ...(input.sessionDetailsByID || {}) },
    framesBySessionID: { ...(input.framesBySessionID || {}) },
    sessionPagingByID: { ...(input.sessionPagingByID || {}) },
  };
}

// Bound the per-session frame windows and paging to `MAX_CACHED_SESSION_FRAME_SETS`
// sessions. `selectedSessionID` is always kept and moved to the end; the rest
// are kept in insertion order. This is deliberately NOT a true LRU: we do not
// track per-session access, so a session the user re-opens may already have been
// evicted and simply re-fetches on demand. That is safe because these windows
// and paging records are derived cache, never user-visible source of truth.
// Paging is retained only for sessions whose frames are still cached (there is
// nothing to page otherwise).
export function boundSessionFrameCaches(framesBySessionID = {}, sessionPagingByID = {}, selectedSessionID = '') {
  let frames = framesBySessionID && typeof framesBySessionID === 'object' ? framesBySessionID : {};
  let paging = sessionPagingByID && typeof sessionPagingByID === 'object' ? sessionPagingByID : {};
  let ids = Object.keys(frames);

  let ordered = selectedSessionID ? ids.filter((id) => id !== selectedSessionID) : ids.slice();
  if (selectedSessionID && Object.hasOwn(frames, selectedSessionID))
    ordered.push(selectedSessionID);

  let keep = new Set(ordered.slice(-MAX_CACHED_SESSION_FRAME_SETS));
  let boundedFrames = {};
  for (let id of ids) {
    if (keep.has(id))
      boundedFrames[id] = frames[id];
  }

  return {
    framesBySessionID: boundedFrames,
    sessionPagingByID: keepPagingFor(boundedFrames, paging),
  };
}

// Bound the preview cache: drop previews for sessions no longer in the live
// list (deleted elsewhere) and keep only the most recently fetched
// `MAX_SESSION_PREVIEWS` entries. Previews are derived, so an evicted entry is
// re-fetched on demand; the session card itself stays.
export function boundSessionPreviews(previewsByID = {}, sessionIDs = [], options = {}) {
  let max = Number.isInteger(options.max) ? options.max : MAX_SESSION_PREVIEWS;
  let live = new Set(Array.isArray(sessionIDs) ? sessionIDs : []);
  let entries = Object.entries(previewsByID && typeof previewsByID === 'object' ? previewsByID : {})
    .filter(([id]) => live.has(id));
  if (entries.length > max)
    entries = entries.slice(-max);

  let output = {};
  for (let [id, preview] of entries)
    output[id] = preview;

  return output;
}

function keepPagingFor(framesBySessionID, sessionPagingByID) {
  let output = {};
  for (let id of Object.keys(sessionPagingByID)) {
    if (Object.hasOwn(framesBySessionID, id))
      output[id] = sessionPagingByID[id];
  }

  return output;
}

// Soft-deleted sessions carry a `deletedAt` stamp but stay in the store. The
// client must never show one: the delete flow and the SSE `session.saved` frame
// both run through here so a second tab cannot resurrect a deleted card.
export function isDeletedSession(session) {
  return Boolean(session?.deletedAt);
}

// Return a new snapshot with the session's id, detail, frames, and paging all
// dropped. Used by the delete flow and by the deleted branch of the SSE upsert.
export function removeSession(state, sessionID) {
  let snapshot = createSessionStateSnapshot(state);
  if (!sessionID)
    return snapshot;

  let sessionDetailsByID = { ...snapshot.sessionDetailsByID };
  let framesBySessionID = { ...snapshot.framesBySessionID };
  let sessionPagingByID = { ...snapshot.sessionPagingByID };
  delete sessionDetailsByID[sessionID];
  delete framesBySessionID[sessionID];
  delete sessionPagingByID[sessionID];

  return {
    ...snapshot,
    sessionIDs: snapshot.sessionIDs.filter((id) => id !== sessionID),
    sessionDetailsByID,
    framesBySessionID,
    sessionPagingByID,
  };
}

export function mergeSessions(state, nextSessions) {
  let snapshot = createSessionStateSnapshot(state);
  let sessionIDs = [];
  let sessionDetailsByID = {};

  for (let session of Array.isArray(nextSessions) ? nextSessions : []) {
    if (!session?.id || isDeletedSession(session))
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

  // A deleted session.saved payload removes the id locally instead of adding or
  // keeping it, so the SSE frame cannot undo a soft delete.
  if (isDeletedSession(session))
    return removeSession(snapshot, session.id);

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

export function setSessionFramesState(state, sessionID, frames, paging = null) {
  let snapshot = createSessionStateSnapshot(state);
  let messages = projectFrameMessages(frames);
  // When the window is detached from the tail (the user scrolled up and older
  // pages were trimmed), live appends must not evict the region being read: drop
  // the newest overflow instead. The tail is refetched when they return to the
  // bottom. A fresh/anchored window keeps the newest and drops the oldest.
  let detached = !paging && snapshot.sessionPagingByID[sessionID]?.hasMoreNewer === true;
  let trimmedNewest = false;
  let trimmedOldest = false;

  if (messages.length > MAX_SESSION_MESSAGES) {
    if (detached) {
      messages = messages.slice(0, MAX_SESSION_MESSAGES);
      trimmedNewest = true;
    } else {
      messages = messages.slice(-MAX_SESSION_MESSAGES);
      trimmedOldest = true;
    }
  }

  let next = {
    ...snapshot,
    framesBySessionID: {
      ...snapshot.framesBySessionID,
      [sessionID]: messages,
    },
  };

  if (!sessionID)
    return next;

  if (paging) {
    // A fresh window is anchored to the newest page, so any prior "newer frames
    // were trimmed" flag is stale.
    next = setSessionPagingState(next, sessionID, { ...normalizeSessionPaging(paging), hasMoreNewer: false });
  } else if (trimmedOldest) {
    // A legacy/whole-session load that overflowed dropped the oldest end, so the
    // window is no longer anchored to the session start.
    next = setSessionPagingState(next, sessionID, { hasMoreOlder: true });
  } else if (trimmedNewest) {
    next = setSessionPagingState(next, sessionID, { hasMoreNewer: true });
  }

  let previous = snapshot.sessionDetailsByID[sessionID];
  if (!previous)
    return next;

  // The window `total` is a raw frame-file count, not a visible message count;
  // it stays paging metadata. messageCount remains the manifest value, repaired
  // upward only by the visible heads actually loaded.
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

// Merge older heads BEFORE the loaded window. A head already present (loaded
// from a newer page or an SSE upsert) always wins, so a page boundary cannot
// regress a complete newer head with an older partial. When the combined window
// overflows the cap the NEWEST end is trimmed (the user is scrolling upward),
// and `hasMoreNewer` is set so the client refetches the tail when they return.
export function prependSessionFramesState(state, sessionID, olderFrames) {
  let snapshot = createSessionStateSnapshot(state);
  if (!sessionID)
    return snapshot;

  let existing = snapshot.framesBySessionID[sessionID] || [];
  let existingIDs = new Set();
  for (let message of existing) {
    if (message?.id)
      existingIDs.add(message.id);
  }

  let prepended = [];
  for (let message of projectFrameMessages(olderFrames)) {
    if (!message?.id || existingIDs.has(message.id))
      continue;

    existingIDs.add(message.id);
    prepended.push(message);
  }

  let combined = [ ...prepended, ...existing ];
  let hasMoreNewer = snapshot.sessionPagingByID[sessionID]?.hasMoreNewer === true;

  if (combined.length > MAX_SESSION_MESSAGES) {
    combined = combined.slice(0, MAX_SESSION_MESSAGES);
    hasMoreNewer = true;
  }

  let next = {
    ...snapshot,
    framesBySessionID: {
      ...snapshot.framesBySessionID,
      [sessionID]: combined,
    },
  };

  if (prepended.length > 0)
    next = setSessionPagingState(next, sessionID, { hasMoreNewer });

  return next;
}

export function setSessionPagingState(state, sessionID, patch = {}) {
  let snapshot = createSessionStateSnapshot(state);
  if (!sessionID)
    return snapshot;

  let previous = snapshot.sessionPagingByID[sessionID] || {};
  return {
    ...snapshot,
    sessionPagingByID: {
      ...snapshot.sessionPagingByID,
      [sessionID]: {
        ...previous,
        ...patch,
      },
    },
  };
}

export function resetSessionPagingState(state, sessionID, patch = {}) {
  let snapshot = createSessionStateSnapshot(state);
  let sessionPagingByID = { ...snapshot.sessionPagingByID };
  if (!sessionID)
    return { ...snapshot, sessionPagingByID };

  delete sessionPagingByID[sessionID];
  if (Object.keys(patch).length > 0)
    sessionPagingByID[sessionID] = { ...patch };

  return {
    ...snapshot,
    sessionPagingByID,
  };
}

// Merge a freshly fetched newest page into the already-loaded window: new
// frames are added and existing heads are updated in place by id, but heads
// loaded from older pages are never dropped. Paging meta, when supplied, is
// applied (and messageCount honours the authoritative total).
export function mergeSessionFrameWindowState(state, sessionID, frames, paging = null) {
  let snapshot = createSessionStateSnapshot(state);
  if (!sessionID)
    return snapshot;

  let messages = upsertFrameMessages(snapshot.framesBySessionID[sessionID] || [], frames);
  return setSessionFramesState(snapshot, sessionID, messages, paging);
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

function normalizeSessionPaging(input = {}) {
  let patch = {};
  if ('hasMoreOlder' in input)
    patch.hasMoreOlder = input.hasMoreOlder === true;
  if ('loading' in input)
    patch.loading = input.loading === true;
  if ('oldestOrder' in input)
    patch.oldestOrder = normalizeOptionalOrder(input.oldestOrder);
  if ('newestOrder' in input)
    patch.newestOrder = normalizeOptionalOrder(input.newestOrder);
  if ('total' in input)
    patch.total = normalizeOptionalCount(input.total);
  if ('hasMoreNewer' in input)
    patch.hasMoreNewer = input.hasMoreNewer === true;

  return patch;
}

function normalizeOptionalOrder(value) {
  if (value == null)
    return null;

  let number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : null;
}

function normalizeOptionalCount(value) {
  if (value == null)
    return null;

  let number = Number(value);
  if (!Number.isFinite(number) || number < 0)
    return null;

  return Math.trunc(number);
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
