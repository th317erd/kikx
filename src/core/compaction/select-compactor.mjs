'use strict';

// Compactor selection (P1, ruling R3).
//
// A pure function that chooses which agent performs a session's compaction, in
// the owner's four-step order:
//
//   1. the session's assigned compaction bot (`session.compactionAgentID`),
//   2. a user-designated compaction bot (the parallel top-3 crown list — see the
//      P3 TODO below),
//   3. the session coordinator (`session.coordinatorAgentID`),
//   4. the participant with the LARGEST effective context window.
//
// The compactor is chosen for *capability*, independent of the smallest-window
// trigger rule (R1): the trigger follows the smallest bot, while selection can
// move to a larger model.

import { resolveSessionCoordinator } from '../agents/coordinator-scope.mjs';
import { resolveCoordinatorAgentID } from '../agents/agent-route/normalize.mjs';
import { resolveEffectiveContextWindow } from './effective-windows.mjs';
import { tagNumber } from '../tags/tag-definitions.mjs';

// Reasons returned in the result, one per rung plus the empty case.
export const COMPACTOR_REASON = {
  SESSION: 'session',
  DESIGNATED: 'designated',
  COORDINATOR: 'coordinator',
  LARGEST: 'largest',
};

export function selectCompactor({
  session,
  participantAgentsWithMeta,
  agentManager,
  pluginRegistry,
  catalog,
  getSession = null,
} = {}) {
  let participants = normalizeParticipants(participantAgentsWithMeta, { pluginRegistry, catalog });
  if (participants.length === 0)
    return { agentID: null, reason: null };

  let byID = new Map(participants.map((participant) => [ participant.id, participant ]));

  // 1. Session-assigned compaction bot.
  let sessionCompactionAgentID = normalizeOptionalString(session?.compactionAgentID);
  if (sessionCompactionAgentID && byID.has(sessionCompactionAgentID))
    return { agentID: sessionCompactionAgentID, reason: COMPACTOR_REASON.SESSION };

  // 2. Typed `compaction_score` tags on participants. Higher scores win; this
  // is the generic tag layer that replaces the old role-specific list when set.
  let tagged = participants
    .map((participant) => ({ ...participant, score: tagNumber(agentTag(participant.agent, 'compaction_score')) }))
    .filter((participant) => participant.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  if (tagged.length > 0)
    return { agentID: tagged[0].id, reason: COMPACTOR_REASON.DESIGNATED };

  // 3. User-designated compaction bots (top-3, newest first). The list is the
  // parallel-but-independent crown clone: a rolling top-3 keyed on
  // `compactionCrownedClock`. `listCompactionBots()` is synchronous (the manager
  // keeps a refreshed in-memory snapshot), so selection stays a pure function.
  // The first entry that is a session participant wins.
  let designated = callListCompactionBots(agentManager);
  if (Array.isArray(designated)) {
    for (let agent of designated) {
      let agentID = normalizeOptionalString(agent?.id);
      if (agentID && byID.has(agentID))
        return { agentID, reason: COMPACTOR_REASON.DESIGNATED };
    }
  }

  // 4. The session coordinator, resolved through the session tree.
  //
  // This rung used to read `session.coordinatorAgentID` directly, which made a
  // coordinator INHERITED from an ancestor invisible: the child session stores no
  // field of its own, so selection silently fell to the largest window and
  // compaction ignored who actually owns the run. `resolveSessionCoordinator`
  // walks the ancestors and reports *why* it answered, which is what lets this
  // rung stay a designation test rather than a guess:
  //
  //   'explicit'  the session's own coordinator, still a participant.   -> counts
  //   'inherited' an ancestor's coordinator, a participant here.        -> counts
  //   'promoted'  no session in the chain named one, so the highest     -> does NOT
  //               participant-holding session's first bot was crowned.     count
  //
  // Promotion must not count: rung 5 exists for "no coordinator was assigned".
  // Treating a forced fallback as a designation would collapse rung 5 entirely
  // and hand compaction to a bot nobody chose.
  let resolution = resolveCoordinator(session, participants, getSession);
  if (resolution && (resolution.source === 'explicit' || resolution.source === 'inherited')) {
    let coordinatorAgentID = resolution.coordinatorAgentID;
    if (byID.has(coordinatorAgentID))
      return { agentID: coordinatorAgentID, reason: COMPACTOR_REASON.COORDINATOR };
  }

  // 5. Largest effective window. Ties break by participant order (stable).
  let largest = null;
  for (let participant of participants) {
    if (largest == null || participant.window > largest.window)
      largest = participant;
  }

  return largest
    ? { agentID: largest.id, reason: COMPACTOR_REASON.LARGEST }
    : { agentID: null, reason: null };
}

// Rung 2 reads the manager's synchronous compaction-bot snapshot. Guard the call
// so a stub manager or a misbehaving implementation cannot break selection; an
// array result is authoritative, anything else means "no list".
function callListCompactionBots(agentManager) {
  try {
    let result = agentManager?.listCompactionBots?.();
    return Array.isArray(result) ? result : null;
  } catch (_error) {
    return null;
  }
}

// Resolve the session coordinator for rung 4. With no session lookup in scope the
// tree is unknowable, so degrade to the local field (the pre-existing behaviour)
// rather than pretending an inheritance question was answered. The local answer
// is reported as 'explicit' only when the field is actually set and is a
// participant -- exactly the old guard.
function resolveCoordinator(session, participants, getSession) {
  let participantIDs = participants.map((participant) => participant.id);

  if (typeof getSession !== 'function') {
    let localID = normalizeOptionalString(session?.coordinatorAgentID);
    if (!localID)
      return null;

    let local = resolveCoordinatorAgentID(session, participantIDs);
    return local === localID ? { coordinatorAgentID: local, source: 'explicit' } : null;
  }

  try {
    let resolved = resolveSessionCoordinator({ sessionID: session?.id, getSession });
    return resolved?.coordinatorAgentID ? resolved : null;
  } catch (_error) {
    // Resolution must never make compaction unavailable. A session tree that
    // cannot be walked degrades to rung 5, not to a thrown turn.
    return null;
  }
}

function agentTag(agent, name) {
  let tags = Array.isArray(agent?.tags) ? agent.tags : [];
  let tag = tags.find((item) => item?.name === name && (!item.target_type || item.target_type === 'agent'));
  return tag?.value;
}

function normalizeParticipants(entries, { pluginRegistry, catalog } = {}) {
  let list = Array.isArray(entries) ? entries : [];
  let participants = [];

  for (let entry of list) {
    let agent = entry?.agent || entry;
    let id = normalizeOptionalString(agent?.id) || normalizeOptionalString(entry?.id);
    if (!id)
      continue;

    let window = normalizePositiveInteger(entry?.window);
    if (window == null) {
      let providerClass = entry?.providerClass || pluginRegistry?.getAgentProvider?.(agent?.pluginID) || null;
      window = resolveEffectiveContextWindow({ agent: agent || { id }, providerClass, catalog });
    }

    participants.push({ id, agent, window });
  }

  return participants;
}

function normalizePositiveInteger(value) {
  if (value == null)
    return null;

  let number = Number(value);
  if (!Number.isFinite(number) || number < 1)
    return null;

  return Math.trunc(number);
}

function normalizeOptionalString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}
