'use strict';

// Which agent performs a compaction (P4 extraction; selection is P1/R3).
//
// This wraps `selectCompactor` with the environment override and the fallbacks
// that must survive degenerate sessions (no participants, unloadable agents).
// Keeping it out of the service keeps the orchestration file focused.

import { resolveSessionWindows } from './effective-windows.mjs';
import { selectCompactor } from './select-compactor.mjs';

// Resolve the compactor for a request. `input.agent` is the routing agent used
// only as a historical fallback. Returns the loaded agent or null.
export async function resolveCompactionAgent({
  compactionAgentID,
  agentManager,
  pluginRegistry,
  catalog,
  input = {},
} = {}) {
  // Env/config override remains the highest priority (unchanged behavior).
  if (compactionAgentID)
    return await loadCompactionAgent(agentManager, compactionAgentID, input);

  let session = input.session || {};
  let windows = await resolveSessionWindows({
    session,
    agentManager,
    pluginRegistry,
    catalog,
  });
  let participantAgentsWithMeta = windows.participants;
  // Rung 2 of selection reads the manager's SYNCHRONOUS compaction-bot snapshot.
  // Refresh it from the store first so designation changes made through any path
  // are visible at selection time.
  if (typeof agentManager?.refreshCompactionBots === 'function')
    await agentManager.refreshCompactionBots();

  let selection = selectCompactor({
    session,
    participantAgentsWithMeta,
    agentManager,
    pluginRegistry,
    catalog,
  });

  if (!selection.agentID) {
    // No participant resolved (for example a session with no participants).
    // Preserve the historical current-agent fallback for that degenerate case.
    let currentAgentID = normalizeOptionalString(input.agent?.id);
    return currentAgentID ? await loadCompactionAgent(agentManager, currentAgentID, input) : null;
  }

  let selected = await loadCompactionAgent(agentManager, selection.agentID, input);
  if (selected)
    return selected;

  // The selected agent could not be loaded (for example a stub manager that only
  // knows the routing agent). Preserve the historical fallback to the current
  // agent when it is a participant.
  let currentAgentID = normalizeOptionalString(input.agent?.id);
  if (currentAgentID && participantAgentsWithMeta.some((participant) => participant.id === currentAgentID))
    return input.agent;

  return null;
}

export async function loadCompactionAgent(agentManager, agentID, input = {}) {
  if (!agentManager?.getAgent)
    return normalizeOptionalString(input.agent?.id) === agentID ? input.agent : null;

  let agent = await agentManager.getAgent(agentID, { includeSecrets: true });
  return agent?.id && agent.enabled !== false ? agent : null;
}

function normalizeOptionalString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}
