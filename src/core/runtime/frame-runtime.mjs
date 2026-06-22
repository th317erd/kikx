'use strict';

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

import { AeorDBFrameStore } from '../aeordb/aeordb-frame-store.mjs';
import { HybridLogicalClock, defaultUnixMicros } from '../clock/hybrid-logical-clock.mjs';
import { FrameEngine } from '../frames/frame-engine.mjs';
import { ScheduledFrameQueue } from './scheduled-frame-queue.mjs';

const DEFAULT_SESSION_FRAME_LIMIT = 1000;
const MAX_SESSION_FRAME_LIMIT = 5000;

export class FrameRuntime extends EventEmitter {
  constructor(options = {}) {
    super();

    let {
      aeordb,
      frameStore,
      frameRouter = null,
      services = null,
      clock = defaultUnixMicros,
      logicalClock = null,
      runnerID = null,
      idGenerator = () => randomUUID(),
      scheduledFrameWorkerIntervalMS = 1000,
    } = options;

    if (!aeordb && !frameStore)
      throw new TypeError('FrameRuntime requires aeordb or frameStore');

    this.clock = clock;
    this.logicalClock = logicalClock || new HybridLogicalClock({
      now: this.clock,
      runnerID,
    });
    this.idGenerator = idGenerator;
    this.frameStore = frameStore || new AeorDBFrameStore({ aeordb });
    this.frameRouter = frameRouter;
    this.services = services || {};
    this.tokenUsage = options.tokenUsage || resolveService(this.services, 'tokenUsage');
    this._disconnectTokenUsage = this.connectTokenUsage(this.tokenUsage);
    this.logger = options.logger || console;
    this.scheduledFrames = new ScheduledFrameQueue({
      runtime: this,
      intervalMS: scheduledFrameWorkerIntervalMS,
      logger: this.logger,
    });
    this.sessions = new Map();
    this._sessionManifestSaves = new Map();
    this._indexesReady = false;
  }

