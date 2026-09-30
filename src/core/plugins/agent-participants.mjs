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

export function isCoordinatedMentionTarget(context = {}) {
  if (context.frame?.coordinated !== true)
    return false;

  let agentID = normalizeOptionalPromptString(context.agent?.id);
  if (!agentID)
    return false;

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
