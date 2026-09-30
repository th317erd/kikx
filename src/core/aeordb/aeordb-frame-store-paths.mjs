'use strict';

import { ORDER_WIDTH } from './aeordb-frame-store-constants.mjs';

export function normalizeRoot(rootPath) {
  if (!rootPath || typeof rootPath !== 'string')
    throw new TypeError('rootPath must be a non-empty string');

  let normalized = `/${rootPath.replace(/^\/+|\/+$/g, '')}`;
  return normalized === '/' ? '' : normalized;
}

export function encodeSegment(value) {
  return encodeURIComponent(String(value));
}

export function padOrder(order) {
  if (typeof order !== 'number' || !Number.isFinite(order) || order < 0)
    throw new TypeError(`Invalid order: ${order}`);

  return String(Math.trunc(order)).padStart(ORDER_WIDTH, '0');
}

export function sessionPath(rootPath, sessionID) {
  return `${rootPath}/sessions/${encodeSegment(sessionID)}/session.json`;
}

export function commitPath(rootPath, sessionID, commit) {
  return `${rootPath}/sessions/${encodeSegment(sessionID)}/commits/${padOrder(commit.order)}-${encodeSegment(commit.id)}.json`;
}

export function framePath(rootPath, sessionID, frame) {
  let interactionID = frame.interactionID || frame.interactionId || frame.id;
  return `${rootPath}/sessions/${encodeSegment(sessionID)}/interactions/${encodeSegment(interactionID)}/frames/${padOrder(frame.order)}-${encodeSegment(frame.type)}-${encodeSegment(frame.id)}.json`;
}

export function refPath(rootPath, sessionID, refName) {
  return `${rootPath}/sessions/${encodeSegment(sessionID)}/refs/${encodeURIComponent(refName)}.json`;
}

export function shouldIgnoreSessionDirectory(itemPath) {
  let value = String(itemPath || '');
  return value.includes('/.aeordb-config') || value.includes('/.aeordb-indexes');
}

export function pathSegmentAfter(parentPath, itemPath) {
  let prefix = `${parentPath.replace(/\/+$/g, '')}/`;
  if (!String(itemPath).startsWith(prefix))
    return '';

  let relativePath = String(itemPath).slice(prefix.length);
  return relativePath.split('/')[0] || '';
}
