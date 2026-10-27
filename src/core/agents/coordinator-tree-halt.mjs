'use strict';

// Cross-session halt: the single implementation behind both the `session-control`
// tool and the `/halt` slash command.
//
// Requirement 4 is about REACH, not aliases. `/cancel`, `/stop`, `/halt` and
// `/suspend` already resolve to the same command (cancel-command.mjs:8) and the
// cancellation primitives below were already session-addressed
// (frame-runtime-sessions.mjs:244 and :266, process-manager.mjs:287). What was
// missing is that no entry point could NAME a session, and no entry point could
// be driven by a bot. This module supplies the naming, the authorisation and the
// fan-out; it does not re-implement cancellation.
//
// Authority is `hasCoordinatorAuthority` (./coordinator-scope.mjs): the actor must
// coordinate the target session or one of its ancestors. Authority flows DOWN, so
// an actor may halt its own session and any descendant subtree, and may never
// halt an ancestor or a sibling branch.

import { descendantSessionIDs, resolveSubtreeSessionIDs } from './session-subtree.mjs';
import {
  COORDINATOR_MAX_ANCESTOR_DEPTH,
  hasCoordinatorAuthority,
  parentSessionIDOf,
  resolveSessionCoordinator,
} from './coordinator-scope.mjs';

/**
 * Work out what `actorAgentID` may halt, without performing any cancellation.
 * Pure apart from calling into `frameRuntime` for the session lookup.
 *
 * Returns `{ allowed, reason, message, targetSessionID, sessionIDs, refused }`,
 * where `refused` lists `{ sessionID, reason }` for targets that were named or
 * reached but not permitted.
 */
export async function resolveHaltScope({
  actorAgentID,
  targetSessionID,
  currentSessionID,
  includeSubtree = true,
  frameRuntime,
  listSessions = null,
  sessions = null,
} = {}) {
  let target = normalizeID(targetSessionID) || normalizeID(currentSessionID);

  if (!target)
    return {
      allowed: false,
      reason: 'no-session',
      message: 'No session was named and the caller has no current session.',
      targetSessionID: null,
      sessionIDs: [],
      refused: [],
    };

  // Load the session listing BEFORE authorising anything.
  //
  // `FrameRuntime.getSession` is cache-only (frame-runtime.mjs:227-229) and
  // `evictOverflowSessionRuntimes` really does evict idle sessions
  // (frame-runtime.mjs:346-368). A descendant further away than
  // `sessionRuntimeLimit` therefore reads as `null` through getSession, and its
  // `parentSessionID` -- the only link that says who has authority over it --
  // becomes invisible. That turns a legitimate cross-session halt into
  // "unknown-session", or worse, drops the descendant from the subtree walk while
  // the caller is told the halt succeeded. The listing still knows the parent, so
  // it is what the lookup must fall back to.
  let loadedSessions = Array.isArray(sessions) ? sessions : null;

  if (!loadedSessions && typeof listSessions === 'function')
    loadedSessions = await listSessions();

  if (!loadedSessions && typeof frameRuntime?.listSessions === 'function') {
    try {
      loadedSessions = await frameRuntime.listSessions({ limit: 500 }) || null;
    } catch (_error) {
      loadedSessions = null;
    }
  }

  // An empty listing can mean "the store did not enumerate", not "there are no
  // children". The runtime's loaded-session cache is still evidence of a tree.
  if (Array.isArray(loadedSessions) && loadedSessions.length === 0 && frameRuntime?.sessions instanceof Map) {
    let cached = [];
    for (let entry of frameRuntime.sessions.values()) {
      if (entry?.session?.id)
        cached.push(entry.session);
    }
    if (cached.length > 0)
      loadedSessions = cached;
  }

  let listedByID = new Map();
  for (let listed of Array.isArray(loadedSessions) ? loadedSessions : []) {
    let listedID = normalizeID(listed?.id);
    if (listedID)
      listedByID.set(listedID, listed);
  }

  let getSession = (id) => frameRuntime?.getSession?.(id)
    || listedByID.get(normalizeID(id))
    || null;

  // Hydrate a cold target and its ancestors.
  //
  // A listing cannot rescue this case: after eviction the session exists ONLY in
  // the durable store, and a store that does not enumerate (or has not flushed)
  // returns nothing. The runtime's own `ensureSessionEntry` is the one primitive
  // that reads a session back from the store, so the authority walk is fed from
  // it. Walking up rather than down is the point: authority lives on the
  // ancestors, so they are exactly what must be present to answer the question.
  // Bounded by the same cap as the resolver, and cycle-safe, so a corrupt
  // `parentSessionID` cannot make a halt read the entire store.
  if (!getSession(target) && typeof frameRuntime?.ensureSessionEntry === 'function') {
    let cursor = target;
    let hydrated = new Set();
    let maxDepth = Number.isFinite(Number(COORDINATOR_MAX_ANCESTOR_DEPTH))
      ? COORDINATOR_MAX_ANCESTOR_DEPTH
      : 64;

    while (cursor && !hydrated.has(cursor) && hydrated.size < maxDepth) {
      hydrated.add(cursor);

      let loaded = null;
      try {
        let entry = await frameRuntime.ensureSessionEntry(cursor);
        loaded = entry?.session || null;
      } catch (_error) {
        loaded = null;
      }

      if (!loaded)
        break;

      listedByID.set(cursor, loaded);
      cursor = parentSessionIDOf(loaded);
    }
  }

  let targetSession = getSession(target);
  if (!targetSession)
    return {
      allowed: false,
      reason: 'unknown-session',
      message: `Session ${target} does not exist or is not loaded.`,
      targetSessionID: target,
      sessionIDs: [],
      refused: [],
    };

  let authority = hasCoordinatorAuthority({
    agentID: actorAgentID,
    targetSessionID: target,
    getSession,
  });

  if (!authority.allowed) {
    return {
      allowed: false,
      reason: authority.reason,
      message: buildRefusalMessage({
        actorAgentID,
        targetSessionID: target,
        authority,
        frameRuntime,
        getSession,
      }),
      targetSessionID: target,
      sessionIDs: [],
      refused: [ { sessionID: target, reason: authority.reason } ],
    };
  }

  if (!includeSubtree) {
    return {
      allowed: true,
      reason: authority.reason,
      message: '',
      targetSessionID: target,
      sessionIDs: [ target ],
      refused: [],
      ownerSessionID: authority.ownerSessionID,
    };
  }

  // Fan out over the whole subtree using the listing loaded above. With no
  // listing at all the safe answer is the target alone rather than a guess at
  // children we cannot enumerate -- and that is reported as `incomplete` so the
  // caller is never told a subtree halt happened when it did not.
  let subtree = Array.isArray(loadedSessions)
    ? resolveSubtreeSessionIDs(target, { sessions: loadedSessions })
    : { sessionIDs: [ target ], truncated: false, incomplete: true };

  let sessionIDs = [];
  let refused = [];
  for (let sessionID of subtree.sessionIDs) {
    let sessionAuthority = hasCoordinatorAuthority({
      agentID: actorAgentID,
      targetSessionID: sessionID,
      getSession,
    });
    if (sessionAuthority.allowed)
      sessionIDs.push(sessionID);
    else
      refused.push({ sessionID, reason: sessionAuthority.reason });
  }

  return {
    allowed: true,
    reason: authority.reason,
    message: '',
    targetSessionID: target,
    sessionIDs,
    refused,
    ownerSessionID: authority.ownerSessionID,
    truncated: subtree.truncated === true || subtree.incomplete === true,
    incomplete: subtree.incomplete === true,
    descendantCount: sessionIDs.length,
  };
}

