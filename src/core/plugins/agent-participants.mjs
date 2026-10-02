'use strict';

import {
  normalizeOptionalPromptString,
  normalizeStringArray,
} from './agent-normalizers.mjs';

export function normalizeMentions(mentions) {
  if (!mentions || typeof mentions !== 'object' || Array.isArray(mentions))
    return {};

  return mentions;
}

export function normalizeParticipantAgents(participantAgents, options = {}) {
  let participantAgentIDs = normalizeStringArray(options.participantAgentIDs);
  let coordinatorAgentID = normalizeOptionalPromptString(options.coordinatorAgentID);
  let selfAgentID = normalizeOptionalPromptString(options.selfAgentID);
  let byID = new Map();

  for (let participant of Array.isArray(participantAgents) ? participantAgents : []) {
    let id = normalizeOptionalPromptString(participant?.id || participant);
    if (!id)
      continue;

    byID.set(id, normalizeParticipantAgent(participant, {
      coordinatorAgentID,
      selfAgentID,
    }));
  }

  let orderedIDs = participantAgentIDs.slice();
  for (let id of byID.keys()) {
    if (!orderedIDs.includes(id))
      orderedIDs.push(id);
  }

  return orderedIDs.map((id) => byID.get(id) || normalizeParticipantAgent({ id }, {
    coordinatorAgentID,
    selfAgentID,
  }));
}

export function normalizeParticipantAgent(agent, options = {}) {
  let id = normalizeOptionalPromptString(agent?.id || agent);
  let name = normalizeOptionalPromptString(agent?.name || agent?.displayName || id);
  let pluginID = normalizeOptionalPromptString(agent?.pluginID || agent?.pluginId);
  let item = {
    id,
    type: 'agent',
    name: name || id,
    isSelf: id === options.selfAgentID,
    isCoordinator: id === options.coordinatorAgentID,
  };

  if (pluginID)
    item.pluginID = pluginID;

  return item;
}

// Collect every party in the session for the coordinator/party-count rule
// (decision D3: parties include users). Agents come from the normalized roster;
// users come from `session.participantUserIDs` plus the triggering user frame.
export function collectPartyActors(context = {}) {
  let agents = normalizeParticipantAgents(context.participantAgents || context.sessionAgents, {
    participantAgentIDs: context.participantAgentIDs || context.session?.participantAgentIDs,
    coordinatorAgentID: context.coordinatorAgentID || context.session?.coordinatorAgentID,
    selfAgentID: context.agent?.id,
  });

  let users = normalizeStringArray(context.session?.participantUserIDs);
  let authorID = normalizeOptionalPromptString(context.frame?.authorID);
  if (context.frame?.authorType === 'user' && authorID && !users.includes(authorID))
    users.push(authorID);

  return { agents, users };
}

// Total party count counting both agents and users.
export function countParties(context = {}) {
  let { agents, users } = collectPartyActors(context);
  return agents.length + users.length;
}

// Whether more than one party is present. At 2+ parties a character-aware agent
// should defer to silence unless it genuinely adds value.
export function hasMultiparty(context = {}) {
  return countParties(context) >= 2;
}

// Whether the coordinator role applies: 3+ parties (decision D3).
export function hasCoordinatorParties(context = {}) {
  return countParties(context) >= 3;
}

export function isCoordinatedMentionTarget(context = {}) {
  if (context.frame?.coordinated !== true)
    return false;

  let agentID = normalizeOptionalPromptString(context.agent?.id);
  if (!agentID)
    return false;

  if (normalizeStringArray(context.frame?.recipients).includes(agentID))
    return true;

  let mentions = normalizeMentions(context.mentions || context.frame?.mentions);
  return Object.prototype.hasOwnProperty.call(mentions, agentID);
}

export function resolveParticipantName(context = {}, actorID = '') {
  let id = normalizeOptionalPromptString(actorID);
  if (!id)
    return '';

  for (let agent of normalizeParticipantAgents(context.participantAgents || context.sessionAgents, {
    participantAgentIDs: context.participantAgentIDs || context.session?.participantAgentIDs,
    coordinatorAgentID: context.coordinatorAgentID || context.session?.coordinatorAgentID,
    selfAgentID: context.agent?.id,
  })) {
    if (agent.id === id)
      return agent.name || '';
  }

  return '';
}