  async createSession(input = {}) {
    let stamp = this.nextClockStamp();
    let now = stamp.at;
    let title = normalizeTitle(input.title, this.nextDefaultSessionTitle());
    let participantAgentIDs = normalizeStringArray(input.participantAgentIDs);
    let parentSessionID = normalizeOptionalString(input.parentSessionID || input.parentSessionId);
    let session = {
      id: input.id || this.idGenerator(),
      title,
      organizationID: input.organizationID || null,
      createdByUserID: input.createdByUserID || input.userID || null,
      createdByAgentID: normalizeOptionalString(input.createdByAgentID || input.agentID) || null,
      parentSessionID: parentSessionID || null,
      generation: normalizeSessionGeneration(input.generation, parentSessionID),
      messageCount: normalizeCount(input.messageCount),
      participantAgentIDs,
      coordinatorAgentID: normalizeCoordinatorAgentID(input.coordinatorAgentID, participantAgentIDs),
      createdAt: input.createdAt || now,
      updatedAt: input.updatedAt || now,
      createdClock: input.createdClock || stamp.clock,
      updatedClock: input.updatedClock || stamp.clock,
    };

    if (!session.id || typeof session.id !== 'string')
      throw new TypeError('session.id must be a non-empty string');

    await this.ensureIndexConfigs();

    let frameEngine = new FrameEngine({
      clock: this.clock,
      logicalClock: this.logicalClock,
      idGenerator: this.idGenerator,
      commitValidator: input.commitValidator || null,
    });

    let disconnect = this.connectFrameEngine(frameEngine, session);
    await this.frameStore.saveSession(session);
    this.emitRuntimeEvent('session.saved', { sessionID: session.id, session });

    this.sessions.set(session.id, {
      session,
      frameEngine,
      disconnectStore: disconnect,
      framesLoaded: true,
      framesLoadedLimit: Number.POSITIVE_INFINITY,
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

    let stamp = this.nextClockStamp();
    let now = stamp.at;

    session.title = normalizeTitle(input.title);
    session.updatedAt = input.updatedAt || now;
    session.updatedClock = input.updatedClock || stamp.clock;

    await this.frameStore.saveSession(session);
    this.emitRuntimeEvent('session.saved', { sessionID: session.id, session });

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
      let frameLimit = normalizeFrameLimit(options.frameLimit);
      if (options.loadFrames !== false && (!entry.framesLoaded || entry.framesLoadedLimit < frameLimit)) {
        let frames = await this.frameStore.listFrames(sessionID, {
          limit: frameLimit,
        });
        entry.frameEngine.hydrate(frames);
        this.syncSessionManifestFromEngine(entry, { persist: true });
        entry.framesLoaded = true;
        entry.framesLoadedLimit = frameLimit;
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
      logicalClock: this.logicalClock,
      idGenerator: this.idGenerator,
      commitValidator: options.commitValidator || null,
    });

    if (options.loadFrames !== false) {
      let frameLimit = normalizeFrameLimit(options.frameLimit);
      let frames = await this.frameStore.listFrames(sessionID, {
        limit: frameLimit,
      });
      frameEngine.hydrate(frames);
    }

    let disconnect = this.connectFrameEngine(frameEngine, session);
    entry = {
      session,
      frameEngine,
      disconnectStore: disconnect,
      framesLoaded: options.loadFrames !== false,
      framesLoadedLimit: options.loadFrames === false ? 0 : normalizeFrameLimit(options.frameLimit),
    };
    this.sessions.set(sessionID, entry);
    if (options.loadFrames !== false)
      this.syncSessionManifestFromEngine(entry, { persist: true });
    return entry;
  }

  async appendUserMessage(sessionID, input = {}) {
    let entry = await this.ensureSessionEntry(sessionID);
    let text = normalizeText(input.text);
    let stamp = this.nextClockStamp();
    let now = stamp.at;
    let interactionID = input.interactionID || input.interactionId || this.idGenerator();
    let frame = {
      id: input.id || this.idGenerator(),
      type: 'UserMessage',
      sessionID,
      interactionID,
      parentID: input.parentID || input.parentId || null,
      authorType: 'user',
      authorID: input.userID || input.authorID || null,
      authorDisplayName: normalizeOptionalString(input.authorDisplayName || input.userDisplayName) || null,
      timestamp: input.timestamp || now,
      createdAt: input.createdAt || now,
      updatedAt: input.updatedAt || now,
      createdClock: input.createdClock || stamp.clock,
      updatedClock: input.updatedClock || stamp.clock,
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

    let manifestSave = this._sessionManifestSaves.get(sessionID);
    await this.frameStore.flush();

    entry.session.updatedAt = now;
    entry.session.updatedClock = stamp.clock;
    entry.session.messageCount = countMessageFrames(entry.frameEngine.toArray());
    if (!manifestSave)
      manifestSave = this.queueSessionManifestSave(entry);
    await manifestSave;
    await this.frameRouter?.flush?.();

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

    entry.session.participantAgentIDs = participantAgentIDs;
    entry.session.coordinatorAgentID = normalizeCoordinatorAgentID(entry.session.coordinatorAgentID, participantAgentIDs);
    let stamp = this.nextClockStamp();
    entry.session.updatedAt = input.updatedAt || input.invitedAt || stamp.at;
    entry.session.updatedClock = input.updatedClock || input.invitedClock || stamp.clock;

    await this.frameStore.saveSessionManifest(entry.session);
    this.emitRuntimeEvent('session.saved', { sessionID, session: entry.session });

    return {
      session: entry.session,
      agentID,
      alreadyParticipant,
    };
  }

  async listFrames(sessionID, options = {}) {
    let hasPagingOptions = options.limit != null || options.offset != null;
    let limit = normalizeFrameLimit(options.limit);
    let offset = normalizeFrameOffset(options.offset);
    let loadLimit = hasPagingOptions ? normalizeFrameWindowLimit(offset + limit) : limit;
    let entry = await this.ensureSessionEntry(sessionID, { frameLimit: loadLimit });
    let frames = entry.frameEngine.toArray();

    if (hasPagingOptions)
      return frames.slice(offset, offset + limit);

    return frames;
  }

  async recoverStaleRuntimeFrames(options = {}) {
    let sessions = await this.listSessions({
      limit: normalizeRecoveryLimit(options.sessionLimit, 500),
      offset: 0,
    });
    let recoveredAgentResponses = 0;
    let recoveredToolCalls = 0;

    for (let session of sessions) {
      if (!session?.id)
        continue;

      let entry = await this.ensureSessionEntry(session.id, {
        frameLimit: normalizeFrameLimit(options.frameLimit || MAX_SESSION_FRAME_LIMIT),
      });
      let frames = entry.frameEngine.toArray();
      let toolResultIDs = collectToolResultIDs(frames);
      let updates = [];

      for (let frame of frames) {
        if (isStaleAgentResponseFrame(frame)) {
          updates.push(createRecoveredAgentResponseFrame(frame, {
            clock: this.clock,
            message: options.agentMessage,
          }));
          recoveredAgentResponses++;
          continue;
        }

        if (isStaleToolCallFrame(frame, toolResultIDs)) {
          updates.push(createRecoveredToolCallFrame(frame, {
            clock: this.clock,
            message: options.toolMessage,
          }));
          recoveredToolCalls++;
        }
      }

      if (updates.length === 0)
        continue;

      entry.frameEngine.merge(updates, {
        authorType: 'system',
        authorID: 'runtime-recovery',
        silent: true,
      });
      await this.frameStore.flush();
    }

    return {
      sessionsScanned: sessions.length,
      recoveredAgentResponses,
      recoveredToolCalls,
      recovered: recoveredAgentResponses + recoveredToolCalls,
    };
  }

  async ensureIndexConfigs() {
    if (this._indexesReady)
      return;

    await this.frameStore.ensureIndexConfigs();
    this._indexesReady = true;
  }

  disconnect() {
    this.scheduledFrames.stop();

    for (let entry of this.sessions.values())
      entry.disconnectStore?.();

    this._disconnectTokenUsage?.();
    this._disconnectTokenUsage = null;
  }

  async startScheduledFrameWorker() {
    return await this.scheduledFrames.start();
  }

  stopScheduledFrameWorker() {
    this.scheduledFrames.stop();
  }

  async loadScheduledFrames() {
    return await this.scheduledFrames.load();
  }

  async processScheduledFrames() {
    return await this.scheduledFrames.processDue();
  }

  routerServices() {
    return {
      ...this.services,
      frameRuntime: this,
      clock: this.clock,
    };
  }

  nextClockStamp() {
    if (this.logicalClock && typeof this.logicalClock.tick === 'function') {
      this.logicalClock.now = this.clock;
      return this.logicalClock.tick();
    }

    return { at: this.clock(), clock: null };
  }

  nextDefaultSessionTitle() {
    return `Session ${this.sessions.size + 1}`;
  }

  emitRuntimeEvent(type, payload = {}) {
    this.emit(type, { type, ...payload });
    this.emit('event', { type, ...payload });
  }

  connectFrameEngine(frameEngine, session) {
    let sessionID = session.id;
    let phantomHandler = ({ frame }) => {
      this.emitRuntimeEvent('frame.phantom', { sessionID, frame });
    };
    let commitHandler = ({ commit, frames }) => {
      this.scheduledFrames.trackFrames(frames);
      let entry = this.sessions.get(sessionID);
      if (entry)
        this.syncSessionManifestFromEngine(entry, { frames, persist: true });

      for (let frame of frames || []) {
        let eventType = commit.changes?.find((change) => change.frameID === frame.id)?.operation === 'update'
          ? 'frame.updated'
          : 'frame.added';
        this.emitRuntimeEvent(eventType, { sessionID, frame, commit });
      }
      this.emitRuntimeEvent('commit', { sessionID, commit, frames: Array.isArray(frames) ? frames.slice() : [] });
    };

    frameEngine.on('frame:phantom', phantomHandler);
    frameEngine.on('commit', commitHandler);

    let disconnects = [
      () => {
        frameEngine.off('frame:phantom', phantomHandler);
        frameEngine.off('commit', commitHandler);
      },
      this.frameStore.connect(frameEngine, { sessionID: session.id }),
    ];

    if (this.frameRouter) {
      disconnects.push(this.frameRouter.connectTo(frameEngine, session, {
        services: this.routerServices(),
      }));
    }

    return () => {
      for (let disconnect of disconnects)
        disconnect?.();
    };
  }

  syncSessionManifestFromEngine(entry, options = {}) {
    if (!entry?.session || !entry.frameEngine)
      return entry?.session || null;

    let frames = typeof entry.frameEngine.toArray === 'function'
      ? entry.frameEngine.toArray()
      : [];
    let changedFrames = Array.isArray(options.frames) ? options.frames : frames;
    let nextCount = countMessageFrames(frames);
    let frameUpdatedAt = maxFrameTimestamp(changedFrames);
    let changed = entry.session.messageCount !== nextCount;

    if (changed)
      entry.session.messageCount = nextCount;

    if (frameUpdatedAt && (!entry.session.updatedAt || frameUpdatedAt > entry.session.updatedAt)) {
      entry.session.updatedAt = frameUpdatedAt;
      changed = true;
    }

    let frameUpdatedClock = latestFrameClock(changedFrames);
    if (frameUpdatedClock && frameUpdatedClock !== entry.session.updatedClock) {
      entry.session.updatedClock = frameUpdatedClock;
      changed = true;
    }

    if (changed && options.persist)
      this.queueSessionManifestSave(entry);

    return entry.session;
  }

  queueSessionManifestSave(entry) {
    if (!entry?.session?.id || !this.frameStore?.saveSessionManifest)
      return null;

    let sessionID = entry.session.id;
    if (this._sessionManifestSaves.has(sessionID))
      return this._sessionManifestSaves.get(sessionID);

    let save = Promise.resolve()
      .then(async () => {
        await this.frameStore.saveSessionManifest(entry.session);
        this.emitRuntimeEvent('session.saved', { sessionID, session: entry.session });
      })
      .catch((error) => {
        this.logger?.error?.('FrameRuntime failed to persist session manifest', error);
      })
      .finally(() => {
        this._sessionManifestSaves.delete(sessionID);
      });

    this._sessionManifestSaves.set(sessionID, save);
    return save;
  }

  connectTokenUsage(tokenUsage) {
    if (!tokenUsage || typeof tokenUsage.on !== 'function')
      return null;

    let handler = (event) => {
      this.emitRuntimeEvent('tokens.updated', event || {
        tokenUsage: typeof tokenUsage.snapshot === 'function' ? tokenUsage.snapshot() : {},
      });
    };
    tokenUsage.on('updated', handler);
    return () => tokenUsage.off?.('updated', handler);
  }
}

function resolveService(services, name) {
  if (services?.[name])
    return services[name];

  if (services?.context?.has?.(name) && typeof services.context.require === 'function')
    return services.context.require(name);

  if (typeof services?.context?.require === 'function') {
    try {
      return services.context.require(name);
    } catch (_error) {
      return null;
    }
  }

  return null;
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

function normalizeSessionGeneration(value, parentSessionID = '') {
  if (value == null)
    return parentSessionID ? 1 : 0;

  let number = Number(value);
  if (!Number.isFinite(number) || number < 0)
    return parentSessionID ? 1 : 0;

  return Math.trunc(number);
}

function normalizeOptionalString(value) {
  if (typeof value !== 'string')
    return '';

  return value.trim();
}

function normalizeFrameLimit(value) {
  if (value == null)
    return DEFAULT_SESSION_FRAME_LIMIT;

  let number = Number(value);
  if (!Number.isInteger(number) || number < 1)
    throw new TypeError('frame limit must be a positive integer');

  return Math.min(number, MAX_SESSION_FRAME_LIMIT);
}

function normalizeFrameWindowLimit(value) {
  return Math.min(value, MAX_SESSION_FRAME_LIMIT);
}

function normalizeFrameOffset(value) {
  if (value == null)
    return 0;

  let number = Number(value);
  if (!Number.isInteger(number) || number < 0)
    throw new TypeError('frame offset must be a non-negative integer');

  return number;
}

function normalizeRecoveryLimit(value, defaultValue) {
  let number = Number(value);
  if (!Number.isInteger(number) || number < 1)
    return defaultValue;

  return Math.min(number, 5000);
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

function normalizeCoordinatorAgentID(coordinatorAgentID, participantAgentIDs) {
  if (typeof coordinatorAgentID === 'string') {
    let trimmed = coordinatorAgentID.trim();
    if (participantAgentIDs.includes(trimmed))
      return trimmed;
  }

  return participantAgentIDs[0] || null;
}

function collectToolResultIDs(frames) {
  let ids = new Set();
  for (let frame of frames) {
    let toolCallID = normalizeOptionalString(frame?.content?.toolCallID);
    if (!toolCallID)
      continue;

    if (frame?.content?.phase === 'result' || frame?.authorType === 'tool')
      ids.add(toolCallID);
  }

  return ids;
}

function isStaleAgentResponseFrame(frame) {
  return frame?.type === 'AgentMessage'
    && frame.hidden === true
    && frame.deleted !== true
    && frame.content?.status === 'streaming';
}

function isStaleToolCallFrame(frame, toolResultIDs) {
  if (!frame?.type || !frame.type.endsWith('ToolFrame'))
    return false;

  let content = frame.content || {};
  let toolCallID = normalizeOptionalString(content.toolCallID);
  return content.phase === 'call'
    && (content.status === 'running' || frame.state?.status === 'running')
    && (!toolCallID || !toolResultIDs.has(toolCallID));
}

function createRecoveredAgentResponseFrame(frame, options = {}) {
  let now = options.clock?.() || Date.now();
  let text = options.message
    || 'Kikx recovered this agent response after a server restart or interrupted provider stream. The original response did not complete.';
  return {
    ...frame,
    hidden: false,
    deleted: false,
    updatedAt: now,
    content: {
      ...(frame.content || {}),
      text,
      status: 'error',
      error: {
        message: text,
        recovered: true,
        previousStatus: frame.content?.status || null,
      },
      thinking: {
        ...(frame.content?.thinking || {}),
        status: 'error',
      },
    },
    state: {
      ...(frame.state || {}),
      status: 'error',
      recovered: true,
    },
  };
}

function createRecoveredToolCallFrame(frame, options = {}) {
  let now = options.clock?.() || Date.now();
  let text = options.message
    || 'Kikx recovered this tool call after a server restart. The managed process/result state was no longer available.';
  return {
    ...frame,
    hidden: frame.hidden ?? false,
    deleted: false,
    updatedAt: now,
    content: {
      ...(frame.content || {}),
      status: 'failed',
      recovered: true,
      message: text,
      error: {
        message: text,
        recovered: true,
      },
      finishedAt: now,
    },
    state: {
      ...(frame.state || {}),
      status: 'failed',
      recovered: true,
    },
  };
}

function countMessageFrames(frames) {
  if (!Array.isArray(frames))
    return 0;

  return frames.filter(isVisibleThreadFrame).length;
}

function isVisibleThreadFrame(frame) {
  return Boolean(frame?.id)
    && frame.hidden !== true
    && frame.deleted !== true
    && frame.phantom !== true;
}

function maxFrameTimestamp(frames) {
  let max = null;
  for (let frame of Array.isArray(frames) ? frames : []) {
    let value = normalizePositiveTimestamp(frame?.updatedAt || frame?.createdAt || frame?.timestamp);
    if (value && (!max || value > max))
      max = value;
  }

  return max;
}

function normalizePositiveTimestamp(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
    return null;

  return Math.trunc(value);
}

function latestFrameClock(frames) {
  let clock = null;
  for (let frame of Array.isArray(frames) ? frames : []) {
    if (typeof frame?.updatedClock === 'string' && frame.updatedClock)
      clock = frame.updatedClock;
  }

  return clock;
}
