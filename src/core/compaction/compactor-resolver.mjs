'use strict';

// Which agent performs a compaction (P4 extraction; selection is P1/R3).
//
// This wraps `selectCompactor` with the environment override and the fallbacks
// that must survive degenerate sessions (no participants, unloadable agents).
// Keeping it out of the service keeps the orchestration file focused.

import { resolveService } from '../agents/agent-route/normalize.mjs';
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
    // Selection needs the session TREE, not just this session's record: rung 4
    // asks who owns the run, and the answer may live on an ancestor. Without a
    // lookup, `selectCompactor` degrades to the local coordinator field and an
    // inherited coordinator is invisible again.
    getSession: resolveSessionLookup(input, session),
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

// The session lookup rung 4 needs. Same two-step shape `session-control-tool`
// uses, so there is one idiom for "get me a session by id" rather than a third.
// A caller may pass a lookup directly; otherwise reach the frame runtime through
// the service registry. Returning null (not a throwing stub) is deliberate: the
// caller then falls back to the local field instead of failing the turn.
function resolveSessionLookup(input, session) {
  if (typeof input?.getSession === 'function')
    return input.getSession;

  let frameRuntime = input?.frameRuntime || resolveService(input?.services, 'frameRuntime');
  if (!frameRuntime)
    return null;

  return (id) => {
    // The compacting session is already in hand; prefer it so a runtime that
    // does not cache the current session cannot make rung 4 fall back.
    if (session?.id && id === session.id)
      return session;

    return frameRuntime.getSession?.(id)
      || frameRuntime.requireSessionEntry?.(id)?.session
      || null;
  };
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
