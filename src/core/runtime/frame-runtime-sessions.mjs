'use strict';

import { FrameEngine } from '../frames/frame-engine.mjs';
import { installRuntimeMethods } from './frame-runtime-mixins.mjs';
import {
  latestFrameClock,
  maxFrameTimestamp,
  normalizeFrameLimit,
  normalizeCoordinatorAgentID,
  normalizeRequiredString,
  normalizeStringArray,
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

    return entry;
  },

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
  },

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
