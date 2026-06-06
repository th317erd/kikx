'use strict';

import { pathsFromItems, readJSONFiles } from './aeordb-file-utils.mjs';

const DEFAULT_ROOT_PATH = '/kikx';
const ORDER_WIDTH = 16;

export class AeorDBFrameStore {
  constructor(options = {}) {
    let { aeordb, rootPath = DEFAULT_ROOT_PATH } = options;

    if (!aeordb)
      throw new TypeError('AeorDBFrameStore requires an aeordb client');

    this.aeordb = aeordb;
    this.rootPath = normalizeRoot(rootPath);
    this._writeChain = Promise.resolve();
  }

  connect(frameEngine, options = {}) {
    if (!frameEngine || typeof frameEngine.on !== 'function')
      throw new TypeError('connect() requires a FrameEngine-compatible event emitter');

    let handler = ({ commit, frames }) => {
      let sessionID = options.sessionID || resolveSessionID(frames);
      this.enqueueSaveCommit(sessionID, commit, frames, frameEngine);
    };

    frameEngine.on('commit', handler);
    return () => frameEngine.off('commit', handler);
  }

  enqueueSaveCommit(sessionID, commit, frames, frameEngine) {
    let save = this._writeChain.then(() => this.saveCommit(sessionID, commit, frames, frameEngine));
    this._writeChain = save.catch(() => {});
    return save;
  }

  async flush() {
    return await this._writeChain;
  }

  async ensureIndexConfigs() {
    for (let config of this.indexConfigs())
      await this.aeordb.putFile(config.path, config.body);
  }

  indexConfigs() {
    return [
      {
        path: `${this.rootPath}/sessions/.aeordb-config/indexes.json`,
        body: {
          glob: '*/session.json',
          indexes: [
            { name: 'id', type: 'string' },
            { name: 'organizationID', type: 'string' },
            { name: 'title', type: [ 'string', 'trigram' ] },
            { name: 'coordinatorAgentID', type: 'string' },
            { name: 'createdAt', type: 'timestamp' },
            { name: 'updatedAt', type: 'timestamp' },
            { name: 'createdClock', type: 'string' },
            { name: 'updatedClock', type: 'string' },
          ],
        },
      },
    ];
  }

  async ensureSessionIndexConfigs(sessionID) {
    if (!sessionID)
      throw new TypeError('ensureSessionIndexConfigs() requires sessionID');

    for (let config of this.sessionIndexConfigs(sessionID))
      await this.aeordb.putFile(config.path, config.body);
  }

  sessionIndexConfigs(sessionID) {
    let sessionRoot = `${this.rootPath}/sessions/${encodeSegment(sessionID)}`;

    return [
      {
        path: `${sessionRoot}/interactions/.aeordb-config/indexes.json`,
        body: {
          glob: '**/frames/*.json',
          indexes: [
            { name: 'id', type: 'string' },
            { name: 'type', type: 'string' },
            { name: 'sessionID', type: 'string' },
            { name: 'interactionID', type: 'string' },
            { name: 'parentID', type: 'string' },
            { name: 'order', type: 'u64' },
            { name: 'timestamp', type: 'timestamp' },
            { name: 'createdAt', type: 'timestamp' },
            { name: 'updatedAt', type: 'timestamp' },
            { name: 'createdClock', type: 'string' },
            { name: 'updatedClock', type: 'string' },
            { name: 'authorType', type: 'string' },
            { name: 'authorID', type: 'string' },
            { name: 'hidden', type: 'string', source: [ 'hiddenIndex' ] },
            { name: 'deleted', type: 'string', source: [ 'deletedIndex' ] },
            { name: 'contentText', type: 'trigram' },
            { name: 'toolName', type: [ 'string', 'trigram' ], source: [ 'content', 'toolName' ] },
            { name: 'stateStatus', type: 'string', source: [ 'state', 'status' ] },
          ],
        },
      },
      {
        path: `${sessionRoot}/values/.aeordb-config/indexes.json`,
        body: {
          glob: '**/*.json',
          indexes: [
            { name: 'namespace', type: 'string' },
            { name: 'ownerType', type: 'string' },
            { name: 'ownerID', type: 'string' },
            { name: 'scopeID', type: 'string' },
            { name: 'key', type: [ 'string', 'trigram' ] },
            { name: 'valueText', type: 'trigram' },
            { name: 'updatedAt', type: 'timestamp' },
          ],
        },
      },
      {
        path: `${sessionRoot}/tool-log/.aeordb-config/indexes.json`,
        body: {
          glob: '*.json',
          indexes: [
            { name: 'id', type: 'string' },
            { name: 'toolName', type: [ 'string', 'trigram' ] },
            { name: 'agentID', type: 'string' },
            { name: 'timestamp', type: 'timestamp' },
            { name: 'note', type: 'trigram' },
            { name: 'outputText', type: 'trigram' },
          ],
        },
      },
    ];
  }

