'use strict';

import { randomUUID } from 'node:crypto';

import { AeorDBFrameStore } from '../aeordb/aeordb-frame-store.mjs';
import { FrameEngine } from '../frames/frame-engine.mjs';

export class FrameRuntime {
  constructor(options = {}) {
    let {
      aeordb,
      frameStore,
      frameRouter = null,
      services = null,
      clock = () => Date.now(),
      idGenerator = () => randomUUID(),
    } = options;

    if (!aeordb && !frameStore)
      throw new TypeError('FrameRuntime requires aeordb or frameStore');

    this.clock = clock;
    this.idGenerator = idGenerator;
    this.frameStore = frameStore || new AeorDBFrameStore({ aeordb });
    this.frameRouter = frameRouter;
    this.services = services || {};
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
      messageCount: normalizeCount(input.messageCount),
      participantAgentIDs: normalizeStringArray(input.participantAgentIDs),
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

    let disconnect = this.connectFrameEngine(frameEngine, session);
    await this.frameStore.saveSession(session);

    this.sessions.set(session.id, {
      session,
      frameEngine,
      disconnectStore: disconnect,
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

    let disconnect = this.connectFrameEngine(frameEngine, session);
    entry = {
      session,
      frameEngine,
      disconnectStore: disconnect,
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

    await this.frameRouter?.flush?.();
    await this.frameStore.flush();

    entry.session.updatedAt = now;
    entry.session.messageCount = nextMessageCount(entry.session.messageCount, entry.frameEngine.toArray(), frames);
    await this.frameStore.saveSessionManifest(entry.session);

    return {
      session: entry.session,
      frame: frames[0],
      commit: entry.frameEngine.getLatestCommit(),
    };
  }

  async inviteAgentToSession(sessionID, agent, input = {}) {
    let entry = await this.ensureSessionEntry(sessionID, { loadFrames: false });
    let agentID = normalizeRequiredString(agent?.id, 'agent.id');
    let participantAgentIDs = normalizeStringArray(entry.session.participantAgentIDs);
    let alreadyParticipant = participantAgentIDs.includes(agentID);

    if (!alreadyParticipant)
      participantAgentIDs.push(agentID);

    entry.session = {
      ...entry.session,
      participantAgentIDs,
      updatedAt: input.updatedAt || input.invitedAt || this.clock(),
    };

    await this.frameStore.saveSessionManifest(entry.session);

    return {
      session: entry.session,
      agentID,
      alreadyParticipant,
    };
  }

  async listFrames(sessionID) {
    let entry = await this.ensureSessionEntry(sessionID);
    return entry.frameEngine.toArray();
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

  connectFrameEngine(frameEngine, session) {
    let disconnects = [
      this.frameStore.connect(frameEngine, { sessionID: session.id }),
    ];

    if (this.frameRouter) {
      disconnects.push(this.frameRouter.connectTo(frameEngine, session, {
        services: {
          ...this.services,
          frameRuntime: this,
          clock: this.clock,
        },
      }));
    }

    return () => {
      for (let disconnect of disconnects)
        disconnect?.();
    };
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

function normalizeCount(value) {
  if (value == null)
    return 0;

  return (typeof value === 'number' && Number.isFinite(value) && value >= 0)
    ? Math.trunc(value)
    : 0;
}

function normalizeRequiredString(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '')
    throw new TypeError(`${fieldName} must be a non-empty string`);

  return value.trim();
}

function normalizeStringArray(values) {
  if (!Array.isArray(values))
    return [];

  let normalized = [];
  for (let value of values) {
    if (typeof value !== 'string' || value.trim() === '')
      continue;

    let item = value.trim();
    if (!normalized.includes(item))
      normalized.push(item);
  }

  return normalized;
}

function countMessageFrames(frames) {
  if (!Array.isArray(frames))
    return 0;

  return frames.filter((frame) => frame?.type === 'UserMessage').length;
}

function nextMessageCount(currentCount, loadedFrames, newFrames) {
  if (typeof currentCount === 'number' && Number.isFinite(currentCount) && currentCount >= 0)
    return Math.trunc(currentCount) + countMessageFrames(newFrames);

  return countMessageFrames(loadedFrames);
}
