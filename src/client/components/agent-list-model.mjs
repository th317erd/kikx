'use strict';

// The master list is a rolling top-N: only the most recently crowned agents
// count as masters. Older crowns beyond the cap are not masters.
export const MAX_MASTER_AGENTS = 3;

// The compaction-bot list is a parallel rolling top-N, keyed on the independent
// `compactionCrownedClock`/`compactionCrownedAt` fields. Same cap and ordering,
// but never affected by crowning (and vice versa).
export const MAX_COMPACTION_BOTS = 3;

export function rankMasters(agents = []) {
  let list = Array.isArray(agents) ? agents : [];
  let tagged = rankByTag(list, 'leadership_score', MAX_MASTER_AGENTS);
  if (tagged.length > 0)
    return tagged;

  return list
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
  let list = Array.of(...(Array.isArray(agents) ? agents : []));
  let tagged = rankByTag(list, 'compaction_score', MAX_COMPACTION_BOTS);
  if (tagged.length > 0)
    return tagged;

  return list
    .filter((agent) => Boolean(agent.compactionCrownedClock))
    .sort((a, b) => (
      String(b.compactionCrownedClock || '').localeCompare(String(a.compactionCrownedClock || ''))
      || (Number(b.compactionCrownedAt || 0) - Number(a.compactionCrownedAt || 0))
      || String(a.id).localeCompare(String(b.id))
    ))
    .slice(0, MAX_COMPACTION_BOTS);
}

function rankByTag(agents, name, limit) {
  return agents
    .map((agent) => ({ agent, value: tagNumber(agent, name) }))
    .filter((entry) => entry.value > 0)
    .sort((a, b) => b.value - a.value || String(a.agent.id).localeCompare(String(b.agent.id)))
    .slice(0, limit)
    .map((entry) => entry.agent);
}

function tagNumber(agent, name) {
  let tag = (Array.isArray(agent?.tags) ? agent.tags : [])
    .find((item) => item?.name === name && (!item.target_type || item.target_type === 'agent'));
  let value = Number(tag?.value);
  return Number.isFinite(value) ? value : 0;
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
