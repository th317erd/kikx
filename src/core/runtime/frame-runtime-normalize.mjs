'use strict';

import { resolveLocalCoordinatorAgentID } from '../agents/coordinator-scope.mjs';

const DEFAULT_SESSION_FRAME_LIMIT = 1000;
export const MAX_SESSION_FRAME_LIMIT = 5000;

// Live session runtimes hold a hydrated FrameEngine (up to MAX_SESSION_FRAME_LIMIT
// frames each). Sessions are durable, so the in-memory runtime is a pure cache:
// cap it and evict the least-recently-used entry. The cap is generous enough
// that ordinary working sets never churn; heavy multi-session bots are bounded.
export const DEFAULT_SESSION_RUNTIME_LIMIT = 200;

export function normalizeSessionRuntimeLimit(value) {
  if (value == null)
    return DEFAULT_SESSION_RUNTIME_LIMIT;

  let number = Number(value);
  if (!Number.isInteger(number) || number < 1)
    throw new TypeError('session runtime limit must be a positive integer');

  return number;
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

// Local, non-inheriting rule. This used to be a second copy of the exact body in
// src/core/agents/agent-route/normalize.mjs:46; both now delegate to the one
// named definition in src/core/agents/coordinator-scope.mjs, so they cannot drift.
//
// This function cannot see the session tree, so it cannot inherit from a parent
// or promote across it. A caller that holds a tree wants
// `resolveSessionCoordinator` there instead.
export function normalizeCoordinatorAgentID(coordinatorAgentID, participantAgentIDs) {
  return resolveLocalCoordinatorAgentID(
    { coordinatorAgentID, participantAgentIDs },
    participantAgentIDs,
  );
}

/**
 * The value to STORE on a session when it is created or when a bot joins.
 *
 * Deliberately not `normalizeCoordinatorAgentID`: an absent or non-participant
 * coordinator becomes `null` rather than the first participant. Crowning the first
 * invited bot at creation is what made every session appear to have a coordinator
 * of its own, which in turn made inheritance unreachable and made it impossible
 * for a session to hold bots that are not coordinators (owner requirement 1).
 *
 * A session with participants and no coordinator is now legal and intended; the
 * tree resolver promotes one only when nothing above the session has one, and it
 * records that promotion on the session it chose.
 */
export function normalizeStoredCoordinatorAgentID(coordinatorAgentID, participantAgentIDs) {
  if (typeof coordinatorAgentID !== 'string')
    return null;

  let trimmed = coordinatorAgentID.trim();
  if (!trimmed)
    return null;

  return participantAgentIDs.includes(trimmed) ? trimmed : null;
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

/**
 * Build the content object for a UserMessage.
 *
 * Historically this was always `{ text }`. Wake payloads need to carry
 * structured context (question + answer + group) so the model can re-orient
 * without a tool call, so extra own-properties are merged in. When there is no
 * extra content the result is exactly `{ text }`, keeping ordinary messages
 * byte-identical to before.
 */
export function buildUserMessageContent(text, extra) {
  let content = { text };

  if (!extra || typeof extra !== 'object' || Array.isArray(extra))
    return content;

  for (let [ key, value ] of Object.entries(extra)) {
    if (key === 'text' || key === 'modelPrompt')
      continue;
    if (value === undefined)
      continue;
    content[key] = value;
  }

  return content;
}
