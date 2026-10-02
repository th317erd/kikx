'use strict';

// The master list is a rolling top-N: only the most recently crowned agents
// count as masters. Older crowns beyond the cap are not masters.
export const MAX_MASTER_AGENTS = 3;

// The compaction-bot list is a parallel rolling top-N, keyed on the independent
// `compactionCrownedClock`/`compactionCrownedAt` fields. Same cap and ordering,
// but never affected by crowning (and vice versa).
export const MAX_COMPACTION_BOTS = 3;

export function rankMasters(agents = []) {
  return (Array.isArray(agents) ? agents : [])
    .filter((agent) => Boolean(agent.crownedClock))
    .sort((a, b) => (
      String(b.crownedClock || '').localeCompare(String(a.crownedClock || ''))
      || (Number(b.crownedAt || 0) - Number(a.crownedAt || 0))
      || String(a.id).localeCompare(String(b.id))
    ))
    .slice(0, MAX_MASTER_AGENTS);
}

// Parallel to rankMasters, over the independent compaction-bot fields.
export function rankCompactionBots(agents = []) {
  return (Array.isArray(agents) ? agents : [])
    .filter((agent) => Boolean(agent.compactionCrownedClock))
    .sort((a, b) => (
      String(b.compactionCrownedClock || '').localeCompare(String(a.compactionCrownedClock || ''))
      || (Number(b.compactionCrownedAt || 0) - Number(a.compactionCrownedAt || 0))
      || String(a.id).localeCompare(String(b.id))
    ))
    .slice(0, MAX_COMPACTION_BOTS);
}

// Agent-list filtering for the Agents modal.
//
// Filters are derived from the providers actually present among agents, plus
// two special filters:
//   all     - every agent
//   masters - crowned (master/coordinator) agents
//   hidden  - disabled agents (hidden from normal operation)
//
// Provider filters are keyed `provider:<pluginID>` and labelled from the
// provider descriptor's displayName (falling back to the pluginID), so a
// Codex plugin yields a "Codex" pill, Google yields "Gemini", Ollama "Ollama",
// and so on — without hardcoding plugin names.

export function agentFilterPills(agents = [], providers = []) {
  let list = Array.isArray(agents) ? agents : [];
  let providerByID = new Map(
    (Array.isArray(providers) ? providers : [])
      .filter((provider) => provider?.pluginID)
      .map((provider) => [ provider.pluginID, provider ]),
  );

  let pills = [
    { id: 'all', label: 'All' },
    { id: 'masters', label: 'Masters' },
  ];

  // One pill per provider that actually has agents, in first-seen order.
  let seen = new Set();
  for (let agent of list) {
    if (!agent?.pluginID || seen.has(agent.pluginID))
      continue;

    seen.add(agent.pluginID);
    let provider = providerByID.get(agent.pluginID);
    pills.push({
      id: `provider:${agent.pluginID}`,
      label: provider?.displayName || agent.pluginID,
    });
  }

  pills.push({ id: 'hidden', label: 'Hidden' });
  return pills;
}

export function filterAgents(agents = [], filter = 'all') {
  let list = Array.isArray(agents) ? agents : [];

  if (filter === 'masters')
    return rankMasters(list);

  if (filter === 'hidden')
    return list.filter((agent) => agent.enabled === false);

  if (typeof filter === 'string' && filter.startsWith('provider:')) {
    let pluginID = filter.slice('provider:'.length);
    return list.filter((agent) => agent.pluginID === pluginID);
  }

  return list;
}

export function agentFilterLabel(agents = [], providers = [], filter = 'all') {
  let pill = agentFilterPills(agents, providers).find((candidate) => candidate.id === filter);
  return pill?.label || 'All';
}
