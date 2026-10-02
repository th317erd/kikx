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

import { resolveCoordinatorAgentID } from '../agents/agent-route/normalize.mjs';
import { resolveEffectiveContextWindow } from './effective-windows.mjs';

// Reasons returned in the result, one per rung plus the empty case.
export const COMPACTOR_REASON = {
  SESSION: 'session',
  DESIGNATED: 'designated',
  COORDINATOR: 'coordinator',
  LARGEST: 'largest',
};

export function selectCompactor({ session, participantAgentsWithMeta, agentManager, pluginRegistry, catalog } = {}) {
  let participants = normalizeParticipants(participantAgentsWithMeta, { pluginRegistry, catalog });
  if (participants.length === 0)
    return { agentID: null, reason: null };

  let byID = new Map(participants.map((participant) => [ participant.id, participant ]));

  // 1. Session-assigned compaction bot.
  let sessionCompactionAgentID = normalizeOptionalString(session?.compactionAgentID);
  if (sessionCompactionAgentID && byID.has(sessionCompactionAgentID))
    return { agentID: sessionCompactionAgentID, reason: COMPACTOR_REASON.SESSION };

  // 2. User-designated compaction bots (top-3, newest first). The list is the
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

  // 3. Session coordinator — only when one is explicitly assigned to a
  // participant. `resolveCoordinatorAgentID` falls back to the first participant
  // when unset; that fallback is not a designation, so rung 4 must still be
  // reachable for sessions without a coordinator.
  let explicitCoordinatorID = normalizeOptionalString(session?.coordinatorAgentID);
  if (explicitCoordinatorID) {
    let coordinatorAgentID = resolveCoordinatorAgentID(session, participants.map((participant) => participant.id));
    if (coordinatorAgentID === explicitCoordinatorID && byID.has(coordinatorAgentID))
      return { agentID: coordinatorAgentID, reason: COMPACTOR_REASON.COORDINATOR };
  }

  // 4. Largest effective window. Ties break by participant order (stable).
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
