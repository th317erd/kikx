'use strict';

import { buildSuspensionWarning } from './suspension-warning.mjs';

export const SESSION_SUSPEND_AUTHOR_ID = 'internal:user-suspend';
export const SESSION_RESUME_AUTHOR_ID = 'internal:user-resume';
const LEGACY_SESSION_SUSPEND_AUTHOR_ID = 'internal:user-halt';

export function normalizeSuspendedAgentIDs(value) {
  let values = Array.isArray(value) ? value : [];
  return [ ...new Set(values.filter((id) => typeof id === 'string' && id.trim() !== '')) ];
}

export function createSuspensionReplayState(snapshot = null, session = {}) {
  let active = snapshot?.active === true;
  return {
    active,
    suspendedAt: normalizeTimestamp(snapshot?.suspendedAt ?? snapshot?.haltedAt),
    suspendedByUserID: typeof snapshot?.suspendedByUserID === 'string'
      ? snapshot.suspendedByUserID
      : (typeof snapshot?.haltedByUserID === 'string' ? snapshot.haltedByUserID : null),
    coordinatorAgentID: normalizeOptional(snapshot?.coordinatorAgentID) || normalizeOptional(session.coordinatorAgentID),
    reason: normalizeOptional(snapshot?.reason) || (active ? 'user-suspend' : null),
    suspendedAgentIDs: new Set(active ? normalizeSuspendedAgentIDs(snapshot?.suspendedAgentIDs) : []),
    pendingWarningAgentIDs: new Set(normalizeSuspendedAgentIDs(snapshot?.pendingWarningAgentIDs)),
    warnedAgentIDs: new Set(normalizeSuspendedAgentIDs(snapshot?.warnedAgentIDs)),
    restarted: false,
    legacy: false,
  };
}

export function replaySuspensionFrames(state, frames = []) {
  for (let frame of Array.isArray(frames) ? frames : [])
    applySuspensionFrame(state, frame);
  return state;
}

export function applySuspensionFrame(state, frame) {
  if (!state || !frame)
    return state;

  // Old halt frames had no durable resume counterpart. Recover the old
  // in-memory behaviour for migration: a later human turn resumed the
  // coordinator, and a later agent-authored frame proves that agent ran.
  if (state.legacy) {
    if (frame.type === 'UserMessage' && frame.authorType === 'user')
      resumeSuspendedAgent(state, state.coordinatorAgentID);
    else if (frame.authorType === 'agent' && frame.authorID)
      resumeSuspendedAgent(state, frame.authorID);
  }

  if (frame.authorType !== 'system')
    return state;

  if (frame.authorID === SESSION_SUSPEND_AUTHOR_ID || frame.authorID === LEGACY_SESSION_SUSPEND_AUTHOR_ID) {
    let agentIDs = normalizeSuspendedAgentIDs(
      frame.content?.suspendedAgentIDs
      || frame.content?.haltedAgentIDs,
    );
    if (agentIDs.length === 0)
      return state;

    for (let agentID of agentIDs)
      state.suspendedAgentIDs.add(agentID);
    state.active = true;
    state.suspendedAt = normalizeTimestamp(frame.timestamp) || normalizeTimestamp(frame.createdAt) || state.suspendedAt;
    state.suspendedByUserID = normalizeOptional(frame.content?.suspendedByUserID)
      || normalizeOptional(frame.content?.haltedByUserID)
      || state.suspendedByUserID;
    state.coordinatorAgentID = normalizeOptional(frame.content?.coordinatorAgentID) || state.coordinatorAgentID;
    state.reason = normalizeOptional(frame.content?.reason) || 'user-suspend';
    state.legacy = frame.authorID === LEGACY_SESSION_SUSPEND_AUTHOR_ID
      || frame.content?.kind !== 'session-suspend';
    return state;
  }

  if (frame.authorID === SESSION_RESUME_AUTHOR_ID) {
    let agentID = normalizeOptional(frame.content?.resumedAgentID);
    if (!agentID)
      return state;

    resumeSuspendedAgent(state, agentID);
  }

  return state;
}