  async saveSession(session) {
    if (!session?.id)
      throw new TypeError('saveSession() requires session.id');

    await this.ensureSessionIndexConfigs(session.id);
    await this.saveSessionManifest(session);
  }

  async saveSessionManifest(session) {
    if (!session?.id)
      throw new TypeError('saveSessionManifest() requires session.id');

    await this.aeordb.putFile(this.sessionPath(session.id), session);
  }

  async loadSession(sessionID) {
    if (!sessionID)
      throw new TypeError('loadSession() requires sessionID');

    return await this.aeordb.getFile(this.sessionPath(sessionID));
  }

  async listSessions(options = {}) {
    let limit = normalizeLimit(options.limit, 50);
    let offset = normalizeOffset(options.offset);
    let result;
    let sessionPaths;

    try {
      result = await this.aeordb.listDirectory(`${this.rootPath}/sessions`, {
        depth: -1,
        glob: '**/session.json',
        limit,
        offset,
      });
      sessionPaths = pathsFromItems(result?.items);
    } catch (error) {
      if (!shouldFallbackToShallowSessionList(error))
        throw error;

      sessionPaths = await this.listSessionManifestPathsShallow({ limit, offset });
    }

    let sessions = [];
    let reads = await readJSONFiles(this.aeordb, sessionPaths, {
      fallbackOnBatchError: true,
    });

    for (let read of reads) {
      let session = read.value;
      if (session?.id)
        sessions.push(session);
    }

    return sessions.sort(compareSessionOrder);
  }

  async listSessionManifestPathsShallow(options = {}) {
    let result = await this.aeordb.listDirectory(`${this.rootPath}/sessions`, {
      depth: 1,
      limit: options.limit,
      offset: options.offset,
    });
    let paths = [];

    for (let item of result?.items || []) {
      let itemPath = item.path || item['@path'];
      if (!itemPath || shouldIgnoreSessionDirectory(itemPath))
        continue;

      let sessionID = pathSegmentAfter(`${this.rootPath}/sessions`, itemPath);
      if (!sessionID)
        continue;

      paths.push(this.sessionPath(decodeURIComponent(sessionID)));
    }

    return uniqueStrings(paths);
  }

  async listFrames(sessionID, options = {}) {
    if (!sessionID)
      throw new TypeError('listFrames() requires sessionID');

    let limit = normalizeLimit(options.limit, 250);
    let offset = normalizeOffset(options.offset);
    let result = await this.aeordb.listDirectory(`${this.rootPath}/sessions/${encodeSegment(sessionID)}/interactions`, {
      depth: -1,
      glob: '**/*.json',
      limit,
      offset,
    });

    let framePaths = pathsFromItems(result?.items)
      .filter((path) => path.includes('/frames/'));
    let frames = [];
    let reads = await readJSONFiles(this.aeordb, framePaths, {
      fallbackOnBatchError: true,
      continueOnError: true,
    });

    for (let read of reads) {
      if (read.error) {
        frames.push(createFrameLoadError(sessionID, read.path, read.error));
        continue;
      }

      let frame = read.value;
      if (frame?.id && frame.type)
        frames.push(frame);
    }

    let commits = await this.listCommits(sessionID, { limit, offset });
    if (commits.length === 0)
      return frames.sort(compareFrameOrder);

    return orderFramesByCommits(sessionID, frames, commits);
  }

  async listCommits(sessionID, options = {}) {
    let limit = normalizeLimit(options.limit, 250);
    let offset = normalizeOffset(options.offset);
    let result;

    try {
      result = await this.aeordb.listDirectory(`${this.rootPath}/sessions/${encodeSegment(sessionID)}/commits`, {
        depth: -1,
        glob: '**/*.json',
        limit,
        offset,
      });
    } catch (error) {
      if (error?.status === 404)
        return [];

      throw error;
    }

    let commitPaths = pathsFromItems(result?.items);
    let commits = [];
    let reads = await readJSONFiles(this.aeordb, commitPaths, {
      fallbackOnBatchError: true,
      continueOnError: true,
    });

    for (let read of reads) {
      if (read.error)
        continue;

      let commit = read.value;
      if (commit?.id && typeof commit.order === 'number')
        commits.push(commit);
    }

    return commits.sort(compareCommitOrder);
  }

