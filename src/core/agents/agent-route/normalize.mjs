'use strict';

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

export function resolveCoordinatorAgentID(session, participantAgentIDs) {
  if (typeof session?.coordinatorAgentID === 'string') {
    let coordinatorAgentID = session.coordinatorAgentID.trim();
    if (participantAgentIDs.includes(coordinatorAgentID))
      return coordinatorAgentID;
  }

  return participantAgentIDs[0] || null;
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
