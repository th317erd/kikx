'use strict';

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

import { FrameStore } from '../aeordb/frame-store.mjs';
import { HybridLogicalClock, defaultUnixMicros } from '../clock/hybrid-logical-clock.mjs';
import { FrameEngine } from '../frames/frame-engine.mjs';
import { FRAME_TYPE_CLASSES, FrameTypeDefault } from '../frames/frame-types/index.mjs';
import { ScheduledFrameQueue } from './scheduled-frame-queue.mjs';
import { countMessageFrames } from '../../shared/frame-manager/frame-manager.mjs';
import {
  effectivePreference,
  normalizePreferenceKey,
  normalizePreferences,
  resolveEffectivePreferences,
} from '../preferences/index.mjs';
import { effectiveSessionAgentIDs, effectiveSessionTeamIDs } from '../../shared/session-actors.mjs';
import {
  buildUserMessageContent,
  normalizeCoordinatorAgentID,
  normalizeStoredCoordinatorAgentID,
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
import { installComposerMethods } from './frame-runtime-composer.mjs';
import { installPromptMethods } from './frame-runtime-prompts.mjs';

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
    this.services = services || {};
    let pluginRegistry = options.pluginRegistry
      || resolveService(this.services, 'pluginRegistry')
      || this.services?.context?.get?.('pluginRegistry')
      || null;
    this.pluginRegistry = pluginRegistry;
    this.frameStore = frameStore || new FrameStore({
      db,
      extraSessionIndexes: () => pluginRegistry?.getFrameIndexes?.() || [],
    });
    this.db = this.frameStore.aeordb || db || null;
    this.frameRouter = frameRouter;
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

  async sessionScopeLookup(sessionID) {
    let sessions = new Map();
    let current = sessionID;
    let seen = new Set();
    while (current && !seen.has(current)) {
      seen.add(current);
      let session = this.sessions.get(current)?.session || null;
      if (!session && typeof this.frameStore?.loadSession === 'function')
        session = await this.frameStore.loadSession(current);
      if (!session)
        break;
      sessions.set(current, session);
      current = normalizeOptionalString(session.parentSessionID || session.parentSessionId);
    }
    return (id) => sessions.get(id) || null;
  }

  async createSession(input = {}) {
    let stamp = this.nextClockStamp();
    let now = stamp.at;
    let title = normalizeTitle(input.title, this.nextDefaultSessionTitle());
    let participantAgentIDs = normalizeStringArray(input.participantAgentIDs);
    let participantUserIDs = normalizeStringArray(input.participantUserIDs);
    let parentSessionID = normalizeOptionalString(input.parentSessionID || input.parentSessionId);
    if (parentSessionID) {
      let getSession = await this.sessionScopeLookup(parentSessionID);
      let inheritedParticipants = effectiveSessionAgentIDs(parentSessionID, getSession);
      let inheritedTeams = effectiveSessionTeamIDs(parentSessionID, getSession);
      participantAgentIDs = normalizeStringArray([ ...inheritedParticipants, ...participantAgentIDs ]);
      input = { ...input, teamIDs: [ ...inheritedTeams, ...normalizeStringArray(input.teamIDs) ] };
    }
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
      teamIDs: normalizeStringArray(input.teamIDs),
      coordinatorAgentID: normalizeStoredCoordinatorAgentID(input.coordinatorAgentID, participantAgentIDs),
      compactionAgentID: normalizeDesignationAgentID(input.compactionAgentID, participantAgentIDs, 'compactionAgentID'),
      createdAt: input.createdAt || now,
      updatedAt: input.updatedAt || now,
      createdClock: input.createdClock || stamp.clock,
      updatedClock: input.updatedClock || stamp.clock,
      deletedAt: input.deletedAt || null,
      preferences: normalizePreferences(input.preferences),
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
    // Resolve the tree BEFORE the first durable write, so a promoted coordinator
    // is recorded in one write rather than appearing only after a later read.
    await this.applyInitialCoordinator(session);
    await this.frameStore.saveSession(session);
    this.emitRuntimeEvent('session.saved', { sessionID: session.id, session });

    this.sessions.set(session.id, {
      session,
      frameEngine,
      disconnectStore: disconnect,
      framesLoaded: true,
      framesLoadedLimit: Number.POSITIVE_INFINITY,
      activeRuns: 0,
      activeAgentRuns: new Map(),
      steeringAgents: new Set(),
      cancelledAgents: new Set(),
      sessionSuspension: null,
      suspensionPendingWarnings: new Map(),
      suspensionWarnedAgentIDs: new Set(),
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

    if (Object.hasOwn(input, 'participantAgentIDs')) {
      participantAgentIDs = normalizeStringArray(input.participantAgentIDs);
      session.participantAgentIDs = participantAgentIDs;
      session.coordinatorAgentID = normalizeStoredCoordinatorAgentID(session.coordinatorAgentID, participantAgentIDs);
      session.compactionAgentID = normalizeStoredCoordinatorAgentID(session.compactionAgentID, participantAgentIDs);
    }

    if (Object.hasOwn(input, 'teamIDs'))
      session.teamIDs = normalizeStringArray(input.teamIDs);

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

    // Replace (never merge) the session's own preference map. Inheritance is
    // resolved on read, so writing an own value must not freeze ancestor values
    // into the child manifest.
    if (Object.hasOwn(input, 'preferences'))
      session.preferences = normalizePreferences(input.preferences);

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
    // Persist the deleted shape as a copy and only swap it into the live entry
    // after the write succeeds. Previously the live session was stamped first,
    // so a failed save left the cache looking deleted (getSession reported a
    // deletedAt and the object was mutated) while nothing was persisted. Now a
    // throw leaves the caller's view -- getSession and listSessions -- unchanged.
    let deleted = {
      ...session,
      deletedAt: input.deletedAt || now,
      updatedAt: now,
      updatedClock: stamp.clock,
    };

    await this.frameStore.saveSession(deleted);
    this.emitRuntimeEvent('session.saved', { sessionID: deleted.id, session: deleted });

    if (entry)
      entry.session = deleted;

    return deleted;
  }

  getSession(sessionID) {
    return this.sessions.get(sessionID)?.session || null;
  }

  // Effective preferences = defaults, then ancestor values root-to-leaf, then
  // this session's own values. Reads the live cache first so a command sees the
  // manifest it just wrote, then falls back to durable storage for ancestors
  // that are not loaded (including after a restart).
  async getEffectivePreferences(sessionID, options = {}) {
    let resolved = await resolveEffectivePreferences(sessionID, {
      getSession: (id) => this.getSession(id),
      loadSession: (id) => this.frameStore.loadSession(id),
      defaults: options.defaults,
    });

    if (!resolved.complete && resolved.chain.length === 0) {
      let error = new Error(`Unknown session: ${sessionID}`);
      error.status = 404;
      throw error;
    }

    return resolved;
  }

  async getEffectivePreference(sessionID, key, fallback = undefined) {
    let normalizedKey = normalizePreferenceKey(key);
    let resolved = await this.getEffectivePreferences(sessionID);
    return effectivePreference(resolved.preferences, normalizedKey, fallback);
  }

  // Return shallow copies with `effectivePreferences` attached. The durable
  // manifest keeps only the session's own values; this field is derived session
  // data for API/UI consumers and is never written back.
  async attachEffectivePreferences(sessions, options = {}) {
    let list = Array.isArray(sessions) ? sessions : [];
    if (list.length === 0)
      return [];

    let cache = new Map();
    for (let session of Array.isArray(options.seed) ? options.seed : []) {
      if (session?.id)
        cache.set(session.id, session);
    }

    let decorated = [];
    for (let session of list) {
      if (!session?.id) {
        decorated.push(session);
        continue;
      }

      cache.set(session.id, session);
      let resolved = await resolveEffectivePreferences(session.id, {
        sessionCache: cache,
        loadSession: (id) => this.frameStore.loadSession(id),
        defaults: options.defaults,
      });
      decorated.push({
        ...session,
        effectivePreferences: resolved.preferences,
      });
    }

    return decorated;
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
    let visible = options.includeDeleted === true
      ? sessions
      : sessions.filter((session) => !session.deletedAt);

    return await this.attachEffectivePreferences(visible, { seed: sessions });
  }

  // Append a frame of a plugin-declared type.
  //
  // Transport plugins own frame types that are not user messages: a Discord
  // message is written by a bot on somebody's behalf, not by the person reading
  // the session. Until this existed `#appendUserMessage` hardcoded
  // `type: 'UserMessage'`, so the only way to put a transport message into a
  // session was to impersonate the owner - which is the defect this closes.
  //
  // Two things are deliberately NOT taken from the caller:
  //
  //   type      - resolved through the registry, so the frame type must already be
  //               registered (and therefore attributable to a plugin) or this throws.
  //   agentOnly - read from the registered class, so a caller cannot claim a frame
  //               is thread-visible when its class says otherwise, or the reverse.
  //
  // A frame type that is not registered falls back to the built-in map and then to
  // FrameTypeDefault. FrameTypeDefault is not an acceptable target here: it would
  // silently accept any typo as a real frame type, so an unknown name throws.
  async appendFrame(sessionID, input = {}) {
    let type = normalizeOptionalString(input.type);
    if (!type)
      throw new TypeError('appendFrame requires a frame type');

    let TypeClass = this.#resolveFrameTypeClass(type);
    if (!TypeClass)
      throw new TypeError(`appendFrame: frame type "${type}" is not registered`);

    return this.#appendFrame(sessionID, input, {
      type,
      agentOnly: TypeClass.agentOnly === true,
    });
  }

  #resolveFrameTypeClass(type) {
    let registry = this.pluginRegistry;
    if (registry && typeof registry.getClass === 'function') {
      let resolved = registry.getClass(`FrameType${type}`);
      if (resolved)
        return resolved;
    }

    // Built-in types are not in the registry unless core-classes registered them,
    // so consult the static map too. An unknown name must not resolve to Default.
    let builtIn = FRAME_TYPE_CLASSES[type];
    if (builtIn)
      return builtIn;

    let fallback = registry && typeof registry.getClass === 'function'
      ? registry.getClass('FrameTypeDefault')
      : FrameTypeDefault;
    return type === 'Default' ? fallback : null;
  }

  // Append without waking anything. An edit to a message already in the session must not
  // start an agent turn: the bot sees the change in its context when it next runs.
  async appendUserMessageQuietly(sessionID, input = {}) {
    return this.#appendUserMessage(sessionID, input, { wake: false });
  }

  async appendUserMessage(sessionID, input = {}) {
    return this.#appendUserMessage(sessionID, input, { wake: true });
  }

  async #appendUserMessage(sessionID, input = {}, { wake = true } = {}) {
    return this.#appendFrame(sessionID, input, { wake, type: 'UserMessage', agentOnly: false });
  }

  // The one frame-construction path. `type` and `agentOnly` are resolved by the
  // caller from a registered frame-type class, never from `input`.
  async #appendFrame(sessionID, input = {}, { wake = true, type = 'UserMessage', agentOnly = false } = {}) {
    let entry = await this.ensureSessionEntry(sessionID);
    // cancelAutonomousWakes() and the router flush both yield. Ordinary LRU
    // pressure could evict this runtime in between and detach the captured
    // engine, silently dropping the user message and its manifest update. Pin
    // for the whole call; release on both the success and throw paths.
    this.pinSession(sessionID);
    try {
      if (wake)
        await this.cancelAutonomousWakes(sessionID);
      let text = normalizeText(input.text ?? input.content?.text);
      let stamp = this.nextClockStamp();
      let now = stamp.at;
      let interactionID = input.interactionID || input.interactionId || this.idGenerator();
      let frame = {
        id: input.id || this.idGenerator(),
        type,
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
        content: buildUserMessageContent(text, input.content),
      };

      // Off the frame entirely unless true, so every ordinary user message stays
      // byte-identical to before this path existed.
      if (agentOnly)
        frame.agentOnly = true;

      // An explicit target is what turns a plain message into a single-agent
      // wake: resolveRouteTargets() short-circuits to a single-target bypass
      // when the target is a participant. Without this the message routes by
      // the usual rules and the asker may never be the one that runs.
      let targetAgentID = normalizeOptionalString(input.targetAgentID || input.target_agent_id);
      if (targetAgentID)
        frame.targetAgentID = targetAgentID;

      // Continuation metadata (question answers, steer markers). Kept off the
      // frame entirely when absent so ordinary user messages are byte-identical
      // to before.
      if (input.continuation && typeof input.continuation === 'object')
        frame.continuation = input.continuation;

      let frames = entry.frameEngine.merge([ frame ], {
        authorType: 'user',
        authorID: frame.authorID,
      });

      if (frames.length === 0)
        throw new Error('UserMessage commit produced no frames');

      // If an agent turn is already running, this message is a steering input.
      // The active route checks this flag between streamed outputs and yields to
      // the new turn instead of finishing its old plan first.
      let steering = this.noteSteering(sessionID, frames[0]);
      // Callers need the frame they just appended - a transport has to remember which
      // frame a message became so a later edit can update it rather than duplicate it.
      // Returning it here rather than at the end keeps the value available on every exit
      // path below, and costs nothing when nobody looks.
      this._lastAppendedFrame = frames[0] || frame;

      let manifestSave = this._sessionManifestSaves.get(sessionID);
      await this.frameStore.flush();

      entry.session.updatedAt = now;
      entry.session.updatedClock = stamp.clock;
      entry.session.messageCount = countMessageFrames(entry.frameEngine.toArray());
      if (!manifestSave)
        manifestSave = this.queueSessionManifestSave(entry);
      await manifestSave;

      // A message that acknowledges a composer draft makes that draft obsolete.
      // Delete it as part of the message commit so a lost client DELETE or an
      // in-flight draft PUT cannot leave the sent text to be restored on reload.
      if (input.draftID && frame.authorID) {
        try {
          await this.deleteComposerDraft(sessionID, {
            draftID: input.draftID,
            userID: frame.authorID,
          });
        } catch (error) {
          this.logger?.warn?.('FrameRuntime failed to clear a submitted composer draft', error);
        }
      }

      // A steering message is already queued for the active run; waiting on
      // background agent work here would block the HTTP response until that
      // turn ends, which is exactly the latency steering is meant to avoid.
      //
      // Question default answers are appended by a scheduled-frame plugin that
      // runs inside FrameRouter.routeCommit(); awaiting router.flush() there
      // waits on the very pass that is making the call, deadlocking the session
      // and every later user message behind it. Internal scheduled deliveries
      // opt out explicitly. HTTP message routes also opt out so the durable
      // message returns to the UI immediately instead of waiting for agent
      // routing; the router still processes the commit asynchronously.
      if (input.flushRouter !== false)
        await this.frameRouter?.flush?.(steering ? { background: false } : undefined);

      return {
        session: entry.session,
        frame: frames[0],
        commit: entry.frameEngine.getLatestCommit(),
        // Whether the caller still has to wait for agent work before this
        // message is picked up. A steering message goes to a turn that is
        // already running (so it has been picked up); anything else queues an
        // agent run in the background. Callers report this instead of guessing
        // that "the router flushed" means "the agent has it".
        wakePending: steering !== true,
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

  // A "stored and dispatched" barrier: every queued commit has been written and
  // every post-persist routing pass has settled.
  //
  // `options.background: false` settles the routing queue WITHOUT waiting for
  // the agent (LLM) work that routing started. Callers that must not hold an
  // HTTP response open for a whole agent turn pass it: an answer POST that waits
  // on the receiving agent's reply leaves the user's "Sending…" up for minutes.
  async flush(options = {}) {
    await this.frameStore.flush();
    await this.frameRouter?.flush?.(options);
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

    let routerOptions = { services: this.routerServices() };
    let disconnects = [
      () => {
        frameEngine.off('frame:phantom', phantomHandler);
        frameEngine.off('commit', commitHandler);
      },
      this.frameStore.connect(frameEngine, {
        sessionID: session.id,
        // Persist-then-route: the router is driven only after the store confirms
        // the committed frames are durable, so no turn acts on unpersisted state.
        onCommitted: ({ commit, frames }) => {
          this.frameRouter?.enqueueCommit?.(frameEngine, commit, session, routerOptions, frames);
        },
      }),
    ];

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
installComposerMethods(FrameRuntime.prototype);
installPromptMethods(FrameRuntime.prototype);
