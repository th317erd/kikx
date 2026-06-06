'use strict';

export function parseMentionReferences(text) {
  if (typeof text !== 'string' || text.length === 0)
    return [];

  let mentions = [];
  let seen = new Set();

  for (let index = 0; index < text.length; index++) {
    if (text[index] !== '@' || !isMentionBoundary(text[index - 1]))
      continue;

    let parsed = parseMentionAt(text, index);
    if (!parsed)
      continue;

    index = parsed.endIndex;
    if (seen.has(parsed.reference))
      continue;

    seen.add(parsed.reference);
    mentions.push({
      raw: parsed.raw,
      reference: parsed.reference,
      quoted: parsed.quoted,
    });
  }

  return mentions;
}

export async function resolveMentionActors(references, services = {}) {
  let mentions = {};

  for (let mention of Array.isArray(references) ? references : []) {
    let reference = typeof mention === 'string' ? mention : mention?.reference;
    if (typeof reference !== 'string' || reference.trim() === '')
      continue;

    let actor = await resolveActor(reference.trim(), services);
    let normalized = normalizeActorMention(actor, reference.trim());
    if (normalized)
      mentions[normalized.id] = normalized;
  }

  return mentions;
}

export function mergeMentionMaps(...maps) {
  let merged = {};

  for (let map of maps) {
    if (!isPlainObject(map))
      continue;

    for (let [actorID, mention] of Object.entries(map)) {
      let normalized = normalizeActorMention({ ...mention, id: mention?.id || actorID }, mention?.reference || actorID);
      if (normalized)
        merged[normalized.id] = normalized;
    }
  }

  return merged;
}

export function mentionsEqual(left, right) {
  return JSON.stringify(sortMentionMap(left)) === JSON.stringify(sortMentionMap(right));
}

export function normalizeActorMention(actor, reference = '') {
  if (!isPlainObject(actor))
    return null;

  let id = firstString(actor.id, actor.actorID, actor.userID, actor.agentID);
  if (!id)
    return null;

  let type = firstString(actor.type, actor.actorType, actor.kind) || (actor.pluginID ? 'agent' : 'user');
  let username = firstString(actor.username, actor.userName);
  let fullName = firstString(actor.fullName, actor.full_name, actor.displayName, actor.name, username, id);
  let name = firstString(actor.name, actor.displayName, username, fullName, id);

  return {
    id,
    type,
    name,
    username: username || null,
    fullName,
    reference,
  };
}

async function resolveActor(reference, services = {}) {
  let actorResolver = resolveService(services, 'actorResolver');
  let fromActorResolver = await callResolver(actorResolver, [
    'resolveActor',
    'resolveMention',
    'findActor',
  ], reference);
  if (fromActorResolver)
    return fromActorResolver;

  let agentManager = resolveService(services, 'agentManager');
  let fromAgents = await callResolver(agentManager, [
    'resolveAgent',
    'findAgentByIDOrName',
    'getAgent',
  ], reference);
  if (fromAgents)
    return {
      ...fromAgents,
      type: fromAgents.type || 'agent',
    };

  let userManager = resolveService(services, 'userManager');
  let fromUsers = await callResolver(userManager, [
    'resolveUser',
    'findUserByIDOrName',
    'getUser',
  ], reference);
  if (fromUsers)
    return {
      ...fromUsers,
      type: fromUsers.type || 'user',
    };

  return null;
}

async function callResolver(service, methodNames, reference) {
  if (!service)
    return null;

  for (let methodName of methodNames) {
    if (typeof service[methodName] !== 'function')
      continue;

    try {
      let actor = await service[methodName](reference);
      if (actor)
        return actor;
    } catch (error) {
      if (error?.status === 404)
        continue;

      throw error;
    }
  }

  return null;
}

function parseMentionAt(text, atIndex) {
  let start = atIndex + 1;
  let first = text[start];
  if (!first)
    return null;

  if (first === '"' || first === "'")
    return parseQuotedMention(text, atIndex, first);

  let end = start;
  while (end < text.length && isUnquotedMentionChar(text[end]))
    end++;

  if (end === start)
    return null;

  let rawEnd = trimUnquotedMentionEnd(text, start, end);
  if (rawEnd === start)
    return null;

  let raw = text.slice(atIndex, rawEnd);
  return {
    raw,
    reference: text.slice(start, rawEnd),
    quoted: false,
    endIndex: rawEnd - 1,
  };
}

function parseQuotedMention(text, atIndex, quote) {
  let start = atIndex + 2;
  let value = '';

  for (let index = start; index < text.length; index++) {
    let char = text[index];
    if (char === '\\' && index + 1 < text.length) {
      value += text[index + 1];
      index++;
      continue;
    }

    if (char === quote) {
      if (value.trim() === '')
        return null;

      return {
        raw: text.slice(atIndex, index + 1),
        reference: value.trim(),
        quoted: true,
        endIndex: index,
      };
    }

    value += char;
  }

  return null;
}

function isMentionBoundary(char) {
  return !char || !/[A-Za-z0-9_.-]/.test(char);
}

function isUnquotedMentionChar(char) {
  return /[A-Za-z0-9_.:-]/.test(char);
}

function trimUnquotedMentionEnd(text, start, end) {
  let nextEnd = end;
  while (nextEnd > start && /[.,!?;:]/.test(text[nextEnd - 1]))
    nextEnd--;

  return nextEnd;
}

function sortMentionMap(map) {
  let sorted = {};
  for (let key of Object.keys(isPlainObject(map) ? map : {}).sort())
    sorted[key] = map[key];
  return sorted;
}

function resolveService(services, name) {
  if (services?.[name])
    return services[name];

  if (services?.context?.has?.(name) && typeof services.context.require === 'function')
    return services.context.require(name);

  if (typeof services?.context?.require === 'function') {
    try {
      return services.context.require(name);
    } catch (_error) {
      return null;
    }
  }

  return null;
}

function firstString(...values) {
  for (let value of values) {
    if (typeof value === 'string' && value.trim() !== '')
      return value.trim();
  }

  return '';
}

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}
