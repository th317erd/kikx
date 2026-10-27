'use strict';

import { buildSuspensionWarning } from './suspension-warning.mjs';
import {
  buildHydratedSuspension,
  buildSessionSuspensionSnapshot,
  createResumeFrame,
  normalizeSuspendedAgentIDs,
  SESSION_RESUME_AUTHOR_ID,
} from './session-suspension-persistence.mjs';

import { FrameEngine } from '../frames/frame-engine.mjs';
import { installRuntimeMethods } from './frame-runtime-mixins.mjs';
import {
  COORDINATOR_MAX_ANCESTOR_DEPTH,
  parentSessionIDOf,
  resolveSessionCoordinator,
} from '../agents/coordinator-scope.mjs';
import {
  latestFrameClock,
  maxFrameTimestamp,
  normalizeFrameLimit,
  normalizeCoordinatorAgentID,
  normalizeStoredCoordinatorAgentID,
  normalizeOptionalString,
  normalizeRequiredString,
  normalizeStringArray,
  normalizeText,
} from './frame-runtime-normalize.mjs';
import { countMessageFrames } from '../../shared/frame-manager/frame-manager.mjs';
import {
  buildAutonomousCancellation,
  isAutonomousContinuation,
} from './autonomous-chain.mjs';

const sessionMethods = {
  // Supersede pending autonomous wakes in a session. A user message is new
  // authority: any exec-wake or continue-turn continuation that has not fired is
  // marked `cancelled` so it does not dispatch a stale turn. A no-op when none
  // are pending.
  async cancelAutonomousWakes(sessionID) {
    let pending = this.scheduledFrames?.entries;
    if (!pending || pending.size === 0)
      return 0;

    let entry = this.sessions.get(sessionID) || await this.ensureSessionEntry(sessionID);
    let updates = [];
    let now = Number(this.clock?.() || Date.now());

    for (let tracked of pending.values()) {
      if (tracked.sessionID !== sessionID)
        continue;

      let frame = entry.frameEngine?.get(tracked.frameID) || tracked.frame;
      if (!isAutonomousContinuation(frame?.continuation))
        continue;

      updates.push(buildAutonomousCancellation(frame, now));
    }

    if (updates.length === 0)
      return 0;

    let merged = entry.frameEngine.merge(updates, {
      authorType: 'system',
      authorID: 'internal:scheduled-frame-cancel',
      silent: true,
    });
    this.scheduledFrames.trackFrames(merged.length > 0 ? merged : updates);
    await this.frameStore?.flush?.();
    return updates.length;
  },

  requireSessionEntry(sessionID) {
    let entry = this.sessions.get(sessionID);
    if (!entry) {
      let error = new Error(`Unknown session: ${sessionID}`);
      error.status = 404;
      throw error;
    }

    return this.touchSession?.(sessionID) || entry;
  },

  async ensureSessionEntry(sessionID, options = {}) {
    let entry = this.sessions.get(sessionID);
    if (entry) {
      let frameLimit = normalizeFrameLimit(options.frameLimit);
      if (options.loadFrames !== false && (!entry.framesLoaded || entry.framesLoadedLimit < frameLimit)) {
        let frames = await this.frameStore.listFrames(sessionID, {
          limit: frameLimit,
          latest: true,
        });
        entry.frameEngine.hydrate(frames);
        await this.hydrateSessionSuspension(entry, frames);
        // A window of exactly `frameLimit` frames may be truncated; remember
        // that so a recomputed messageCount from it cannot lower the manifest.
        entry.framesWindowComplete = frames.length < frameLimit;
        this.syncSessionManifestFromEngine(entry, { persist: true });
        entry.framesLoaded = true;
        entry.framesLoadedLimit = frameLimit;
      }
      return this.touchSession(sessionID) || entry;
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

    let framesWindowComplete = false;
    let loadedFrames = [];
    if (options.loadFrames !== false) {
      let frameLimit = normalizeFrameLimit(options.frameLimit);
      loadedFrames = await this.frameStore.listFrames(sessionID, {
        limit: frameLimit,
        latest: true,
      });
      frameEngine.hydrate(loadedFrames);
      framesWindowComplete = loadedFrames.length < frameLimit;
    }

    let disconnect = this.connectFrameEngine(frameEngine, session);
    entry = {
      session,
      frameEngine,
      disconnectStore: disconnect,
      framesLoaded: options.loadFrames !== false,
      framesLoadedLimit: options.loadFrames === false ? 0 : normalizeFrameLimit(options.frameLimit),
      framesWindowComplete,
      activeRuns: 0,
      activeAgentRuns: new Map(),
      steeringAgents: new Set(),
      cancelledAgents: new Set(),
      sessionSuspension: null,
      suspensionPendingWarnings: new Map(),
      suspensionWarnedAgentIDs: new Set(),
    };
    this.sessions.set(sessionID, entry);
    this.evictOverflowSessionRuntimes();
    if (options.loadFrames !== false)
      await this.hydrateSessionSuspension(entry, loadedFrames);
    if (options.loadFrames !== false)
      this.syncSessionManifestFromEngine(entry, { persist: true });
    return entry;
  },

  // Active agent turns can be steered by a user message instead of waiting for
  // the whole turn (and every tool round) to finish. The run records the order
  // it started at; only messages committed after that point are steering.
  markAgentRunStart(sessionID, agentID, startedOrder = null) {
    let entry = this.sessions.get(sessionID);
    if (!entry || !agentID)
      return false;

    startedOrder = startedOrder ?? entry.frameEngine.getLatestCommit?.()?.order;
    entry.activeAgentRuns ||= new Map();
    entry.steeringAgents ||= new Set();
    entry.activeAgentRuns.set(agentID, {
      startedOrder: Number.isFinite(Number(startedOrder)) ? Number(startedOrder) : null,
    });
    entry.steeringAgents.delete(agentID);
    entry.cancelledAgents?.delete(agentID);
    return true;
  },

  markAgentRunEnd(sessionID, agentID) {
    let entry = this.sessions.get(sessionID);
    if (!entry)
      return false;

    entry.activeAgentRuns?.delete(agentID);
    entry.steeringAgents?.delete(agentID);
    entry.cancelledAgents?.delete(agentID);
    return true;
  },

  countActiveAgentRuns() {
    let count = 0;
    for (let entry of this.sessions.values())
      count += entry.activeAgentRuns?.size || 0;
    return count;
  },

  // Shutdown must not cut through an in-process tool call (read-file, write-file,
  // etc.) just because no managed child process exists. Wait for active agent
  // turns to drain, with a bounded deadline for genuinely stuck providers.
  async waitForAgentRuns(options = {}) {
    let timeoutMS = Number.isFinite(Number(options.timeoutMS)) ? Math.max(0, Number(options.timeoutMS)) : 30000;
    let intervalMS = Number.isFinite(Number(options.intervalMS)) ? Math.max(1, Number(options.intervalMS)) : 50;
    let startedAt = Date.now();
    let deadline = startedAt + timeoutMS;

    while (this.countActiveAgentRuns() > 0) {
      let remainingMS = deadline - Date.now();
      if (remainingMS <= 0)
        break;
      await new Promise((resolve) => {
        let timer = setTimeout(resolve, Math.min(intervalMS, remainingMS));
        timer.unref?.();
      });
    }

    let remaining = this.countActiveAgentRuns();
    return {
      timedOut: remaining > 0,
      remaining,
      waitedMS: Date.now() - startedAt,
    };
  },

  noteSteering(sessionID, frame) {
    let entry = this.sessions.get(sessionID);
    if (!entry?.activeAgentRuns || entry.activeAgentRuns.size === 0)
      return false;

    let targetAgentID = normalizeOptionalString(frame?.targetAgentID)
      || normalizeOptionalString(entry.session?.coordinatorAgentID);
    let order = Number(frame?.order);
    let changed = false;

    for (let [agentID, run] of entry.activeAgentRuns) {
      if (targetAgentID && targetAgentID !== agentID)
        continue;
      if (Number.isFinite(order) && run.startedOrder != null && order <= run.startedOrder)
        continue;

      entry.steeringAgents ||= new Set();
      entry.steeringAgents.add(agentID);
      changed = true;
    }

    return changed;
  },

  hasAgentSteering(sessionID, agentID) {
    let entry = this.sessions.get(sessionID);
    return Boolean(entry?.steeringAgents?.has(agentID));
  },

  cancelAgentRuns(sessionID, targetAgentID = null) {
    let entry = this.sessions.get(sessionID);
    if (!entry?.activeAgentRuns)
      return [];

    let target = targetAgentID ? String(targetAgentID) : null;
    let cancelled = [];
    for (let agentID of entry.activeAgentRuns.keys()) {
      if (target && agentID !== target)
        continue;
      entry.cancelledAgents ||= new Set();
      entry.cancelledAgents.add(agentID);
      cancelled.push(agentID);
    }
    return cancelled;
  },

  hasAgentCancellation(sessionID, agentID) {
    let entry = this.sessions.get(sessionID);
    return Boolean(entry?.cancelledAgents?.has(agentID));
  },

  suspendSession(sessionID, options = {}) {
    let entry = this.sessions.get(sessionID);
    if (!entry)
      return false;

    let agentIDs = normalizeSuspendedAgentIDs(options.agentIDs);
    let priorSuspend = entry.sessionSuspension?.active ? entry.sessionSuspension : null;
    let suspendedAgentIDs = new Set(priorSuspend?.suspendedAgentIDs || []);
    let warnedAgentIDs = new Set(priorSuspend?.warnedAgentIDs || []);
    entry.suspensionWarnedAgentIDs ||= new Set();
    for (let agentID of warnedAgentIDs)
      entry.suspensionWarnedAgentIDs.add(agentID);

    for (let agentID of agentIDs) {
      suspendedAgentIDs.add(agentID);
      warnedAgentIDs.delete(agentID);
      entry.suspensionWarnedAgentIDs.delete(agentID);
    }

    entry.suspensionPendingWarnings?.clear();
    entry.sessionSuspension = {
      active: true,
      suspendedAt: options.suspendedAt || priorSuspend?.suspendedAt || Date.now(),
      suspendedByUserID: options.userID || priorSuspend?.suspendedByUserID || null,
      coordinatorAgentID: options.coordinatorAgentID || entry.session?.coordinatorAgentID || priorSuspend?.coordinatorAgentID || null,
      reason: options.reason || priorSuspend?.reason || 'user-suspend',
      suspendedAgentIDs,
      warnedAgentIDs,
      restarted: false,
    };
    for (let agentID of suspendedAgentIDs)
      entry.cancelledAgents?.add(agentID);
    this.syncSessionSuspensionSnapshot(entry);
    this.queueSessionManifestSave(entry);
    return true;
  },

  getSessionSuspension(sessionID) {
    let suspend = this.sessions.get(sessionID)?.sessionSuspension;
    if (!suspend?.active)
      return null;
    return {
      active: true,
      suspendedAt: suspend.suspendedAt,
      suspendedByUserID: suspend.suspendedByUserID,
      coordinatorAgentID: suspend.coordinatorAgentID,
      reason: suspend.reason,
      suspendedAgentIDs: [ ...suspend.suspendedAgentIDs ],
      restarted: suspend.restarted === true,
    };
  },

  listActiveAgentRuns(sessionID) {
    let entry = this.sessions.get(sessionID);
    return [ ...(entry?.activeAgentRuns?.keys() || []) ];
  },

  isSessionSuspended(sessionID) {
    return Boolean(this.sessions.get(sessionID)?.sessionSuspension?.active);
  },

  isAgentSuspended(sessionID, agentID) {
    let suspend = this.sessions.get(sessionID)?.sessionSuspension;
    return Boolean(suspend?.active && agentID && suspend.suspendedAgentIDs?.has(agentID));
  },

  suspendAgent(sessionID, agentID) {
    let entry = this.sessions.get(sessionID);
    if (!entry || !agentID)
      return false;
    entry.suspensionWarnedAgentIDs ||= new Set();
    entry.sessionSuspension ||= {
      active: true,
      suspendedAt: Date.now(),
      suspendedByUserID: null,
      coordinatorAgentID: entry.session?.coordinatorAgentID || null,
      reason: 'agent-suspend',
      suspendedAgentIDs: new Set(),
      warnedAgentIDs: new Set(),
      restarted: false,
    };
    entry.sessionSuspension.active = true;
    entry.sessionSuspension.suspendedAgentIDs.add(agentID);
    entry.sessionSuspension.warnedAgentIDs.delete(agentID);
    entry.suspensionWarnedAgentIDs.delete(agentID);
    entry.suspensionPendingWarnings?.delete(agentID);
    entry.cancelledAgents?.add(agentID);
    this.syncSessionSuspensionSnapshot(entry);
    this.queueSessionManifestSave(entry);
    return true;
  },

  resumeAgent(sessionID, agentID, options = {}) {
    let entry = this.sessions.get(sessionID);
    let suspend = entry?.sessionSuspension;
    if (!suspend || !agentID)
      return false;
    let suspendedAgentIDs = [ ...suspend.suspendedAgentIDs ];
    let removed = suspend.suspendedAgentIDs.delete(agentID);
    suspend.warnedAgentIDs.delete(agentID);
    entry.suspensionWarnedAgentIDs?.delete(agentID);
    entry.cancelledAgents?.delete(agentID);
    if (removed && suspend.active) {
      // Keep the warning alive even when resuming this agent clears the last
      // suspension and therefore the suspension itself. The coordinator may
      // resume and immediately route to the final worker in the same turn.
      entry.suspensionPendingWarnings ||= new Map();
      entry.suspensionPendingWarnings.set(agentID, {
        message: buildSuspensionWarning({
          isCoordinator: agentID === suspend.coordinatorAgentID,
          suspendedAgentIDs,
          restarted: suspend.restarted === true,
        }),
        suspendedAgentIDs,
      });
    }
    if (suspend.suspendedAgentIDs.size === 0)
      entry.sessionSuspension = null;
    if (removed) {
      this.syncSessionSuspensionSnapshot(entry);
      if (options.persist !== false)
        this.queueSessionManifestSave(entry);
    }
    return removed;
  },

  consumeAgentSuspensionWarning(sessionID, agentID, options = {}) {
    let entry = this.sessions.get(sessionID);
    let suspend = entry?.sessionSuspension;
    if (!agentID)
      return null;
    if (!suspend?.active) {
      let pending = entry?.suspensionPendingWarnings?.get(agentID);
      if (!pending)
        return null;
      entry.suspensionPendingWarnings.delete(agentID);
      entry.suspensionWarnedAgentIDs ||= new Set();
      entry.suspensionWarnedAgentIDs.add(agentID);
      this.syncSessionSuspensionSnapshot(entry);
      this.queueSessionManifestSave(entry);
      return pending;
    }
    let isCoordinator = agentID === suspend.coordinatorAgentID || options.isCoordinator === true;
    if (!isCoordinator && suspend.warnedAgentIDs.has(agentID))
      return null;
    suspend.warnedAgentIDs.add(agentID);
    entry.suspensionWarnedAgentIDs ||= new Set();
    entry.suspensionWarnedAgentIDs.add(agentID);
    entry.suspensionPendingWarnings?.delete(agentID);
    if (!isCoordinator) {
      this.syncSessionSuspensionSnapshot(entry);
      this.queueSessionManifestSave(entry);
    }
    let suspendedAgentIDs = [ ...suspend.suspendedAgentIDs ]
      .filter((suspendedAgentID) => !isCoordinator || suspendedAgentID !== agentID);
    return {
      message: buildSuspensionWarning({
        isCoordinator,
        suspendedAgentIDs,
        platform: options.platform || process.platform,
        restarted: suspend.restarted === true,
      }),
      suspendedAgentIDs,
    };
  },

  async recordAgentResumes(sessionID, agentIDs = [], options = {}) {
    let entry = this.sessions.get(sessionID) || await this.ensureSessionEntry(sessionID, { loadFrames: false });
    if (!entry?.sessionSuspension?.active)
      return [];

    let ids = normalizeSuspendedAgentIDs(agentIDs)
      .filter((agentID) => entry.sessionSuspension.suspendedAgentIDs.has(agentID));
    if (ids.length === 0)
      return [];

    let agentNames = { ...(options.agentNames || {}) };
    if (options.agentManager?.getAgent) {
      for (let agentID of ids) {
        if (agentNames[agentID])
          continue;
        try {
          let agent = await options.agentManager.getAgent(agentID);
          agentNames[agentID] = agent?.name || agentID;
        } catch (_error) {
          agentNames[agentID] = agentID;
        }
      }
    }

    let timestamp = Date.now();
    let frames = ids.map((agentID) => createResumeFrame({
      id: this.idGenerator(),
      sessionID,
      agentID,
      agentName: agentNames[agentID] || (ids.length === 1 ? options.agentName : ''),
      reason: options.reason || 'resume',
      timestamp,
    }));
    let merged = entry.frameEngine.merge(frames, {
      authorType: 'system',
      authorID: SESSION_RESUME_AUTHOR_ID,
      silent: true,
    });
    await this.frameStore?.flush?.();
    for (let agentID of ids)
      this.resumeAgent(sessionID, agentID, { persist: false });
    this.syncSessionSuspensionSnapshot(entry);
    await this.frameStore?.saveSessionManifest?.(entry.session);
    this.emitRuntimeEvent('session.saved', { sessionID, session: entry.session });
    return merged.length > 0 ? merged : frames;
  },

  async persistSessionSuspension(sessionID) {
    let entry = this.sessions.get(sessionID);
    if (entry) {
      this.syncSessionSuspensionSnapshot(entry);
      await this.frameStore?.saveSessionManifest?.(entry.session);
      this.emitRuntimeEvent('session.saved', { sessionID, session: entry.session });
    }
    return entry?.sessionSuspension || null;
  },

  syncSessionSuspensionSnapshot(entry) {
    if (!entry?.session)
      return null;
    delete entry.session.halt;
    let snapshot = buildSessionSuspensionSnapshot(entry);
    if (snapshot)
      entry.session.suspension = snapshot;
    else
      delete entry.session.suspension;
    return snapshot;
  },

  async hydrateSessionSuspension(entry, frames = []) {
    if (!entry?.session)
      return null;
    let priorSnapshot = entry.session.suspension || entry.session.halt || null;
    let hydrated = buildHydratedSuspension(entry, priorSnapshot, frames);
    entry.sessionSuspension = hydrated.sessionSuspension;
    entry.suspensionPendingWarnings = hydrated.suspensionPendingWarnings;
    entry.suspensionWarnedAgentIDs = hydrated.suspensionWarnedAgentIDs;
    for (let agentID of entry.sessionSuspension?.suspendedAgentIDs || [])
      entry.cancelledAgents?.add(agentID);

    this.syncSessionSuspensionSnapshot(entry);
    if (JSON.stringify(priorSnapshot) !== JSON.stringify(entry.session.suspension || null))
      this.queueSessionManifestSave(entry);
    return entry.sessionSuspension;
  },

  async inviteAgentToSession(sessionID, agent, input = {}) {
    let entry = await this.ensureSessionEntry(sessionID, { loadFrames: false });
    let agentID = normalizeRequiredString(agent?.id, 'agent.id');
    let participantAgentIDs = normalizeStringArray(entry.session.participantAgentIDs);
    let alreadyParticipant = participantAgentIDs.includes(agentID);

    if (!alreadyParticipant)
      participantAgentIDs.push(agentID);

    entry.session.participantAgentIDs = participantAgentIDs;
    // Store the coordinator as-is unless it is no longer a participant. Inviting
    // must not crown the newcomer: an existing coordinator stays, and a session that
    // had none keeps none (it inherits, or is promoted by the tree resolver).
    entry.session.coordinatorAgentID = normalizeStoredCoordinatorAgentID(
      entry.session.coordinatorAgentID,
      participantAgentIDs,
    );

    // Re-resolve against the tree after the participant list changed. This is
    // what makes a root session that has just gained its first bot actually get
    // a coordinator, and it is deliberately the full resolver: in a session
    // below a coordinated ancestor, rules 1-2 answer before rule 3, so a child
    // holding only non-coordinator bots is never crowned (owner requirement 1).
    await this.applyTreeCoordinator(entry);
    let stamp = this.nextClockStamp();
    entry.session.updatedAt = input.updatedAt || input.invitedAt || stamp.at;
    entry.session.updatedClock = input.updatedClock || input.invitedClock || stamp.clock;

    // A suspended session freezes whoever is in it, so whoever joins it joins
    // the freeze. Without this, a bot invited after the user pressed STOP was
    // live inside the halted session and a single wake would run it there: the
    // invite path was the only gate that never consulted sessionSuspension,
    // while tool execution (tool-execution-service.mjs), process spawn
    // (process-manager.mjs) and routing (agent-route-frame-plugin.mjs) all do.
    //
    // This is the inverse of an un-halt: only resumeAgent clears a suspension,
    // so re-inviting an already-frozen member cannot release it either.
    if (entry.sessionSuspension?.active) {
      entry.sessionSuspension.suspendedAgentIDs.add(agentID);
      entry.sessionSuspension.warnedAgentIDs.delete(agentID);
      // Clear the "already warned" mark: the recovery warning is delivered on
      // the agent's next turn, and a stale mark would suppress it.
      entry.suspensionWarnedAgentIDs?.delete(agentID);
      entry.cancelledAgents?.add(agentID);
      this.syncSessionSuspensionSnapshot(entry);
    }

    await this.frameStore.saveSessionManifest(entry.session);
    this.emitRuntimeEvent('session.saved', { sessionID, session: entry.session });

    return {
      session: entry.session,
      agentID,
      alreadyParticipant,
    };
  },

  // Wake one invited agent with a hidden, targeted, immediately-due UserMessage.
  // The explicit targetAgentID bypasses the coordinator-targeting rule, so the
  // invited agent runs without waiting for a separate @mention. This mirrors the
  // durable process-wake frame shape: hidden, scheduled, and flushed before the
  // queue can fire it.
  async wakeAgentInSession(sessionID, input = {}) {
    let agentID = normalizeRequiredString(input.agentID || input.agent?.id, 'agentID');
    let entry = await this.ensureSessionEntry(sessionID);
    let stamp = this.nextClockStamp();
    let now = stamp.at;
    let frame = {
      id: input.id || this.idGenerator(),
      type: 'UserMessage',
      sessionID,
      interactionID: input.interactionID || this.idGenerator(),
      parentID: input.parentID || null,
      authorType: 'system',
      authorID: input.authorID || 'internal:session-invite',
      authorDisplayName: input.authorDisplayName || 'Kikx session invite',
      targetAgentID: agentID,
      timestamp: now,
      createdAt: now,
      updatedAt: now,
      createdClock: stamp.clock,
      updatedClock: stamp.clock,
      scheduledAt: now,
      scheduledStatus: 'pending',
      hidden: true,
      deleted: false,
      content: {
        text: normalizeText(input.text) || `You have been invited to session ${entry.session.title || sessionID}. Review the session context and wait for the coordinator's assignment.`,
        status: 'scheduled',
        agentID,
        agentName: input.agentName || '',
        invite: true,
      },
    };

    let frames = entry.frameEngine.merge([ frame ], {
      authorType: 'system',
      authorID: frame.authorID,
    });
    await this.frameStore?.flush?.();
    return frames[0] || entry.frameEngine.get(frame.id) || frame;
  },

  async inviteUserToSession(sessionID, user, input = {}) {
    let entry = await this.ensureSessionEntry(sessionID, { loadFrames: false });
    let userID = normalizeRequiredString(user?.id || user?.actorID || user?.userID, 'user.id');
    let participantUserIDs = normalizeStringArray(entry.session.participantUserIDs);
    let alreadyParticipant = participantUserIDs.includes(userID);

    if (!alreadyParticipant)
      participantUserIDs.push(userID);

    entry.session.participantUserIDs = participantUserIDs;
    let stamp = this.nextClockStamp();
    entry.session.updatedAt = input.updatedAt || input.invitedAt || stamp.at;
    entry.session.updatedClock = input.updatedClock || input.invitedClock || stamp.clock;

    await this.frameStore.saveSessionManifest(entry.session);
    this.emitRuntimeEvent('session.saved', { sessionID, session: entry.session });

    return {
      session: entry.session,
      userID,
      alreadyParticipant,
    };
  },

  nextDefaultSessionTitle() {
    return `Session ${this.sessions.size + 1}`;
  },

  syncSessionManifestFromEngine(entry, options = {}) {
    if (!entry?.session || !entry.frameEngine)
      return entry?.session || null;

    let frames = typeof entry.frameEngine.toArray === 'function'
      ? entry.frameEngine.toArray()
      : [];
    let changedFrames = Array.isArray(options.frames) ? options.frames : frames;
    let nextCount = countMessageFrames(frames);
    let frameUpdatedAt = maxFrameTimestamp(changedFrames);
    // A truncated hydration window undercounts message heads. Never lower a
    // persisted count from a window that may be partial; a complete window (or
    // an upward correction that is a lower bound anyway) may still update it.
    let countWouldDecrease = typeof entry.session.messageCount === 'number'
      && nextCount < entry.session.messageCount;
    let applyCount = entry.framesWindowComplete !== false || !countWouldDecrease;
    let changed = applyCount && entry.session.messageCount !== nextCount;

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
  },

  // Ancestors are hydrated before the tree resolver runs. A cold parent looks
  // identical to a missing one to a cache-only `getSession`, and the resolver
  // would then treat the chain as ended and promote locally -- crowning a child
  // under an already-coordinated ancestor, the exact inversion P1 forbids.
  // Bounded by the resolver's own depth cap, and cycle-guarded.
  async hydrateAncestorSessions(startParentSessionID) {
    let current = startParentSessionID;
    let seen = new Set();
    let depth = 0;

    while (current && depth < COORDINATOR_MAX_ANCESTOR_DEPTH) {
      if (seen.has(current))
        return;
      seen.add(current);

      let entry = null;
      try {
        entry = await this.ensureSessionEntry(current, { loadFrames: false });
      } catch (_error) {
        // Dangling or unreadable parent: stop here and let the resolver report
        // it as 'missing' instead of promoting on an unknown chain.
        return;
      }

      current = parentSessionIDOf(entry?.session) || null;
      depth += 1;
    }
  },

  // Resolve and RECORD the coordinator for a session that is being created. The
  // session is not in the cache yet, so the resolver's lookup falls back to it
  // and the injector writes to that same object, which the caller then saves.
  async applyInitialCoordinator(session) {
    if (!session?.id)
      return null;

    await this.hydrateAncestorSessions(parentSessionIDOf(session));
    return this.applyCoordinatorResolution({ sessionID: session.id, session });
  },

  // Resolve and RECORD the coordinator for a session that already has an entry.
  async applyTreeCoordinator(entry) {
    if (!entry?.session?.id)
      return null;

    await this.hydrateAncestorSessions(parentSessionIDOf(entry.session));
    return this.applyCoordinatorResolution({ sessionID: entry.session.id });
  },

  // The one place a promotion is written. Synchronous on purpose: the resolver
  // takes a synchronous injector, and rule 1 must observe its own write on the
  // very next call, or two resolutions of the same session disagree.
  applyCoordinatorResolution({ sessionID, session = null }) {
    let persistCoordinator = (id, agentID) => {
      let entry = this.sessions.get(id);
      if (entry?.session) {
        if (entry.session.coordinatorAgentID === agentID)
          return true;
        entry.session.coordinatorAgentID = agentID;
        this.queueSessionManifestSave(entry);
        return true;
      }

      if (session && session.id === id) {
        session.coordinatorAgentID = agentID;
        return true;
      }

      return false;
    };

    return resolveSessionCoordinator({
      sessionID,
      getSession: (id) => (session && session.id === id ? session : this.getSession(id)),
      persistCoordinator,
    });
  },

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
  },
};

export function installSessionMethods(prototype) {
  installRuntimeMethods(prototype, sessionMethods);
}
