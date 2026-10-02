'use strict';

import { httpError } from '../http-helpers.mjs';
import { MAX_CHARACTER_COMPRESSED_LENGTH } from '../../core/agents/character-limits.mjs';

export function validateAgentBody(body, options = {}) {
  if (options.creating && (!body.name || typeof body.name !== 'string' || body.name.trim() === ''))
    throw httpError(400, 'name must be a non-empty string');

  if (body.name != null && (typeof body.name !== 'string' || body.name.trim() === ''))
    throw httpError(400, 'name must be a non-empty string');

  if (options.creating && (!body.pluginID || typeof body.pluginID !== 'string' || body.pluginID.trim() === ''))
    throw httpError(400, 'pluginID must be a non-empty string');

  if (body.pluginID != null && (typeof body.pluginID !== 'string' || body.pluginID.trim() === ''))
    throw httpError(400, 'pluginID must be a non-empty string');

  if (body.character != null && typeof body.character !== 'string')
    throw httpError(400, 'character must be a string');

  if (body.characterCompressed != null && typeof body.characterCompressed !== 'string')
    throw httpError(400, 'characterCompressed must be a string');

  if (typeof body.characterCompressed === 'string' && body.characterCompressed.trim().length > MAX_CHARACTER_COMPRESSED_LENGTH)
    throw httpError(400, `characterCompressed must be ${MAX_CHARACTER_COMPRESSED_LENGTH} characters or fewer`);

  if (body.config != null && (typeof body.config !== 'object' || Array.isArray(body.config)))
    throw httpError(400, 'config must be an object');

  if (body.secrets != null && (typeof body.secrets !== 'object' || Array.isArray(body.secrets)))
    throw httpError(400, 'secrets must be an object');

  if (body.clearSecrets != null && !Array.isArray(body.clearSecrets))
    throw httpError(400, 'clearSecrets must be an array');

  if (body.enabled != null && typeof body.enabled !== 'boolean')
    throw httpError(400, 'enabled must be a boolean');
}

export function validateTeamBody(body, options = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw httpError(400, 'team body must be an object');

  if (options.creating && (!body.name || typeof body.name !== 'string' || body.name.trim() === ''))
    throw httpError(400, 'name must be a non-empty string');

  if (body.name != null && (typeof body.name !== 'string' || body.name.trim() === ''))
    throw httpError(400, 'name must be a non-empty string');

  if (body.members != null) {
    if (!Array.isArray(body.members))
      throw httpError(400, 'members must be an array');

    for (let member of body.members)
      validateTeamMemberBody(member);
  }
}

export function validateTeamMemberBody(body) {
  if (typeof body === 'string') {
    if (body.trim() === '')
      throw httpError(400, 'team member reference must be a non-empty string');

    return;
  }

  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw httpError(400, 'team member must be an object or agent reference string');

  if (body.type != null && body.type !== 'agent' && body.type !== 'user')
    throw httpError(400, 'member.type must be agent or user');

  let type = body.type || (body.userID || body.email ? 'user' : 'agent');
  let hasReference = Boolean(body.reference || body.agentReference || body.actorID || body.agentID || body.userID || body.id || body.name);
  if (type === 'user')
    hasReference = Boolean(body.actorID || body.userID || body.id || body.reference);

  if (!hasReference)
    throw httpError(400, 'team member requires an actor reference');
}
