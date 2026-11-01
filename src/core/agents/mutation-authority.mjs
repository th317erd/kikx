'use strict';

import {
  hasCoordinatorAuthority,
  normalizeID,
  participantAgentIDsOf,
  resolveCoordinatorChain,
} from './coordinator-scope.mjs';
import { loadSessionChain } from './end-turn-notification.mjs';

export function checkAgentMutationAllowed(options = {}) {
  let actorAgentID = normalizeID(options.actorAgentID);
  let targetAgentID = normalizeID(options.targetAgentID);
  let currentSessionID = normalizeID(options.currentSessionID);
  let getSession = options.getSession;

  if (!actorAgentID || !targetAgentID)
    return { allowed: false, reason: 'missing-agent' };

  if (actorAgentID === targetAgentID)
    return { allowed: true, reason: 'self' };

  if (!currentSessionID)
    return { allowed: false, reason: 'missing-session' };

  let authority = hasCoordinatorAuthority({
    agentID: actorAgentID,
    targetSessionID: currentSessionID,
    getSession,
  });

  if (!authority.allowed)
    return { allowed: false, reason: 'not-coordinator' };

  let session = getSession instanceof Map
    ? getSession.get(currentSessionID)
    : typeof getSession === 'function'
      ? getSession(currentSessionID)
      : null;
  let participants = participantAgentIDsOf(session);

  if (!participants.includes(targetAgentID))
    return { allowed: false, reason: 'not-in-session' };

  let chain = resolveCoordinatorChain({ sessionID: currentSessionID, getSession });
  let actorIndex = chain.chain.findIndex((entry) => entry.agentID === actorAgentID);

  if (actorIndex !== -1) {
    let upstreamIDs = chain.chain.slice(actorIndex + 1).map((entry) => entry.agentID);
    if (upstreamIDs.includes(targetAgentID))
      return { allowed: false, reason: 'upstream-coordinator' };
  }

  return { allowed: true, reason: actorIndex === -1 ? 'coordinator-promoted' : 'coordinator-descendant' };
}

export function assertAgentMutationAllowed(options = {}) {
  let result = checkAgentMutationAllowed(options);
  if (!result.allowed) {
    let actor = normalizeID(options.actorAgentID) || '(unknown)';
    let target = normalizeID(options.targetAgentID) || '(unknown)';
    throw new Error(`Mutation refused: ${actor} may not modify ${target} (${result.reason})`);
  }

  return result;
}

export async function checkAgentMutationAllowedForSession(options = {}) {
  let { actorAgentID, targetAgentID, session, runtime } = options;

  if (!runtime || !session)
    return { allowed: false, reason: 'missing-session' };

  let sessions = await loadSessionChain(runtime, session);
  return checkAgentMutationAllowed({
    actorAgentID,
    targetAgentID,
    currentSessionID: normalizeID(session?.id),
    getSession: sessions,
  });
}
