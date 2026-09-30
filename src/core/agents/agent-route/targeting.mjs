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
  let targetAgentID = normalizeOptionalString(frame?.targetAgentID);
  if (targetAgentID)
    return participantAgentIDs.includes(targetAgentID) ? [ targetAgentID ] : [];

  if (frame?.type === 'AgentMessage') {
    return participantAgentIDs.filter((agentID) => agentID !== frame.authorID);
  }

  if (frame?.coordinated === true) {
    let mentionedAgentIDs = Object.entries(frame.mentions || {})
      .filter(([actorID, mention]) => mention?.type === 'agent' || participantAgentIDs.includes(actorID))
      .map(([actorID]) => actorID)
      .filter((actorID) => actorID !== coordinatorAgentID && participantAgentIDs.includes(actorID));

    return uniqueStrings(mentionedAgentIDs);
  }

  return uniqueStrings([ coordinatorAgentID, ...participantAgentIDs ]);
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
