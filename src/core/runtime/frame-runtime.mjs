'use strict';

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

import { AeorDBFrameStore } from '../aeordb/aeordb-frame-store.mjs';
import { HybridLogicalClock, defaultUnixMicros } from '../clock/hybrid-logical-clock.mjs';
import { FrameEngine } from '../frames/frame-engine.mjs';
import { ScheduledFrameQueue } from './scheduled-frame-queue.mjs';
import { countMessageFrames } from '../../shared/frame-manager/frame-manager.mjs';
import {
  normalizeCoordinatorAgentID,
  normalizeCount,
  normalizeDesignationAgentID,
  normalizeOptionalString,
  normalizeSessionGeneration,
  normalizeStringArray,
  normalizeText,
  normalizeTitle,
  resolveService,
} from './frame-runtime-normalize.mjs';
import { installSessionMethods } from './frame-runtime-sessions.mjs';
import { installFrameMethods } from './frame-runtime-frames.mjs';

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
    let participantUserIDs = normalizeStringArray(input.participantUserIDs);
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
      participantUserIDs,
      coordinatorAgentID: normalizeCoordinatorAgentID(input.coordinatorAgentID, participantAgentIDs),
      compactionAgentID: normalizeDesignationAgentID(input.compactionAgentID, participantAgentIDs, 'compactionAgentID'),
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

    let participantAgentIDs = normalizeStringArray(session.participantAgentIDs);

    if (Object.hasOwn(input, 'title'))
      session.title = normalizeTitle(input.title);

    // Explicit bot designations (compaction P2, ruling R8). Only written when the
    // caller supplies the field, so title-only updates never disturb them. A
    // supplied value must be a current participant; null clears it.
    if (Object.hasOwn(input, 'coordinatorAgentID'))
      session.coordinatorAgentID = normalizeDesignationAgentID(input.coordinatorAgentID, participantAgentIDs, 'coordinatorAgentID');

    if (Object.hasOwn(input, 'compactionAgentID'))
      session.compactionAgentID = normalizeDesignationAgentID(input.compactionAgentID, participantAgentIDs, 'compactionAgentID');

    let stamp = this.nextClockStamp();
    let now = stamp.at;
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

  async appendUserMessage(sessionID, input = {}) {
    let entry = await this.ensureSessionEntry(sessionID);
    await this.cancelAutonomousWakes(sessionID);
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
      recipients: normalizeStringArray(input.recipients),
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

installSessionMethods(FrameRuntime.prototype);
installFrameMethods(FrameRuntime.prototype);
