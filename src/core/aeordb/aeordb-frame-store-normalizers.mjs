'use strict';

import {
  DEFAULT_MAX_PREVIEW_SESSIONS,
  DEFAULT_PREVIEW_COUNT,
  MAX_FRAME_LIST_LIMIT,
  MAX_PREVIEW_COUNT,
} from './aeordb-frame-store-constants.mjs';

export function normalizeLimit(limit, fallback) {
  if (limit == null)
    return fallback;

  let value = Number(limit);
  if (!Number.isInteger(value) || value < 1)
    throw new TypeError('limit must be a positive integer');

  return Math.min(value, 500);
}

export function normalizeLargeLimit(limit, fallback) {
  if (limit == null)
    return fallback;

  let value = Number(limit);
  if (!Number.isInteger(value) || value < 1)
    throw new TypeError('limit must be a positive integer');

  return Math.min(value, MAX_FRAME_LIST_LIMIT);
}

export function normalizeOffset(offset) {
  if (offset == null)
    return 0;

  let value = Number(offset);
  if (!Number.isInteger(value) || value < 0)
    throw new TypeError('offset must be a non-negative integer');

  return value;
}

export function uniqueStrings(values) {
  let unique = [];

  for (let value of values) {
    if (typeof value !== 'string' || value.trim() === '')
      continue;

    let item = value.trim();
    if (!unique.includes(item))
      unique.push(item);
  }

  return unique;
}

export function normalizeSessionIDs(sessionIDs, maxSessions) {
  if (!Array.isArray(sessionIDs))
    return [];

  let limit = Number.isInteger(maxSessions) && maxSessions > 0 ? maxSessions : DEFAULT_MAX_PREVIEW_SESSIONS;
  let ids = [];
  let seen = new Set();

  for (let sessionID of sessionIDs) {
    if (typeof sessionID !== 'string' || sessionID.trim() === '')
      continue;

    let id = sessionID.trim();
    if (seen.has(id))
      continue;

    seen.add(id);
    ids.push(id);
    if (ids.length >= limit)
      break;
  }

  return ids;
}

export function normalizePreviewCount(previewCount) {
  let value = Number(previewCount);
  if (!Number.isInteger(value) || value < 1)
    return DEFAULT_PREVIEW_COUNT;

  return Math.min(value, MAX_PREVIEW_COUNT);
}

export function normalizePreviewTotal(total) {
  let value = Number(total);
  return Number.isInteger(value) && value > 0 ? value : 0;
}

export function resolveSessionID(frames) {
  if (!Array.isArray(frames))
    return null;

  for (let frame of frames) {
    if (frame?.sessionID)
      return frame.sessionID;
  }

  return null;
}

export function shouldFallbackToShallowSessionList(error) {
  if (!error)
    return false;

  if (error.status === 500)
    return true;

  return /failed to list directory|Invalid hash algorithm|recursive traversal/i.test(error.message || '');
}

export function shouldFallbackToScheduledFrameScan(error) {
  if (!error)
    return false;

  if (error.status === 500)
    return true;

  if (error.status === 400)
    return true;

  return /no index|index|scheduledAt|search|query/i.test(error.message || '');
}

export function isPendingScheduledFrame(frame) {
  if (!frame?.id || !frame.type || frame.deleted === true)
    return false;

  let scheduledAt = Number(frame.scheduledAt);
  if (!Number.isFinite(scheduledAt) || scheduledAt <= 0)
    return false;

  return frame.scheduledStatus !== 'fired' && frame.scheduledStatus !== 'cancelled';
}

export function isPreviewVisibleFrame(frame) {
  return Boolean(frame?.id)
    && frame.hidden !== true
    && frame.deleted !== true
    && frame.phantom !== true
    && frame.type !== 'MessageDone';
}
