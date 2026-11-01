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

  // Agent-only frames (a transport's own frame type) are routed to the agent and
  // hidden from the thread. They are checked here rather than allowed through a
  // `hidden` exemption: `hidden` also means "do not project into model context"
  // in frame-type-base and the compaction builder, so reusing it would deliver
  // the frame to routing and drop it from the prompt.
  if (frame.agentOnly === true)
    return shouldRouteAgentOnlyFrame(context, frame);

  if (frame.type === 'UserMessage')
    return shouldRouteUserMessage(context, frame);

  if (frame.type === 'AgentMessage')
    return shouldRouteAgentMessage(context, frame);

  return false;
}

// An agent-only frame is routed the way a user message is, because that is what
// it is from the agent's point of view: something addressed to it that it has not
// answered yet. Only creation routes - an edit must not start a second turn, the
// same rule shouldRouteUserMessage applies.
function shouldRouteAgentOnlyFrame(context, frame) {
  if (frame.deleted === true)
    return false;

  let operation = context.change?.operation || 'create';
  if (operation !== 'create' && frame.coordinated !== true)
    return false;

  let text = frame.content?.text;
  return typeof text === 'string' && text.trim() !== '';
}

function shouldRouteUserMessage(context, frame) {
  if (context.change?.operation && context.change.operation !== 'create' && frame?.coordinated !== true)
    return false;

  let text = frame.content?.text;
  // Only an actual slash-command token suppresses agent routing. A bare leading
  // slash is not enough: pasted absolute paths (for example
  // /Users/wyatt/Pictures/screenshot.png) used to be mistaken for commands and
  // silently never reached the agent.
  if (isSlashCommandText(text))
    return false;

  return true;
}

function isSlashCommandText(text) {
  if (typeof text !== 'string')
    return false;

  let trimmed = text.trim();
  return /^\/[A-Za-z][A-Za-z0-9:_-]*(?:\s|$)/.test(trimmed)
    && !trimmed.startsWith('//');
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

    // A recovered error is evidence the previous turn was interrupted, not a
    // completed response. It must not suppress the recovery retry, or a server
    // restart leaves the agent permanently unable to respond to its trigger.
    if (isRecoveredErrorResponse(candidate))
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

    if (isRecoveredErrorResponse(candidate))
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

function isRecoveredErrorResponse(frame) {
  return frame?.content?.status === 'error'
    && frame?.content?.error?.recovered === true;
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
