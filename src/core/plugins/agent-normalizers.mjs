'use strict';

export function normalizeForwardTargets(target) {
  let values = Array.isArray(target) ? target : [ target ];
  let targets = [];

  for (let value of values) {
    if (typeof value === 'string' && value.trim() !== '') {
      targets.push(value.trim());
      continue;
    }

    if (value?.id && typeof value.id === 'string')
      targets.push(value.id.trim());
  }

  return targets.filter((targetValue, index) => targetValue && targets.indexOf(targetValue) === index);
}

export function normalizeForwardRequest(target, message) {
  if (target && typeof target === 'object' && !Array.isArray(target)) {
    return {
      targets: normalizeForwardTargets(target.targets || target.target || target.agentIDs || target.actorIDs),
      message: target.message || target.reason || message,
    };
  }

  return {
    targets: normalizeForwardTargets(target),
    message,
  };
}

// Normalize the coordinator `route` tool input:
//   { recipients?, remove?, note? }
// into the internal forward shape { targets, remove, message }.
export function normalizeRouteRequest(input = {}) {
  if (typeof input === 'string')
    return { targets: normalizeForwardTargets(input), remove: [], message: undefined };

  if (!input || typeof input !== 'object' || Array.isArray(input))
    return { targets: [], remove: [], message: undefined };

  return {
    targets: normalizeForwardTargets(input.recipients || input.targets || input.target || input.actors),
    remove: normalizeForwardTargets(input.remove || input.removed || input.exclude),
    message: input.note || input.message || input.reason,
  };
}

export function normalizeToolResponseContent(content) {
  if (typeof content === 'string')
    return { text: content };

  if (content && typeof content === 'object' && !Array.isArray(content)) {
    let {
      delayMs: _delayMs,
      delayMS: _delayMS,
      delayMilliseconds: _delayMilliseconds,
      delaySeconds: _delaySeconds,
      seconds: _seconds,
      continuationPrompt: _continuationPrompt,
      prompt: _prompt,
      reason: _reason,
      ...rest
    } = content;
    return { ...rest };
  }

  return { text: String(content ?? '') };
}

export function normalizeContinuationRequest(input) {
  let payload = (input && typeof input === 'object' && !Array.isArray(input)) ? input : {};
  return {
    delayMs: normalizeContinuationDelay(payload.delayMs ?? payload.delayMS ?? payload.delayMilliseconds ?? secondsToMs(payload.delaySeconds ?? payload.seconds)),
    continuationPrompt: normalizeReason(payload.continuationPrompt || payload.prompt || payload.reason || 'Please continue what you were doing.'),
  };
}

export function secondsToMs(value) {
  if (value == null || value === '')
    return null;

  let number = Number(value);
  if (!Number.isFinite(number))
    return value;

  return number * 1000;
}

export function normalizeContinuationDelay(value) {
  if (value == null || value === '')
    return 1000;

  let number = Number(value);
  if (!Number.isFinite(number) || number < 0)
    throw new TypeError('delayMs must be a non-negative finite number');

  return Math.trunc(number);
}

export function normalizeReason(reason) {
  if (reason && typeof reason === 'object' && !Array.isArray(reason))
    return reason.reason || reason.message || '';

  return String(reason ?? '');
}

export function readToolString(input, fieldNames) {
  if (typeof input === 'string')
    return input;

  if (!input || typeof input !== 'object' || Array.isArray(input))
    return '';

  for (let fieldName of fieldNames) {
    if (typeof input[fieldName] === 'string')
      return input[fieldName];
  }

  return '';
}

export function normalizeRequiredToolString(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '')
    throw new TypeError(`${fieldName} must be a non-empty string`);

  return value.trim();
}

export function normalizeOptionalPromptString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function sessionGeneration(session) {
  if (!session || typeof session !== 'object')
    return 0;

  let number = Number(session.generation);
  if (Number.isFinite(number) && number >= 0)
    return Math.trunc(number);

  return session.parentSessionID ? 1 : 0;
}

export function normalizeStringArray(values) {
  if (!Array.isArray(values))
    return [];

  let normalized = [];
  for (let value of values) {
    if (typeof value !== 'string' || value.trim() === '')
      continue;

    let item = value.trim();
    if (!normalized.includes(item))
      normalized.push(item);
  }

  return normalized;
}

export function normalizeCoordinatorAgentID(coordinatorAgentID, participantAgentIDs) {
  if (typeof coordinatorAgentID === 'string') {
    let trimmed = coordinatorAgentID.trim();
    if (participantAgentIDs.includes(trimmed))
      return trimmed;
  }

  return participantAgentIDs[0] || null;
}

export function normalizeConfigFields(fields) {
  if (!Array.isArray(fields))
    return [];

  return fields
    .filter((field) => field?.name && typeof field.name === 'string')
    .map((field) => ({
      name: field.name,
      label: field.label || field.name,
      type: field.type || 'text',
      required: field.required === true,
      secret: field.secret === true,
      defaultValue: field.defaultValue,
      options: Array.isArray(field.options) ? field.options.slice() : undefined,
      help: field.help || '',
    }));
}

export function cloneJSON(value) {
  return JSON.parse(JSON.stringify(value));
}

export function resolveService(services, name) {
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

export async function *iterateAgentResult(value) {
  let resolved = await value;
  if (resolved == null)
    return;

  if (typeof resolved[Symbol.asyncIterator] === 'function') {
    for await (let item of resolved)
      yield item;
    return;
  }

  if (typeof resolved[Symbol.iterator] === 'function' && typeof resolved !== 'string') {
    for (let item of resolved)
      yield item;
    return;
  }

  yield resolved;
}
