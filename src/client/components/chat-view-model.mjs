'use strict';

export const MINI_PREVIEW_FRAME_LIMIT = 6;
export const DEFAULT_PREVIEW_COUNT = 5;
export const MAX_PREVIEW_COUNT = 20;
export const MAX_PREVIEW_SESSIONS_PER_REQUEST = 100;

// The mini card renders the real chat at this "design" size (CSS px) and
// scales the whole thing down to the card, so it is literally a tiny chat.
export const MINI_DESIGN_WIDTH = 760;
export const MINI_DESIGN_HEIGHT = 760;

// Uniform scale that fits a design-size box inside a container box without
// distortion (letterboxed). Returns 0 for a non-positive container.
export function miniScale({
  containerWidth,
  containerHeight,
  designWidth = MINI_DESIGN_WIDTH,
  designHeight = MINI_DESIGN_HEIGHT,
} = {}) {
  let width = Number(containerWidth);
  let height = Number(containerHeight);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0)
    return 0;

  if (!Number.isFinite(designWidth) || designWidth <= 0 || !Number.isFinite(designHeight) || designHeight <= 0)
    return 0;

  return Math.min(width / designWidth, height / designHeight);
}

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