  async saveCommit(sessionID, commit, frames, frameEngine = null) {
    if (!sessionID)
      throw new TypeError('sessionID is required to save a commit');

    if (!commit?.id || typeof commit.order !== 'number')
      throw new TypeError('saveCommit() requires a commit with id and order');

    let changedFrames = Array.isArray(frames) ? frames : [];

    for (let frame of changedFrames)
      await this.saveFrame(sessionID, frame);

    await this.aeordb.putFile(this.commitPath(sessionID, commit), serializeCommit(commit, changedFrames));

    if (frameEngine)
      await this.saveRefs(sessionID, frameEngine);
  }

  async saveFrame(sessionID, frame) {
    if (!sessionID)
      throw new TypeError('sessionID is required to save a frame');

    if (!frame?.id || !frame.type)
      throw new TypeError('saveFrame() requires frame.id and frame.type');

    await this.aeordb.putFile(this.framePath(sessionID, frame), serializeFrame(sessionID, frame));
  }

  async saveRefs(sessionID, frameEngine) {
    for (let [name, commitOrder] of frameEngine.listRefs())
      await this.aeordb.putFile(this.refPath(sessionID, name), { name, commitOrder });
  }

  sessionPath(sessionID) {
    return `${this.rootPath}/sessions/${encodeSegment(sessionID)}/session.json`;
  }

  commitPath(sessionID, commit) {
    return `${this.rootPath}/sessions/${encodeSegment(sessionID)}/commits/${padOrder(commit.order)}-${encodeSegment(commit.id)}.json`;
  }

  framePath(sessionID, frame) {
    let interactionID = frame.interactionID || frame.interactionId || frame.id;
    return `${this.rootPath}/sessions/${encodeSegment(sessionID)}/interactions/${encodeSegment(interactionID)}/frames/${padOrder(frame.order)}-${encodeSegment(frame.type)}-${encodeSegment(frame.id)}.json`;
  }

  refPath(sessionID, refName) {
    return `${this.rootPath}/sessions/${encodeSegment(sessionID)}/refs/${encodeURIComponent(refName)}.json`;
  }
}

export function serializeFrame(sessionID, frame) {
  let output = {
    ...frame,
    sessionID: frame.sessionID || sessionID,
    contentText: extractContentText(frame),
    hiddenIndex: String(frame.hidden === true),
    deletedIndex: String(frame.deleted === true),
  };

  return output;
}

export function serializeCommit(commit, frames = []) {
  return {
    ...commit,
    frameIDs: frames.map((frame) => frame.id),
  };
}

export function extractContentText(frame) {
  let content = frame?.content;
  if (content == null)
    return '';

  if (typeof content === 'string')
    return content;

  if (typeof content.text === 'string')
    return content.text;

  if (typeof content.html === 'string')
    return stripHTML(content.html);

  if (typeof content.output === 'string')
    return content.output;

  if (typeof content.result === 'string')
    return content.result;

  try {
    return JSON.stringify(content);
  } catch (_error) {
    return '';
  }
}

function resolveSessionID(frames) {
  if (!Array.isArray(frames))
    return null;

  for (let frame of frames) {
    if (frame?.sessionID)
      return frame.sessionID;
  }

  return null;
}

function stripHTML(html) {
  return html.replace(/<[^>]*>/g, ' ');
}

function padOrder(order) {
  if (typeof order !== 'number' || !Number.isFinite(order) || order < 0)
    throw new TypeError(`Invalid order: ${order}`);

  return String(Math.trunc(order)).padStart(ORDER_WIDTH, '0');
}

function normalizeLimit(limit, fallback) {
  if (limit == null)
    return fallback;

  let value = Number(limit);
  if (!Number.isInteger(value) || value < 1)
    throw new TypeError('limit must be a positive integer');

  return Math.min(value, 500);
}

function normalizeOffset(offset) {
  if (offset == null)
    return 0;

  let value = Number(offset);
  if (!Number.isInteger(value) || value < 0)
    throw new TypeError('offset must be a non-negative integer');

  return value;
}

function shouldFallbackToShallowSessionList(error) {
  if (!error)
    return false;

  if (error.status === 500)
    return true;

  return /failed to list directory|Invalid hash algorithm|recursive traversal/i.test(error.message || '');
}

function shouldIgnoreSessionDirectory(itemPath) {
  let value = String(itemPath || '');
  return value.includes('/.aeordb-config') || value.includes('/.aeordb-indexes');
}

