'use strict';

// Agent-row role actions are driven by tag definitions. Core registers
// leadership/compaction/OCR actions, but a plugin can add another icon button by
// registering an agent tag with an `agentAction` descriptor.

export function agentTagActions(definitions = []) {
  return (Array.isArray(definitions) ? definitions : []).filter((definition) => (
    definition?.agentAction?.icon
    && typeof definition.name === 'string'
    && (!Array.isArray(definition.targetTypes) || definition.targetTypes.includes('agent'))
  ));
}

export function agentTagValue(agent, name) {
  let tag = (Array.isArray(agent?.tags) ? agent.tags : [])
    .find((item) => item?.name === name && (!item.target_type || item.target_type === 'agent'));
  let value = Number(tag?.value);
  return Number.isFinite(value) ? value : 0;
}

export function agentTagActionActive(agent, definition, ranks = {}) {
  if (agentTagValue(agent, definition.name) > 0)
    return true;

  if (definition.agentAction?.legacyToggle === 'crown')
    return Boolean(agent?.crownedClock || ranks.masterRankByID?.get(agent?.id));
  if (definition.agentAction?.legacyToggle === 'compaction')
    return Boolean(agent?.compactionCrownedClock || ranks.compactionBotRankByID?.get(agent?.id));

  return false;
}

export function agentTagActionRank(agent, definition, ranks = {}) {
  if (definition.agentAction?.legacyToggle === 'crown')
    return ranks.masterRankByID?.get(agent?.id) || 0;
  if (definition.agentAction?.legacyToggle === 'compaction')
    return ranks.compactionBotRankByID?.get(agent?.id) || 0;
  return ranks.tagRankByID?.[definition.name]?.get(agent?.id) || 0;
}

// Rank tag-only priority actions (OCR is the first one) by their numeric value.
// This is what makes repeated clicks on different rows define a visible order.
export function agentTagRankByID(agents = [], name) {
  let ranked = (Array.isArray(agents) ? agents : [])
    .map((agent) => ({ id: agent?.id, value: agentTagValue(agent, name) }))
    .filter((entry) => entry.id && entry.value > 0)
    .sort((a, b) => b.value - a.value || String(a.id).localeCompare(String(b.id)));
  return new Map(ranked.map((entry, index) => [ entry.id, index + 1 ]));
}

// Compute the tag updates for a newest-click-wins priority list. Clicking an
// inactive bot makes it #1 and shifts the rest down; clicking an active bot
// clears it and shifts the rest up. `maxValue` (normally 10) bounds the list.
export function priorityTagUpdates(agents = [], definition, clickedAgentID, options = {}) {
  let maxValue = Number(definition?.agentAction?.onValue);
  if (!Number.isFinite(maxValue) || maxValue <= 0)
    maxValue = 10;
  if (options.maxValue != null)
    maxValue = Math.max(1, Math.trunc(Number(options.maxValue) || maxValue));

  let ordered = (Array.isArray(agents) ? agents : [])
    .map((agent) => ({ id: agent?.id, value: agentTagValue(agent, definition.name) }))
    .filter((entry) => entry.id && entry.value > 0)
    .sort((a, b) => b.value - a.value || String(a.id).localeCompare(String(b.id)))
    .map((entry) => entry.id);

  let wasActive = ordered.includes(clickedAgentID);
  let next = ordered.filter((id) => id !== clickedAgentID);
  if (!wasActive)
    next.unshift(clickedAgentID);
  next = next.slice(0, maxValue);

  let affected = new Set([ ...ordered, clickedAgentID ]);
  let updates = [];
  for (let id of affected) {
    let index = next.indexOf(id);
    let value = index >= 0 ? maxValue - index : 0;
    let current = agents.find((agent) => agent?.id === id);
    if (current && agentTagValue(current, definition.name) === value)
      continue;
    updates.push({
      target_type: 'agent',
      target_id: id,
      name: definition.name,
      value,
    });
  }

  return {
    active: !wasActive,
    rank: next.indexOf(clickedAgentID) + 1,
    updates,
  };
}

export function agentTagActionClassName(agent, definition, ranks = {}) {
  let action = definition.agentAction || {};
  let active = agentTagActionActive(agent, definition, ranks);
  let rank = agentTagActionRank(agent, definition, ranks);
  return [
    action.className || 'kikx-agent-list__tag-action',
    active ? (action.activeClass || 'is-active') : '',
    active && rank > 0 && action.rankClass ? `${action.rankClass}${rank}` : '',
  ].filter(Boolean).join(' ');
}

export function agentTagActionTitle(definition, active, rank = 0) {
  let action = definition.agentAction || {};
  if (active) {
    let label = action.activeLabel || action.label || definition.label || definition.name;
    return rank > 0 ? `${label} #${rank} (click to clear)` : `${label} (click to clear)`;
  }
  return action.label || `Set ${definition.label || definition.name}`;
}

export function agentTagActionAriaLabel(definition, active, rank = 0) {
  let action = definition.agentAction || {};
  if (active) {
    let label = action.activeLabel || action.label || definition.label || definition.name;
    return rank > 0 ? `${label} number ${rank}` : label;
  }
  return action.label || `Set ${definition.label || definition.name}`;
}
