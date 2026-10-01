'use strict';

import {
  isHiddenScheduledTargetFrame,
  normalizeOptionalString,
  normalizeStringArray,
  uniqueStrings,
} from './normalize.mjs';

export function shouldRouteToAgents(context, frame) {
  if (!frame || frame.phantom || frame.deleted === true)
    return false;

  if (frame.hidden === true && !isHiddenScheduledTargetFrame(context, frame))
    return false;

  if (frame.type === 'UserMessage')
    return shouldRouteUserMessage(context, frame);

  if (frame.type === 'AgentMessage')
    return shouldRouteAgentMessage(context, frame);

  return false;
}

function shouldRouteUserMessage(context, frame) {
  if (context.change?.operation && context.change.operation !== 'create' && frame?.coordinated !== true)
    return false;

  let text = frame.content?.text;
  if (typeof text === 'string' && text.trim().startsWith('/'))
    return false;

  return true;
}

function shouldRouteAgentMessage(context, frame) {
  if (frame.authorType !== 'agent' || typeof frame.authorID !== 'string' || frame.authorID.trim() === '')
    return false;

  if (frame.content?.status === 'streaming')
    return false;

  let operation = context.change?.operation || 'create';
  if (operation === 'create')
    return true;

  if (operation !== 'update')
    return false;

  if (frame.coordinated === true)
    return false;

  let previous = context.previousFrame || {};
  let becameVisible = previous.hidden !== false && frame.hidden === false;
  let finalized = previous.content?.status === 'streaming' && frame.content?.status !== 'streaming';
  return becameVisible || finalized;
}

export function resolveRouteTargets({ frame, participantAgentIDs, coordinatorAgentID }) {
  // Explicit single-target bypass (scheduled continuations, async process wakes)
  // wins over everything else.
  let targetAgentID = normalizeOptionalString(frame?.targetAgentID);
  if (targetAgentID)
    return participantAgentIDs.includes(targetAgentID) ? [ targetAgentID ] : [];

  let recipients = resolveFrameRecipients(frame);

  // A coordinated frame was already routed by the coordinator; trigger only its
  // recipients (never re-wake the coordinator on its own routing decision).
  if (frame?.coordinated === true) {
    return uniqueStrings(recipients)
      .filter((agentID) => participantAgentIDs.includes(agentID) && agentID !== frame?.authorID);
  }

  // Otherwise the coordinator is the router for all traffic: it is always
  // triggered (so it can decide), plus any explicit recipients. The author is
  // never a target of its own message.
  let targets = [];
  if (coordinatorAgentID)
    targets.push(coordinatorAgentID);
  targets.push(...recipients);

  return uniqueStrings(targets)
    .filter((agentID) => participantAgentIDs.includes(agentID) && agentID !== frame?.authorID);
}

// Trigger truth for a frame: explicit `recipients` when present, else derived
// from resolved `mentions`. `recipients` is a generic actor-id list (agents
// today; users/plugin actors later).
export function resolveFrameRecipients(frame) {
  let recipients = normalizeStringArray(frame?.recipients);
  if (recipients.length > 0)
    return recipients;

  if (frame?.mentions && typeof frame.mentions === 'object' && !Array.isArray(frame.mentions))
    return Object.keys(frame.mentions);

  return [];
}

export function filterRedundantRouteTargets({ frame, routeTargets, frameEngine }) {
  let targets = uniqueStrings(routeTargets);
  if (!frame || targets.length === 0 || !frameEngine)
    return targets;

  return targets.filter((agentID) => shouldDeliverFrameToAgent({ frame, agentID, frameEngine }));
}

function shouldDeliverFrameToAgent({ frame, agentID, frameEngine }) {
  if (hasAgentRouteForSourceFrame({ frameEngine, sourceFrameID: frame.id, agentID }))
    return false;

  if (frame.type !== 'AgentMessage')
    return true;

  if (isExplicitAgentTarget(frame, agentID))
    return true;

  return !hasVisibleAgentResponseForRoot({ frameEngine, frame, agentID });
}

function hasAgentRouteForSourceFrame({ frameEngine, sourceFrameID, agentID }) {
  if (!sourceFrameID || !agentID)
    return false;

  for (let candidate of frameEngine.toArray?.() || []) {
    if (!candidate || candidate.id === sourceFrameID)
      continue;

    if (candidate.type !== 'AgentMessage' || candidate.authorID !== agentID)
      continue;

    if (candidate.deleted === true)
      continue;

    if (candidate.parentID === sourceFrameID)
      return true;

    let route = normalizeAgentRoute(candidate.agentRoute);
    if (route.sourceFrameID === sourceFrameID)
      return true;
  }

  return false;
}

function hasVisibleAgentResponseForRoot({ frameEngine, frame, agentID }) {
  let rootFrameID = normalizeAgentRoute(frame.agentRoute).rootFrameID || frame.parentID || null;
  if (!rootFrameID || !agentID)
    return false;

  for (let candidate of frameEngine.toArray?.() || []) {
    if (!candidate || candidate.id === frame.id)
      continue;

    if (candidate.type !== 'AgentMessage' || candidate.authorID !== agentID)
      continue;

    if (candidate.hidden === true || candidate.deleted === true)
      continue;

    let route = normalizeAgentRoute(candidate.agentRoute);
    if (route.rootFrameID === rootFrameID || candidate.parentID === rootFrameID)
      return true;
  }

  return false;
}

function isExplicitAgentTarget(frame, agentID) {
  if (!frame || !agentID)
    return false;

  if (frame.targetAgentID === agentID)
    return true;

  if (normalizeStringArray(frame.recipients).includes(agentID))
    return true;

  let mention = frame.mentions?.[agentID];
  return mention?.type === 'agent' || mention != null;
}

export function createResponseAgentRoute({ sourceFrame, agentID }) {
  let inherited = normalizeAgentRoute(sourceFrame?.agentRoute);
  let inheritedPath = inherited.path.length > 0
    ? inherited.path
    : normalizeStringArray(sourceFrame?.authorType === 'agent' ? [ sourceFrame.authorID ] : []);

  return {
    rootFrameID: inherited.rootFrameID || sourceFrame?.id || null,
    sourceFrameID: sourceFrame?.id || null,
    path: uniqueStrings([ ...inheritedPath, agentID ]),
  };
}

export function normalizeAgentRoute(agentRoute) {
  if (!agentRoute || typeof agentRoute !== 'object') {
    return {
      rootFrameID: null,
      sourceFrameID: null,
      path: [],
    };
  }

  return {
    rootFrameID: typeof agentRoute.rootFrameID === 'string' && agentRoute.rootFrameID.trim()
      ? agentRoute.rootFrameID.trim()
      : null,
    sourceFrameID: typeof agentRoute.sourceFrameID === 'string' && agentRoute.sourceFrameID.trim()
      ? agentRoute.sourceFrameID.trim()
      : null,
    path: normalizeStringArray(agentRoute.path),
  };
}