/**
 * Perform the halt across every session in scope.
 *
 * `cancelled` is measured, not asserted: it collects the agent ids the runtime
 * actually cancelled per session, and `emptySessions` names the sessions in scope
 * where nothing was running. That distinction is what stops this from reporting a
 * successful stop when no run was ever reached -- the failure mode the owner
 * called out ("stop" reports success and a run keeps going).
 */
export async function haltSessionTree({
  actorAgentID,
  targetSessionID,
  currentSessionID,
  includeSubtree = true,
  target = null,
  reason = 'coordinator-halt',
  services = {},
} = {}) {
  let frameRuntime = services.frameRuntime;
  let agentManager = services.agentManager;
  let processManager = services.processManager;

  let scope = await resolveHaltScope({
    actorAgentID,
    targetSessionID,
    currentSessionID,
    includeSubtree,
    frameRuntime,
    listSessions: services.listSessions || null,
    sessions: services.sessions || null,
  });

  if (!scope.allowed)
    return { ...scope, cancelled: [], emptySessions: [], suspendedCommandIDs: [] };

  let targetAgentID = null;
  let targetLabel = null;
  let targetError = null;
  if (typeof target === 'string' && target.trim() !== '') {
    targetLabel = target.trim();
    try {
      let resolved = await agentManager?.resolveAgent?.(targetLabel);
      targetAgentID = resolved?.id || null;
      if (!targetAgentID)
        targetError = `No agent matches ${targetLabel}.`;
    } catch (error) {
      targetError = error?.message || `Could not resolve ${targetLabel}.`;
    }
  }

  let cancelled = [];
  let emptySessions = [];
  let suspendedCommandIDs = [];

  for (let sessionID of scope.sessionIDs) {
    // 0. Make sure the session is actually loaded.
    //
    // Both primitives below begin with `this.sessions.get(sessionID)` and no-op
    // when the entry is absent (frame-runtime-sessions.mjs:245 cancelAgentRuns,
    // :267 suspendSession). Halting an evicted descendant without loading it first
    // therefore returns an empty cancellation list and freezes nothing -- a stop
    // that reports success over a session that will run again the moment it is
    // touched. Loading is what makes the freeze real; the suspension is then
    // persisted by step 4 and replayed on the next hydrate.
    if (typeof frameRuntime?.ensureSessionEntry === 'function') {
      try {
        await frameRuntime.ensureSessionEntry(sessionID);
      } catch (_error) {
        scope.refused = [ ...(scope.refused || []), { sessionID, reason: 'unloadable' } ];
        continue;
      }
    }

    // 1. Pause in-flight provider calls for this session (runtime layer).
    //
    // `agentIDs` must name who is being frozen. Passing `undefined` makes
    // `suspendSession` mark the session active while suspending nobody, so
    // `isAgentSuspended` stays false and a new tool call in that session still
    // runs -- a halt that reports success over a live agent.
    let sessionParticipants = participantAgentIDsOf(frameRuntime?.getSession?.(sessionID));
    let effectiveAgentIDs = targetAgentID ? [ targetAgentID ] : sessionParticipants;

    // No participants recorded and no named target: there is nobody to freeze. Skip
    // rather than call suspendSession with an empty list, which would mark the
    // session suspended while gating no agent.
    if (effectiveAgentIDs.length > 0) {
      frameRuntime?.suspendSession?.(sessionID, {
        agentIDs: effectiveAgentIDs,
        coordinatorAgentID: frameRuntime?.getSession?.(sessionID)?.coordinatorAgentID || null,
        userID: null,
        reason,
      });
    }

    // 2. Cancel the agent runs. This is what stops a provider call that would
    //    otherwise yield a late result after a SIGSTOP.
    let cancelledAgentIDs = frameRuntime?.cancelAgentRuns?.(sessionID, targetAgentID) || [];
    if (cancelledAgentIDs.length === 0)
      emptySessions.push(sessionID);

    cancelled.push({ sessionID, agentIDs: cancelledAgentIDs });

    // 3. Pause the OS-level commands those agents spawned.
    let commandIDs = await processManager?.suspendSession?.(sessionID, {
      agentID: targetAgentID || null,
    }) || [];
    suspendedCommandIDs.push({ sessionID, commandIDs });

    await frameRuntime?.persistSessionSuspension?.(sessionID);
  }

  return {
    ...scope,
    cancelled,
    emptySessions,
    suspendedCommandIDs,
    targetAgentID,
    target: targetLabel,
    targetError,
  };
}

