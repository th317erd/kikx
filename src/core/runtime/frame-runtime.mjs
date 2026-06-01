'use strict';

import { randomUUID } from 'node:crypto';

import { AeorDBFrameStore } from '../aeordb/aeordb-frame-store.mjs';
import { FrameEngine } from '../frames/frame-engine.mjs';

export class FrameRuntime {
  constructor(options = {}) {
    let {
      aeordb,
      frameStore,
      clock = () => Date.now(),
      idGenerator = () => randomUUID(),
    } = options;

    if (!aeordb && !frameStore)
      throw new TypeError('FrameRuntime requires aeordb or frameStore');

    this.clock = clock;
    this.idGenerator = idGenerator;
    this.frameStore = frameStore || new AeorDBFrameStore({ aeordb });
    this.sessions = new Map();
    this._indexesReady = false;
  }

  async createSession(input = {}) {
    let now = this.clock();
    let title = normalizeTitle(input.title, `Session ${now}`);
    let session = {
      id: input.id || this.idGenerator(),
      title,
      organizationID: input.organizationID || null,
      createdByUserID: input.createdByUserID || input.userID || null,
      createdAt: input.createdAt || now,
      updatedAt: input.updatedAt || now,
    };

    if (!session.id || typeof session.id !== 'string')
      throw new TypeError('session.id must be a non-empty string');

    await this.ensureIndexConfigs();

    let frameEngine = new FrameEngine({
      clock: this.clock,
      idGenerator: this.idGenerator,
      commitValidator: input.commitValidator || null,
    });

    let disconnectStore = this.frameStore.connect(frameEngine, { sessionID: session.id });
    await this.frameStore.saveSession(session);

    this.sessions.set(session.id, {
      session,
      frameEngine,
      disconnectStore,
      framesLoaded: true,
    });

    return session;
  }

  async updateSession(sessionID, input = {}) {
    let entry = this.sessions.get(sessionID);
    let session = entry?.session || await this.frameStore.loadSession(sessionID);
    if (!session?.id) {
      let error = new Error(`Unknown session: ${sessionID}`);
      error.status = 404;
      throw error;
    }

    let now = this.clock();

    session.title = normalizeTitle(input.title);
    session.updatedAt = input.updatedAt || now;

    await this.frameStore.saveSession(session);

    if (entry)
      entry.session = session;

    return session;
  }

  getSession(sessionID) {
    return this.sessions.get(sessionID)?.session || null;
  }

  async listSessions(options = {}) {
    return await this.frameStore.listSessions(options);
  }

  requireSessionEntry(sessionID) {
    let entry = this.sessions.get(sessionID);
    if (!entry) {
      let error = new Error(`Unknown session: ${sessionID}`);
      error.status = 404;
      throw error;
    }

    return entry;
  }

  async ensureSessionEntry(sessionID, options = {}) {
    let entry = this.sessions.get(sessionID);
    if (entry) {
      if (options.loadFrames !== false && !entry.framesLoaded) {
        let frames = await this.frameStore.listFrames(sessionID, {
          limit: options.frameLimit || 250,
        });
        entry.frameEngine.hydrate(frames);
        entry.framesLoaded = true;
      }
      return entry;
    }

    let session = await this.frameStore.loadSession(sessionID);
    if (!session?.id) {
      let error = new Error(`Unknown session: ${sessionID}`);
      error.status = 404;
      throw error;
    }

    let frameEngine = new FrameEngine({
      clock: this.clock,
      idGenerator: this.idGenerator,
      commitValidator: options.commitValidator || null,
    });

    if (options.loadFrames !== false) {
      let frames = await this.frameStore.listFrames(sessionID, {
        limit: options.frameLimit || 250,
      });
      frameEngine.hydrate(frames);
    }

    let disconnectStore = this.frameStore.connect(frameEngine, { sessionID });
    entry = {
      session,
      frameEngine,
      disconnectStore,
      framesLoaded: options.loadFrames !== false,
    };
    this.sessions.set(sessionID, entry);
    return entry;
  }

  async appendUserMessage(sessionID, input = {}) {
    let entry = await this.ensureSessionEntry(sessionID);
    let text = normalizeText(input.text);
    let now = this.clock();
    let interactionID = input.interactionID || input.interactionId || this.idGenerator();
    let frame = {
      id: input.id || this.idGenerator(),
      type: 'UserMessage',
      sessionID,
      interactionID,
      parentID: input.parentID || input.parentId || null,
      authorType: 'user',
      authorID: input.userID || input.authorID || null,
      timestamp: input.timestamp || now,
      createdAt: input.createdAt || now,
      updatedAt: input.updatedAt || now,
      hidden: false,
      deleted: false,
      content: { text },
    };

    let frames = entry.frameEngine.merge([ frame ], {
      authorType: 'user',
      authorID: frame.authorID,
    });

    if (frames.length === 0)
      throw new Error('UserMessage commit produced no frames');

    await this.frameStore.flush();

    entry.session.updatedAt = now;

    return {
      session: entry.session,
      frame: frames[0],
      commit: entry.frameEngine.getLatestCommit(),
    };
  }

  async listFrames(sessionID) {
    return (await this.ensureSessionEntry(sessionID)).frameEngine.toArray();
  }

  async ensureIndexConfigs() {
    if (this._indexesReady)
      return;

    await this.frameStore.ensureIndexConfigs();
    this._indexesReady = true;
  }

  disconnect() {
    for (let entry of this.sessions.values())
      entry.disconnectStore?.();
  }
}

function normalizeTitle(title, defaultTitle = null) {
  if (title == null)
    return defaultTitle || 'Session';

  if (typeof title !== 'string' || title.trim() === '')
    throw new TypeError('title must be a non-empty string');

  return title.trim();
}

function normalizeText(text) {
  if (typeof text !== 'string' || text.trim() === '')
    throw new TypeError('text must be a non-empty string');

  return text.trim();
}
