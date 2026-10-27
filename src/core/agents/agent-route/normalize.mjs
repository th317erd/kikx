'use strict';

import { resolveLocalCoordinatorAgentID } from '../coordinator-scope.mjs';

export function normalizeOptionalString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizeNonNegativeInteger(value) {
  let number = Number(value);
  if (!Number.isFinite(number) || number <= 0)
    return 0;

  return Math.trunc(number);
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

export function uniqueStrings(values) {
  let unique = [];
  for (let value of Array.isArray(values) ? values : []) {
    if (typeof value !== 'string' || value.trim() === '')
      continue;

    let item = value.trim();
    if (!unique.includes(item))
      unique.push(item);
  }

  return unique;
}

// Local, non-inheriting resolution. The tree-aware answer -- which walks parent
// sessions and force-promotes when no ancestor has a coordinator -- lives in
// exactly one place, `resolveSessionCoordinator` in ../coordinator-scope.mjs.
// This function has no session lookup in scope, so it can only answer the
// single-session question: "is this session's own coordinator still a
// participant, and if not, who is first in line?".
//
// Every caller that holds a tree must use `resolveSessionCoordinator` instead.
// Keeping the rule identical here rather than deleting it is deliberate: the
// three call sites that use it (routing, compaction) already treat the result as
// a local designation, and compaction explicitly refuses to treat this fallback
// as a designation (see select-compactor.mjs:66).
export function resolveCoordinatorAgentID(session, participantAgentIDs) {
  return resolveLocalCoordinatorAgentID(session, participantAgentIDs);
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

export function sanitizeParticipantAgent(agent) {
  let id = typeof agent?.id === 'string' ? agent.id.trim() : '';
  let name = typeof agent?.name === 'string' ? agent.name.trim() : '';
  let pluginID = typeof agent?.pluginID === 'string'
    ? agent.pluginID.trim()
    : (typeof agent?.pluginId === 'string' ? agent.pluginId.trim() : '');

  return {
    id,
    name: name || id,
    pluginID,
  };
}

export function delayMsToClockUnits(delayMs, now) {
  let multiplier = Math.abs(Number(now)) >= 100_000_000_000_000 ? 1000 : 1;
  return Math.trunc(delayMs * multiplier);
}

export function isHiddenScheduledTargetFrame(context, frame) {
  if (context?.commit?.scheduledDispatch === true)
    return typeof frame?.targetAgentID === 'string' && frame.targetAgentID.trim() !== '';

  if (typeof frame?.targetAgentID !== 'string' || frame.targetAgentID.trim() === '')
    return false;

  let scheduledAt = Number(frame.scheduledAt);
  if (!Number.isFinite(scheduledAt) || scheduledAt <= 0)
    return false;

  if (frame.scheduledStatus === 'fired' || frame.scheduledStatus === 'cancelled')
    return false;

  return scheduledAt <= (context?.services?.clock?.() || Date.now());
}

export function normalizeDoneStatus(status) {
  if (typeof status !== 'string')
    return '';

  return status.trim();
}

export function shouldCleanupResponseFrame(status) {
  return status === 'forwarded' || status === 'null-response' || status === 'break';
}