/** Human-facing summary naming every session reached and every one refused. */
export function describeHaltResult(result) {
  if (!result)
    return 'Nothing was halted.';

  if (!result.allowed)
    return result.message || `Halt refused (${result.reason}).`;

  let parts = [];
  let reached = result.cancelled.filter((entry) => entry.agentIDs.length > 0);
  let total = reached.reduce((sum, entry) => sum + entry.agentIDs.length, 0);

  if (total === 0) {
    parts.push(result.sessionIDs.length > 1
      ? `No active runs in any of ${result.sessionIDs.length} sessions (${result.sessionIDs.join(', ')}).`
      : 'No active agent runs.');
  } else {
    parts.push(`Suspended ${total} active agent${total === 1 ? '' : 's'} in `
      + `${reached.length} session${reached.length === 1 ? '' : 's'}: `
      + reached.map((entry) => `${entry.sessionID} (${entry.agentIDs.join(', ')})`).join('; ') + '.');
  }

  if (result.emptySessions?.length > 0 && total > 0)
    parts.push(`No active runs in: ${result.emptySessions.join(', ')}.`);

  if (result.refused?.length > 0) {
    parts.push('Refused: ' + result.refused
      .map((entry) => `${entry.sessionID} (${entry.reason})`)
      .join('; ') + '.');
  }

  if (result.incomplete) {
    parts.push('Only the named session was reached: the caller could not enumerate child sessions, '
      + 'so no descendants were walked. Do not treat this as a subtree halt.');
  } else if (result.truncated) {
    parts.push('The subtree was too large to walk completely; some sessions were not visited.');
  }

  if (result.targetError)
    parts.push(result.targetError);

  return parts.join(' ');
}

function buildRefusalMessage({ actorAgentID, targetSessionID, authority, frameRuntime, getSession }) {
  let actorCoordinatorOf = authority.chain.length > 0
    ? resolveSessionCoordinator({ sessionID: targetSessionID, getSession }).coordinatorAgentID
    : null;

  let reasonText = authority.reason === 'not-coordinator'
    ? `${actorAgentID} is not the coordinator of ${targetSessionID} or of any of its ancestors.`
    : `Authority could not be established for ${targetSessionID} (${authority.reason}).`;

  // Name who *would* have the authority, so the refusal is actionable.
  let hint = actorCoordinatorOf
    ? ` The coordinator responsible for ${targetSessionID} is ${actorCoordinatorOf}.`
    : '';

  void frameRuntime;
  return `Refused: ${reasonText}${hint} Coordinator authority flows down the session tree, so a coordinator may halt its own session and its descendants, never a parent or a sibling branch.`;
}

function normalizeID(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** The participants of a session record, in stored order. */
function participantAgentIDsOf(session) {
  let seen = [];
  for (let value of Array.isArray(session?.participantAgentIDs) ? session.participantAgentIDs : []) {
    if (typeof value === 'string' && value.trim() !== '' && !seen.includes(value.trim()))
      seen.push(value.trim());
  }
  return seen;
}

export { descendantSessionIDs };
