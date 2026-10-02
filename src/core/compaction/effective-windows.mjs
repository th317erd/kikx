'use strict';

// Effective context windows (P0, ruling R1).
//
// Compaction triggers off the SMALLEST bot in a session — the bot that must keep
// working after a compaction. That means every decision needs a *finite* window
// per participant, never the process-wide 128k default. Resolution precedence:
//
//   1. `agent.config.contextWindowTokens` — an explicit per-agent override,
//   2. the provider instance's `resolveContextWindow({ config, baseUrl })` —
//      the model manifest / discovered window / provider default,
//   3. the aggregated model catalog (`agentManager.listModels()`), matched by
//      pluginID + model id, for providers with no resolver of their own,
//   4. a finite default (32768), so a decision is never made against `null`.
//
// This module is intentionally free of service wiring so the trigger math and
// the compactor selection can both share it.

const DEFAULT_EFFECTIVE_CONTEXT_WINDOW_TOKENS = 32768;

// A finite context window for one agent. `providerClass` may be passed directly
// or attached as `agent.providerClass` by the caller (see `resolveSessionWindows`).
export function resolveEffectiveContextWindow({ agent, providerClass, catalog } = {}) {
  let configured = normalizePositiveInteger(agent?.config?.contextWindowTokens);
  if (configured != null)
    return configured;

  let providerWindow = resolveProviderWindow({
    agent,
    providerClass: providerClass || agent?.providerClass,
  });
  if (providerWindow != null)
    return providerWindow;

  let catalogWindow = resolveCatalogWindow({ agent, catalog });
  if (catalogWindow != null)
    return catalogWindow;

  return DEFAULT_EFFECTIVE_CONTEXT_WINDOW_TOKENS;
}

// The smallest effective window across participants, or `null` when there are
// none (the caller then falls back to the global default path). A participant
// may carry a precomputed `window`, which avoids re-instantiating a provider.
export function smallestParticipantWindow({ agents, catalog } = {}) {
  let list = Array.isArray(agents) ? agents : [];
  let smallest = null;

  for (let entry of list) {
    let window = precomputedWindow(entry);
    if (window == null) {
      let agent = entry?.agent || entry;
      window = resolveEffectiveContextWindow({ agent, providerClass: agent?.providerClass, catalog });
    }

    if (smallest == null || window < smallest)
      smallest = window;
  }

  return smallest;
}

// Load every session participant through the agent manager, resolve its provider
// class from the registry, and compute its effective window. Returns the
// per-participant meta (`{ agent, providerClass, window }`) plus the smallest
// window, so callers can reuse one pass for both the trigger and the compactor
// choice. Participants that no longer resolve are skipped.
export async function resolveSessionWindows({ session, agentManager, pluginRegistry, catalog } = {}) {
  let participantAgentIDs = normalizeStringArray(session?.participantAgentIDs);
  let participants = [];

  for (let agentID of participantAgentIDs) {
    let agent = await loadAgent(agentManager, agentID);
    if (!agent?.id)
      continue;

    let providerClass = pluginRegistry?.getAgentProvider?.(agent.pluginID) || null;
    let window = resolveEffectiveContextWindow({ agent, providerClass, catalog });
    participants.push({
      agent,
      providerClass,
      window,
    });
  }

  return {
    participants,
    smallestWindow: smallestParticipantWindow({ agents: participants, catalog }),
  };
}

function resolveProviderWindow({ agent, providerClass }) {
  if (typeof providerClass !== 'function')
    return null;

  try {
    let provider = new providerClass({
      agent,
      config: agent?.config || {},
    });

    if (typeof provider.resolveContextWindow !== 'function')
      return null;

    return normalizePositiveInteger(provider.resolveContextWindow({
      config: agent?.config || {},
      baseUrl: agent?.config?.baseUrl,
    }));
  } catch (_error) {
    return null;
  }
}

function resolveCatalogWindow({ agent, catalog }) {
  if (!Array.isArray(catalog))
    return null;

  let pluginID = normalizeOptionalString(agent?.pluginID);
  let modelID = normalizeOptionalString(agent?.config?.model);
  if (!pluginID && !modelID)
    return null;

  for (let entry of catalog) {
    if (pluginID && normalizeOptionalString(entry?.pluginID) !== pluginID)
      continue;

    if (modelID && normalizeOptionalString(entry?.id) !== modelID)
      continue;

    let window = normalizePositiveInteger(entry?.contextWindow);
    if (window != null)
      return window;
  }

  return null;
}

function precomputedWindow(value) {
  let number = Number(value?.window);
  if (!Number.isFinite(number) || number < 1)
    return null;

  return Math.trunc(number);
}

async function loadAgent(agentManager, agentID) {
  if (!agentManager?.getAgent || !agentID)
    return null;

  try {
    return await agentManager.getAgent(agentID, { includeSecrets: false });
  } catch (_error) {
    return null;
  }
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

function normalizeStringArray(values) {
  if (!Array.isArray(values))
    return [];

  let output = [];
  for (let value of values) {
    if (typeof value !== 'string' || value.trim() === '')
      continue;

    let item = value.trim();
    if (!output.includes(item))
      output.push(item);
  }

  return output;
}

export { DEFAULT_EFFECTIVE_CONTEXT_WINDOW_TOKENS };
