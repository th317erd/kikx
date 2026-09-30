'use strict';

import { pathsFromItems, readJSONFiles } from './aeordb-file-utils.mjs';
import { buildGlobalIndexConfigs, buildSessionIndexConfigs } from './aeordb-frame-store-indexes.mjs';
import {
  normalizeLimit,
  normalizeOffset,
  resolveSessionID,
  shouldFallbackToShallowSessionList,
  uniqueStrings,
} from './aeordb-frame-store-normalizers.mjs';
import { compareSessionOrder } from './aeordb-frame-store-ordering.mjs';
import {
  commitPath,
  framePath,
  normalizeRoot,
  pathSegmentAfter,
  refPath,
  sessionPath,
  shouldIgnoreSessionDirectory,
} from './aeordb-frame-store-paths.mjs';
import { DEFAULT_ROOT_PATH } from './aeordb-frame-store-constants.mjs';

export class AeorDBFrameStoreSessionBase {
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
    return buildGlobalIndexConfigs(this.rootPath);
  }

  async ensureSessionIndexConfigs(sessionID) {
    if (!sessionID)
      throw new TypeError('ensureSessionIndexConfigs() requires sessionID');

    for (let config of this.sessionIndexConfigs(sessionID))
      await this.aeordb.putFile(config.path, config.body);
  }

  sessionIndexConfigs(sessionID) {
    return buildSessionIndexConfigs(this.rootPath, sessionID);
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
      if (error?.status === 404)
        return [];

      if (!shouldFallbackToShallowSessionList(error))
        throw error;

      sessionPaths = await this.listSessionManifestPathsShallow({ limit, offset });
    }

    let sessions = [];
    let reads = await readJSONFiles(this.aeordb, sessionPaths, {
      fallbackOnBatchError: true,
      continueOnError: true,
    });

    for (let read of reads) {
      if (read.error)
        continue;

      let session = read.value;
      if (session?.id)
        sessions.push(session);
    }

    return sessions.sort(compareSessionOrder);
  }

  async listSessionManifestPathsShallow(options = {}) {
    let result;
    try {
      result = await this.aeordb.listDirectory(`${this.rootPath}/sessions`, {
        depth: 1,
        limit: options.limit,
        offset: options.offset,
      });
    } catch (error) {
      if (error?.status === 404)
        return [];

      throw error;
    }
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

  async loadSessionManifests(sessionIDs) {
    let paths = sessionIDs.map((sessionID) => this.sessionPath(sessionID));
    let reads = await readJSONFiles(this.aeordb, paths, {
      fallbackOnBatchError: true,
      continueOnError: true,
    });
    let sessions = new Map();

    for (let read of reads) {
      if (read.error || !read.value?.id)
        continue;

      sessions.set(read.value.id, read.value);
    }

    return sessions;
  }

  sessionPath(sessionID) {
    return sessionPath(this.rootPath, sessionID);
  }

  commitPath(sessionID, commit) {
    return commitPath(this.rootPath, sessionID, commit);
  }

  framePath(sessionID, frame) {
    return framePath(this.rootPath, sessionID, frame);
  }

  refPath(sessionID, refName) {
    return refPath(this.rootPath, sessionID, refName);
  }
}
