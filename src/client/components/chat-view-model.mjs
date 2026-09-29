'use strict';

export const MINI_PREVIEW_FRAME_LIMIT = 6;
export const DEFAULT_PREVIEW_COUNT = 5;
export const MAX_PREVIEW_COUNT = 20;
export const MAX_PREVIEW_SESSIONS_PER_REQUEST = 100;

export function isVisibleFrame(frame) {
  return Boolean(frame?.id)
    && frame.hidden !== true
    && frame.deleted !== true
    && frame.phantom !== true
    && frame.type !== 'MessageDone';
}

export function miniPreviewFrames(frames, limit = MINI_PREVIEW_FRAME_LIMIT) {
  let visible = (Array.isArray(frames) ? frames : []).filter(isVisibleFrame);
  return visible.slice(-limit);
}

export function clampPreviewCount(value) {
  let count = Number(value);
  if (!Number.isInteger(count) || count < 1)
    return DEFAULT_PREVIEW_COUNT;

  return Math.min(count, MAX_PREVIEW_COUNT);
}

export function chunkSessionIDs(sessionIDs, maxPerRequest = MAX_PREVIEW_SESSIONS_PER_REQUEST) {
  let ids = [];
  let seen = new Set();
  for (let sessionID of Array.isArray(sessionIDs) ? sessionIDs : []) {
    if (typeof sessionID !== 'string' || sessionID.trim() === '')
      continue;

    let id = sessionID.trim();
    if (seen.has(id))
      continue;

    seen.add(id);
    ids.push(id);
  }

  let chunks = [];
  for (let index = 0; index < ids.length; index += maxPerRequest)
    chunks.push(ids.slice(index, index + maxPerRequest));

  return chunks;
}

export function previewsBySessionID(previews) {
  let map = new Map();
  for (let preview of Array.isArray(previews) ? previews : []) {
    if (preview?.sessionID)
      map.set(preview.sessionID, preview);
  }

  return map;
}

export function cardViewModel({ session, preview, selected = false } = {}) {
  let heads = Array.isArray(preview?.heads) ? preview.heads : [];
  return {
    // Prefer the client session (manifest merged with any locally repaired message
    // counts); fall back to the preview manifest when the list has no entry.
    session: session || preview?.session || null,
    heads,
    truncated: preview?.truncated === true,
    error: preview?.error || null,
    selected: selected === true,
  };
}

export function sessionCardLabel(session) {
  if (!session)
    return 'Session';

  return session.title || session.id || 'Session';
}

export function sessionCardMeta(session, heads = [], truncated = false) {
  let count = typeof session?.messageCount === 'number'
    ? session.messageCount
    : heads.length;
  let label = `${count} message${count === 1 ? '' : 's'}`;
  if (truncated)
    label += ' · preview';

  return label;
}
