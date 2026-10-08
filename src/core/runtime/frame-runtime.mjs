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
  normalizeSessionRuntimeLimit,
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

    let db = options.db || options.aeordb;
    let {
      frameStore,
      frameRouter = null,
      services = null,
      clock = defaultUnixMicros,
      logicalClock = null,
      runnerID = null,
      idGenerator = () => randomUUID(),
      scheduledFrameWorkerIntervalMS = 1000,
    } = options;

    if (!db && !frameStore)
      throw new TypeError('FrameRuntime requires db (or the aeordb alias) or frameStore');

    this.clock = clock;
    this.logicalClock = logicalClock || new HybridLogicalClock({
      now: this.clock,
      runnerID,
    });
    this.idGenerator = idGenerator;
    this.frameStore = frameStore || new AeorDBFrameStore({ db });
    this.db = this.frameStore.aeordb || db || null;
    this.frameRouter = frameRouter;
    this.services = services || {};
    this.tokenUsage = options.tokenUsage || resolveService(this.services, 'tokenUsage');
    this._disconnectTokenUsage = this.connectTokenUsage(this.tokenUsage);
    this.logger = options.logger || console;
    this.sessionRuntimeLimit = normalizeSessionRuntimeLimit(options.sessionRuntimeLimit);
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
      deletedAt: input.deletedAt || null,
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
      activeRuns: 0,
    });
    this.evictOverflowSessionRuntimes();

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

    // Restore-from-deleted (the future "show deleted" filter's undo). Only
    // written when the caller supplies the field, so ordinary edits never
    // disturb it.
    if (Object.hasOwn(input, 'deletedAt'))
      session.deletedAt = input.deletedAt || null;

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

  // Soft delete only: stamp the manifest and nothing else. Frames, tool
  // outputs, and the session record itself are never removed — a later "show
  // deleted sessions" filter (and an undo) reads this field. Hard deletion of a
  // session is deliberately unsupported.
  async deleteSession(sessionID, input = {}) {
    let entry = this.sessions.get(sessionID);
    let session = entry?.session || await this.frameStore.loadSession(sessionID);
    if (!session?.id) {
      let error = new Error(`Unknown session: ${sessionID}`);
      error.status = 404;
      throw error;
    }

    let stamp = this.nextClockStamp();
    let now = stamp.at;
    session.deletedAt = input.deletedAt || now;
    session.updatedAt = now;
    session.updatedClock = stamp.clock;

    await this.frameStore.saveSession(session);
    this.emitRuntimeEvent('session.saved', { sessionID: session.id, session });

    if (entry)
      entry.session = session;

    return session;
  }

  getSession(sessionID) {
    return this.sessions.get(sessionID)?.session || null;
  }

  // Move a session to the most-recently-used end of the LRU order. Eviction
  // relies on Map insertion order, so every access must touch.
  touchSession(sessionID) {
    let entry = this.sessions.get(sessionID);
    if (!entry)
      return null;

    this.sessions.delete(sessionID);
    this.sessions.set(sessionID, entry);
    return entry;
  }

  // Pin a session while long-running work holds a captured FrameEngine. Without
  // a pin, an unrelated session load could evict the entry mid-run and the work's
  // later commits would never reach the store (the engine would be detached).
  pinSession(sessionID) {
    let entry = this.sessions.get(sessionID);
    if (!entry)
      return null;

    entry.activeRuns = (entry.activeRuns || 0) + 1;
    return this.touchSession(sessionID);
  }

  unpinSession(sessionID) {
    let entry = this.sessions.get(sessionID);
    if (!entry)
      return null;

    entry.activeRuns = Math.max(0, (entry.activeRuns || 0) - 1);
    this.evictOverflowSessionRuntimes();
    return entry;
  }

  // Evict a live runtime without touching persisted state: disconnect listeners
  // and the store, then drop the cache entry. The session and its frames remain
  // in the durable store and rehydrate on the next access.
  evictSession(sessionID) {
    let entry = this.sessions.get(sessionID);
    if (!entry)
      return false;

    this.sessions.delete(sessionID);
    try {
      entry.disconnectStore?.();
    } catch (error) {
      this.logger?.warn?.('FrameRuntime failed to disconnect an evicted session runtime', error);
    }

    return true;
  }

  // Enforce the live-runtime cap. Iteration follows Map insertion order, which is
  // the LRU order because every access touches. Pinned entries are skipped; if
  // every over-cap entry is pinned the cap is temporarily exceeded rather than
  // breaking an in-flight run.
  evictOverflowSessionRuntimes() {
    let limit = this.sessionRuntimeLimit;
    if (!Number.isFinite(limit) || limit <= 0)
      return;

    while (this.sessions.size > limit) {
      let victim = null;
      for (let [sessionID, entry] of this.sessions) {
        if ((entry.activeRuns || 0) > 0)
          continue;

        victim = sessionID;
        break;
      }

      if (victim == null)
        return;

      this.evictSession(victim);
    }
  }

  // Soft-deleted sessions are hidden from the normal listing but remain in the
  // store: includeDeleted:true is the "show deleted" escape hatch, and
  // getSession/ensureSessionEntry still resolve them by id.
  async listSessions(options = {}) {
    // Filtering happens here, after the store already applied limit/offset, so a
    // page can come back short by the number of deleted sessions it contains.
    // The workspace GET caps at 50 and session counts are small, so this is
    // acceptable; do not add a DB-level filter (all drivers share this path).
    let sessions = await this.frameStore.listSessions(options);
    if (options.includeDeleted === true)
      return sessions;

    return sessions.filter((session) => !session.deletedAt);
  }

  async appendUserMessage(sessionID, input = {}) {
    let entry = await this.ensureSessionEntry(sessionID);
    // cancelAutonomousWakes() and the router flush both yield. Ordinary LRU
    // pressure could evict this runtime in between and detach the captured
    // engine, silently dropping the user message and its manifest update. Pin
    // for the whole call; release on both the success and throw paths.
    this.pinSession(sessionID);
    try {
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
    } finally {
      this.unpinSession(sessionID);
    }
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
    // Load persisted scheduled frames back into memory and arm the worker.
    // Timers are durable state: they always reload across restarts and fire when
    // due. A wake whose process no longer exists is resolved at fire time (the
    // completion output is durable in AeorDB); timers are never discarded merely
    // for being old.
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
