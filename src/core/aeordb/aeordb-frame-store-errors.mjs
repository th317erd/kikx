'use strict';

export function createFrameLoadError(sessionID, path, error) {
  let fileName = String(path || '').split('/').pop() || 'unknown-frame.json';
  let order = parseFrameOrderFromPath(path);

  return {
    id: `load-error:${fileName}`,
    type: 'FrameLoadError',
    sessionID,
    interactionID: parseInteractionIDFromPath(path),
    parentID: null,
    authorType: 'system',
    authorID: 'internal:aeordb-frame-store',
    order,
    timestamp: 0,
    createdAt: 0,
    updatedAt: 0,
    createdClock: null,
    updatedClock: null,
    hidden: false,
    deleted: false,
    phantom: false,
    content: {
      text: 'Frame could not be loaded from AeorDB. Original database evidence was not modified.',
      path,
      error: error?.message || 'Unknown frame load failure',
    },
  };
}

export function createCommittedFrameLoadError(sessionID, commit, frameID) {
  let order = typeof commit?.order === 'number' ? commit.order : 0;

  return {
    id: `load-error:${commit?.id || order}:${frameID}`,
    type: 'FrameLoadError',
    sessionID,
    interactionID: null,
    parentID: null,
    authorType: 'system',
    authorID: 'internal:aeordb-frame-store',
    order: Number.MAX_SAFE_INTEGER,
    commitOrder: order,
    timestamp: commit?.timestamp || 0,
    createdAt: commit?.timestamp || 0,
    updatedAt: commit?.timestamp || 0,
    createdClock: commit?.clock || commit?.createdClock || null,
    updatedClock: commit?.clock || commit?.createdClock || null,
    hidden: false,
    deleted: false,
    phantom: false,
    content: {
      text: 'Committed frame could not be loaded from AeorDB. Original database evidence was not modified.',
      commitID: commit?.id || null,
      commitOrder: order,
      frameID,
      error: 'Committed frame body is missing or unreadable.',
    },
  };
}

export function parseFrameOrderFromPath(path) {
  let fileName = String(path || '').split('/').pop() || '';
  let match = fileName.match(/^(\d+)-/);
  if (!match)
    return 0;

  let order = Number(match[1]);
  return Number.isFinite(order) ? order : 0;
}

export function parseInteractionIDFromPath(path) {
  let match = String(path || '').match(/\/interactions\/([^/]+)\/frames\//);
  return match ? decodeURIComponent(match[1]) : null;
}
