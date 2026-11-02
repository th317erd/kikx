'use strict';

// Participant suspension, resume markers, and durable suspension snapshots.

import { buildSuspensionWarning } from './suspension-warning.mjs';
import {
  buildHydratedSuspension,
  buildSessionSuspensionSnapshot,
  createResumeFrame,
  normalizeSuspendedAgentIDs,
  SESSION_RESUME_AUTHOR_ID,
} from './session-suspension-persistence.mjs';

export const sessionSuspensionMethods = {
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
};
