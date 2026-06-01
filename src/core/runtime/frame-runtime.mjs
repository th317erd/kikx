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
    let title = normalizeTitle(input.title, `Session ${this.sessions.size + 1}`);
    let now = this.clock();
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
    });

    return session;
  }

  async updateSession(sessionID, input = {}) {
    let entry = this.requireSessionEntry(sessionID);
    let now = this.clock();

    entry.session.title = normalizeTitle(input.title);
    entry.session.updatedAt = input.updatedAt || now;

    await this.frameStore.saveSession(entry.session);

    return entry.session;
  }

  getSession(sessionID) {
    return this.sessions.get(sessionID)?.session || null;
  }

  listSessions() {
    return Array.from(this.sessions.values()).map((entry) => entry.session);
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

  async appendUserMessage(sessionID, input = {}) {
    let entry = this.requireSessionEntry(sessionID);
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

  listFrames(sessionID) {
    return this.requireSessionEntry(sessionID).frameEngine.toArray();
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
