'use strict';

const DEFAULT_SESSION_FRAME_LIMIT = 1000;
export const MAX_SESSION_FRAME_LIMIT = 5000;

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

export function normalizeTitle(title, defaultTitle = null) {
  if (title == null)
    return defaultTitle || 'Session';

  if (typeof title !== 'string' || title.trim() === '')
    throw new TypeError('title must be a non-empty string');

  return title.trim();
}

export function normalizeText(text) {
  if (typeof text !== 'string' || text.trim() === '')
    throw new TypeError('text must be a non-empty string');

  return text.trim();
}

export function normalizeCount(value) {
  if (value == null)
    return 0;

  return (typeof value === 'number' && Number.isFinite(value) && value >= 0)
    ? Math.trunc(value)
    : 0;
}

export function normalizeSessionGeneration(value, parentSessionID = '') {
  if (value == null)
    return parentSessionID ? 1 : 0;

  let number = Number(value);
  if (!Number.isFinite(number) || number < 0)
    return parentSessionID ? 1 : 0;

  return Math.trunc(number);
}

export function normalizeOptionalString(value) {
  if (typeof value !== 'string')
    return '';

  return value.trim();
}

export function normalizeFrameLimit(value) {
  if (value == null)
    return DEFAULT_SESSION_FRAME_LIMIT;

  let number = Number(value);
  if (!Number.isInteger(number) || number < 1)
    throw new TypeError('frame limit must be a positive integer');

  return Math.min(number, MAX_SESSION_FRAME_LIMIT);
}

export function normalizeFrameWindowLimit(value) {
  return Math.min(value, MAX_SESSION_FRAME_LIMIT);
}

export function normalizeFrameOffset(value) {
  if (value == null)
    return 0;

  let number = Number(value);
  if (!Number.isInteger(number) || number < 0)
    throw new TypeError('frame offset must be a non-negative integer');

  return number;
}

export function normalizeRecoveryLimit(value, defaultValue) {
  let number = Number(value);
  if (!Number.isInteger(number) || number < 1)
    return defaultValue;

  return Math.min(number, 5000);
}

export function normalizeRequiredString(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '')
    throw new TypeError(`${fieldName} must be a non-empty string`);

  return value.trim();
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

// Explicit-bot designation fields (compaction P2, ruling R8). Unlike
// `normalizeCoordinatorAgentID`, an absent/blank value clears the designation
// (returns null) and there is no implicit first-participant fallback: these are
// only ever written when a user runs an explicit `set-*` command. A non-empty
// value must name a current participant, otherwise a clear error is thrown.
export function normalizeDesignationAgentID(agentID, participantAgentIDs, fieldName) {
  if (agentID == null)
    return null;

  if (typeof agentID !== 'string' || agentID.trim() === '')
    return null;

  let trimmed = agentID.trim();
  if (!participantAgentIDs.includes(trimmed)) {
    let error = new Error(`${fieldName} must be a session participant: ${trimmed}`);
    error.status = 400;
    throw error;
  }

  return trimmed;
}

export function maxFrameTimestamp(frames) {
  let max = null;
  for (let frame of Array.isArray(frames) ? frames : []) {
    let value = normalizePositiveTimestamp(frame?.updatedAt || frame?.createdAt || frame?.timestamp);
    if (value && (!max || value > max))
      max = value;
  }

  return max;
}

function normalizePositiveTimestamp(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
    return null;

  return Math.trunc(value);
}

export function latestFrameClock(frames) {
  let clock = null;
  for (let frame of Array.isArray(frames) ? frames : []) {
    if (typeof frame?.updatedClock === 'string' && frame.updatedClock)
      clock = frame.updatedClock;
  }

  return clock;
}
