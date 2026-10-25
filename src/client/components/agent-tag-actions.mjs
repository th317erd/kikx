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

// Rank tag-only priority actions (OCR is the first one) by their rank tag. OCR
// stores the click timestamp in a companion tag, so repeated clicks are
// newest-first without shifting every other row's value.
export function agentTagRankByID(agents = [], definition) {
  let rankTag = definition?.agentAction?.rankTag || definition?.name;
  let ranked = (Array.isArray(agents) ? agents : [])
    .map((agent) => {
      let value = agentTagValue(agent, rankTag);
      if (value <= 0 && rankTag !== definition?.name)
        value = agentTagValue(agent, definition?.name);
      return { id: agent?.id, value };
    })
    .filter((entry) => entry.id && entry.value > 0)
    .sort((a, b) => b.value - a.value || String(a.id).localeCompare(String(b.id)));
  return new Map(ranked.map((entry, index) => [ entry.id, index + 1 ]));
}

// Monotonic click timestamp. Date.now() can tie during rapid clicks; adding one
// keeps the newest click strictly above the previous rank timestamp.
export function nextPriorityTimestamp(agents = [], definition, now = Date.now()) {
  let rankTag = definition?.agentAction?.rankTag;
  if (!rankTag)
    return Number(now);
  let max = 0;
  for (let agent of Array.isArray(agents) ? agents : [])
    max = Math.max(max, agentTagValue(agent, rankTag));
  return Math.max(Number(now) || 0, max + 1);
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