export function buildSessionSuspensionSnapshot(entry) {
  let suspend = entry?.sessionSuspension?.active ? entry.sessionSuspension : null;
  let pendingWarningAgentIDs = [ ...(entry?.suspensionPendingWarnings?.keys?.() || []) ];
  let warnedAgentIDs = [ ...(entry?.suspensionWarnedAgentIDs || []) ];
  if (!suspend && pendingWarningAgentIDs.length === 0 && warnedAgentIDs.length === 0)
    return null;

  return {
    version: 1,
    active: Boolean(suspend),
    suspendedAt: suspend?.suspendedAt || null,
    suspendedByUserID: suspend?.suspendedByUserID || null,
    coordinatorAgentID: suspend?.coordinatorAgentID || entry?.session?.coordinatorAgentID || null,
    reason: suspend?.reason || null,
    suspendedAgentIDs: suspend ? [ ...suspend.suspendedAgentIDs ] : [],
    pendingWarningAgentIDs,
    warnedAgentIDs,
  };
}

export function buildHydratedSuspension(entry, snapshot, frames = []) {
  let state = replaySuspensionFrames(createSuspensionReplayState(snapshot, entry?.session), frames);
  let suspensionPendingWarnings = new Map();

  for (let agentID of state.pendingWarningAgentIDs) {
    if (state.suspendedAgentIDs.has(agentID))
      continue;
    suspensionPendingWarnings.set(agentID, buildPendingSuspensionWarning(entry, state, agentID));
  }

  let sessionSuspension = state.suspendedAgentIDs.size > 0
    ? {
      active: true,
      suspendedAt: state.suspendedAt || Date.now(),
      suspendedByUserID: state.suspendedByUserID,
      coordinatorAgentID: state.coordinatorAgentID || entry?.session?.coordinatorAgentID || null,
      reason: state.reason || 'user-suspend',
      suspendedAgentIDs: state.suspendedAgentIDs,
      warnedAgentIDs: state.warnedAgentIDs,
      restarted: true,
    }
    : null;
  if (sessionSuspension)
    state.restarted = true;

  return {
    sessionSuspension,
    suspensionPendingWarnings,
    suspensionWarnedAgentIDs: state.warnedAgentIDs,
  };
}

export function buildPendingSuspensionWarning(entry, state, agentID) {
  let isCoordinator = agentID === state.coordinatorAgentID
    || agentID === entry?.session?.coordinatorAgentID;
  let suspendedAgentIDs = [ ...state.suspendedAgentIDs ]
    .filter((suspendedAgentID) => !isCoordinator || suspendedAgentID !== agentID);
  return {
    message: buildSuspensionWarning({ isCoordinator, suspendedAgentIDs, restarted: state.restarted === true }),
    suspendedAgentIDs,
  };
}

export function createResumeFrame({ id, sessionID, agentID, agentName = '', reason = 'resume', timestamp = Date.now() }) {
  let name = normalizeOptional(agentName) || agentID;
  return {
    id,
    type: 'AgentMessage',
    sessionID,
    interactionID: null,
    parentID: null,
    authorType: 'system',
    authorID: SESSION_RESUME_AUTHOR_ID,
    authorDisplayName: 'System',
    timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
    hidden: true,
    deleted: false,
    content: {
      text: `User Resumed ${name}`,
      status: 'success',
      kind: 'agent-resume',
      resumedAgentID: agentID,
      resumedAgentName: name,
      reason,
    },
  };
}

function resumeSuspendedAgent(state, agentID) {
  if (!agentID)
    return false;
  let wasSuspended = state.suspendedAgentIDs.delete(agentID);
  if (wasSuspended && !state.warnedAgentIDs.has(agentID))
    state.pendingWarningAgentIDs.add(agentID);
  if (state.suspendedAgentIDs.size === 0)
    state.active = false;
  return wasSuspended;
}

function normalizeOptional(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function normalizeTimestamp(value) {
  let number = Number(value);
  return Number.isFinite(number) ? number : null;
}