function pathSegmentAfter(parentPath, itemPath) {
  let prefix = `${parentPath.replace(/\/+$/g, '')}/`;
  if (!String(itemPath).startsWith(prefix))
    return '';

  let relativePath = String(itemPath).slice(prefix.length);
  return relativePath.split('/')[0] || '';
}

function uniqueStrings(values) {
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

function compareSessionOrder(a, b) {
  return compareClock(b?.updatedClock, a?.updatedClock)
    || compareNumber(b?.updatedAt, a?.updatedAt)
    || compareClock(b?.createdClock, a?.createdClock)
    || compareNumber(b?.createdAt, a?.createdAt)
    || String(a.id || '').localeCompare(String(b.id || ''));
}

function compareFrameOrder(a, b) {
  return compareClock(sortUpdatedClock(a), sortUpdatedClock(b))
    || compareNumber(sortUpdatedAt(a), sortUpdatedAt(b))
    || compareClock(a?.createdClock, b?.createdClock)
    || compareNumber(a?.createdAt, b?.createdAt)
    || compareNumber(sortCommitOrder(a), sortCommitOrder(b))
    || compareNumber(a?.order, b?.order)
    || String(a.id).localeCompare(String(b.id));
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

  return frame?.order || 0;
}

function compareCommitOrder(a, b) {
  return ((a.order || 0) - (b.order || 0)) || String(a.id).localeCompare(String(b.id));
}

function orderFramesByCommits(sessionID, frames, commits) {
  let frameByID = new Map();
  let outputByID = new Map();
  let ordered = [];

  for (let frame of frames) {
    if (!frame?.id)
      continue;

    let existing = frameByID.get(frame.id);
    if (!existing || compareFrameFileVersion(existing, frame) <= 0)
      frameByID.set(frame.id, frame);
  }

  for (let commit of commits) {
    for (let frameID of commitFrameIDs(commit)) {
      if (!frameID)
        continue;

      let frame = frameByID.get(frameID);
      if (!frame) {
        outputByID.set(frameID, createCommittedFrameLoadError(sessionID, commit, frameID));
        continue;
      }

      outputByID.set(frameID, {
        ...frame,
        commitOrder: commit.order,
      });
    }
  }

  for (let frame of outputByID.values())
    ordered.push(frame);

  for (let [frameID, frame] of frameByID) {
    if (!outputByID.has(frameID))
      ordered.push(frame);
  }

  return ordered.sort(compareFrameOrder);
}

function commitFrameIDs(commit) {
  let frameIDs = [];

  if (Array.isArray(commit?.changes)) {
    for (let change of commit.changes) {
      if (change?.frameID)
        frameIDs.push(change.frameID);
    }
  }

  if (frameIDs.length === 0 && Array.isArray(commit?.frameIDs)) {
    for (let frameID of commit.frameIDs) {
      if (frameID)
        frameIDs.push(frameID);
    }
  }

  return frameIDs;
}

function compareFrameFileVersion(a, b) {
  return compareClock(sortUpdatedClock(a), sortUpdatedClock(b))
    || compareNumber(sortUpdatedAt(a), sortUpdatedAt(b))
    || compareNumber(a?.commitOrder, b?.commitOrder)
    || compareNumber(a?.order, b?.order);
}

function createFrameLoadError(sessionID, path, error) {
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

function createCommittedFrameLoadError(sessionID, commit, frameID) {
  let order = typeof commit?.order === 'number' ? commit.order : 0;

  return {
    id: `load-error:${commit?.id || order}:${frameID}`,
    type: 'FrameLoadError',
    sessionID,
    interactionID: null,
    parentID: null,
    authorType: 'system',
    authorID: 'internal:aeordb-frame-store',
    order,
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

function parseFrameOrderFromPath(path) {
  let fileName = String(path || '').split('/').pop() || '';
  let match = fileName.match(/^(\d+)-/);
  if (!match)
    return 0;

  let order = Number(match[1]);
  return Number.isFinite(order) ? order : 0;
}

function parseInteractionIDFromPath(path) {
  let match = String(path || '').match(/\/interactions\/([^/]+)\/frames\//);
  return match ? decodeURIComponent(match[1]) : null;
}

function normalizeRoot(rootPath) {
  if (!rootPath || typeof rootPath !== 'string')
    throw new TypeError('rootPath must be a non-empty string');

  let normalized = `/${rootPath.replace(/^\/+|\/+$/g, '')}`;
  return normalized === '/' ? '' : normalized;
}

function encodeSegment(value) {
  return encodeURIComponent(String(value));
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
