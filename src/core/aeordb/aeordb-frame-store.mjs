'use strict';

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
            { name: 'createdAt', type: 'timestamp' },
            { name: 'updatedAt', type: 'timestamp' },
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
    let result = await this.aeordb.listDirectory(`${this.rootPath}/sessions`, {
      depth: -1,
      glob: '**/session.json',
      limit,
      offset,
    });

    let sessions = [];
    for (let item of result?.items || []) {
      if (!item?.path)
        continue;

      let session = await this.aeordb.getFile(item.path);
      if (session?.id)
        sessions.push(session);
    }

    return sessions;
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

    let frames = [];
    for (let item of result?.items || []) {
      if (!item?.path)
        continue;

      if (!item.path.includes('/frames/'))
        continue;

      let frame = await this.aeordb.getFile(item.path);
      if (frame?.id && frame.type)
        frames.push(frame);
    }

    return frames.sort(compareFrameOrder);
  }

  async saveCommit(sessionID, commit, frames, frameEngine = null) {
    if (!sessionID)
      throw new TypeError('sessionID is required to save a commit');

    if (!commit?.id || typeof commit.order !== 'number')
      throw new TypeError('saveCommit() requires a commit with id and order');

    let changedFrames = Array.isArray(frames) ? frames : [];

    await this.aeordb.putFile(this.commitPath(sessionID, commit), serializeCommit(commit, changedFrames));

    for (let frame of changedFrames)
      await this.saveFrame(sessionID, frame);

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

function compareFrameOrder(a, b) {
  return ((a.order || 0) - (b.order || 0)) || String(a.id).localeCompare(String(b.id));
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
