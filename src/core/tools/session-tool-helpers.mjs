'use strict';

import { parseMentionReferences, resolveMentionActors } from '../mentions/index.mjs';

export async function postAgentSessionMessage({
  runtime,
  context = {},
  agentManager = null,
  sessionID,
  text,
  interactionID = null,
  agentID = null,
  targetAgentID = null,
  sourceSessionID = null,
  sourceFrameID = null,
}) {
  let entry = await runtime.ensureSessionEntry(sessionID);
  let stamp = typeof runtime.nextClockStamp === 'function'
    ? runtime.nextClockStamp()
    : { at: runtime.clock?.() || Date.now(), clock: null };
  let now = stamp.at;
  let references = parseMentionReferences(text);
  let mentions = references.length > 0
    ? await resolveMentionActors(references, {
      ...(context.services || {}),
      ...(agentManager ? { agentManager } : {}),
    })
    : {};
  let mentionIDs = Object.keys(mentions);
  let frame = {
    id: runtime.idGenerator?.() || entry.frameEngine.idGenerator?.() || `session-message:${now}`,
    type: 'AgentMessage',
    sessionID,
    interactionID: interactionID || context.frame?.interactionID || runtime.idGenerator?.() || `interaction:${now}`,
    parentID: null,
    authorType: 'agent',
    authorID: context.agent?.id || agentID || null,
    authorDisplayName: context.agent?.name || context.agent?.id || agentID || null,
    timestamp: now,
    createdAt: now,
    updatedAt: now,
    createdClock: stamp.clock,
    updatedClock: stamp.clock,
    hidden: false,
    deleted: false,
    ...(normalizeOptionalString(targetAgentID) ? { targetAgentID: normalizeOptionalString(targetAgentID) } : {}),
    content: {
      text,
      status: 'complete',
      sourceSessionID: normalizeOptionalString(sourceSessionID || context.sourceSession?.id || context.frame?.sessionID),
      sourceFrameID: normalizeOptionalString(sourceFrameID || context.frame?.id),
    },
  };

  if (mentionIDs.length > 0) {
    frame.mentions = mentions;
    // The mentioning agent has already decided who should act. Mark the frame
    // coordinated so the router dispatches the mentioned participants instead
    // of stopping at the coordinator (who is this frame's author).
    frame.coordinated = true;
  }

  let merged = entry.frameEngine.merge([ frame ], {
    authorType: 'agent',
    authorID: frame.authorID,
  });
  await runtime.frameStore?.flush?.();
  // merge() alone does not maintain the manifest counter. Without this the
  // returned session (and the session reference stamped onto the tool result)
  // still reports the pre-message count, so a freshly created child card says
  // "0 messages" even though its first message is already durable.
  runtime.syncSessionManifestFromEngine?.(entry, { frames: merged, persist: true });

  return {
    sessionID,
    session: sanitizeSession(entry.session),
    frame: sanitizeFrame(merged[0] || entry.frameEngine.get?.(frame.id) || frame),
    posted: true,
  };
}

// Who a `session-message` should actually START, given its own text.
//
// Deliberately the SAME resolver that stamps `frame.mentions` in
// `postAgentSessionMessage` above. If the wake target were computed separately,
// a message could render as "addressed to A" while waking B — and the whole
// point of surfacing these frames is that what a person sees is what happened.
//
// The sender is filtered out: an agent that mentions itself is making a note,
// not handing off work, and waking it would re-enter its own run.
//
// Returns `{ id, name }` pairs. `name` is best-effort because mention actors and
// full agent records are different shapes; an empty name is safe —
// `wakeAgentInSession` then omits `content.agentName` and the client falls back
// to the agent ID rather than inventing a name.
export async function resolveSessionMessageWakeTargets({ text, context = {}, agentManager = null } = {}) {
  let references = parseMentionReferences(text);
  if (references.length === 0)
    return [];

  let mentions = await resolveMentionActors(references, {
    ...(context.services || {}),
    ...(agentManager ? { agentManager } : {}),
  });

  let senderID = context.agent?.id || null;
  let targets = [];
  for (let mention of Object.values(mentions || {})) {
    let id = normalizeOptionalString(mention?.id);
    if (!id || id === senderID || targets.some((target) => target.id === id))
      continue;
    targets.push({
      id,
      name: normalizeOptionalString(mention?.name) || normalizeOptionalString(mention?.displayName) || '',
    });
  }

  return targets;
}

export function sanitizeSession(session = {}) {
  return {
    id: session.id || null,
    title: session.title || session.id || '',
    organizationID: session.organizationID || null,
    createdByUserID: session.createdByUserID || null,
    createdByAgentID: session.createdByAgentID || null,
    parentSessionID: session.parentSessionID || null,
    generation: sessionGeneration(session),
    messageCount: normalizeNonNegativeInteger(session.messageCount, 0),
    participantAgentIDs: normalizeStringArray(session.participantAgentIDs),
    participantUserIDs: normalizeStringArray(session.participantUserIDs),
    teamIDs: normalizeStringArray(session.teamIDs),
    coordinatorAgentID: session.coordinatorAgentID || null,
    createdAt: session.createdAt || null,
    updatedAt: session.updatedAt || null,
    createdClock: session.createdClock || null,
    updatedClock: session.updatedClock || null,
  };
}

export function sanitizeAgent(agent = {}) {
  return {
    id: agent.id || null,
    name: agent.name || agent.id || '',
    pluginID: agent.pluginID || null,
    enabled: agent.enabled !== false,
    character: typeof agent.character === 'string' ? agent.character : '',
    tags: Array.isArray(agent.tags) ? agent.tags.map((tag) => ({ ...tag })) : [],
    createdAt: agent.createdAt || null,
    updatedAt: agent.updatedAt || null,
  };
}

export function sanitizeFrame(frame = {}) {
  return {
    id: frame.id || null,
    type: frame.type || null,
    sessionID: frame.sessionID || null,
    interactionID: frame.interactionID || null,
    parentID: frame.parentID || null,
    authorType: frame.authorType || null,
    authorID: frame.authorID || null,
    authorDisplayName: frame.authorDisplayName || null,
    // Who a directed frame was addressed to. Dropped here until now, which is
    // why a tool could write a targeted message and then be unable to report who
    // it targeted. Additive: absence stays absent rather than becoming null.
    ...(normalizeOptionalString(frame.targetAgentID)
      ? { targetAgentID: normalizeOptionalString(frame.targetAgentID) }
      : {}),
    createdAt: frame.createdAt || null,
    updatedAt: frame.updatedAt || null,
    createdClock: frame.createdClock || null,
    updatedClock: frame.updatedClock || null,
    targets: Array.isArray(frame.targets) ? frame.targets.slice() : [],
    recipients: Array.isArray(frame.recipients) ? frame.recipients.slice() : [],
    mentions: frame.mentions && typeof frame.mentions === 'object' && !Array.isArray(frame.mentions) ? frame.mentions : {},
    coordinated: frame.coordinated === true,
    hidden: frame.hidden === true,
    deleted: frame.deleted === true,
    content: summarizeFrameContent(frame.content),
  };
}

export function sessionFrameSearchPath(frameStore, sessionID) {
  let rootPath = String(frameStore?.rootPath || '/kikx').replace(/\/+$/g, '');
  return `${rootPath}/sessions/${encodeURIComponent(sessionID)}/interactions`;
}

export function frameReferenceFromPath(path) {
  let fileName = String(path || '').split('/').pop() || '';
  let match = fileName.match(/^\d+-([^-]+)-(.+)\.json$/);
  if (!match)
    return {};

  return {
    frameType: decodeURIComponent(match[1]),
    frameID: decodeURIComponent(match[2]),
  };
}

export function summarizeFrameContent(content) {
  if (!content || typeof content !== 'object' || Array.isArray(content))
    return content ?? null;

  let output = {};
  for (let [key, value] of Object.entries(content)) {
    if (typeof value === 'string')
      output[key] = value.length > 2000 ? `${value.slice(0, 2000)}...` : value;
    else if (key === 'thinking' && value && typeof value === 'object')
      output[key] = { status: value.status || null, text: summarizeText(value.text) };
    else
      output[key] = value;
  }

  return output;
}

export function summarizeText(value) {
  if (typeof value !== 'string')
    return '';

  return value.length > 1000 ? `${value.slice(0, 1000)}...` : value;
}

export function requireTargetSessionID(sessionID) {
  let normalized = normalizeOptionalString(sessionID);
  if (!normalized)
    throw new TypeError('session_id is required when no current session is available');

  return normalized;
}

// Write/control tools must not silently fall back to the current session. A
// missing target is a recoverable failure that tells the model exactly how to
// find the intended session instead of posting into the wrong one.
export function missingExplicitSessionTargetError(toolName, currentSessionID) {
  let current = normalizeOptionalString(currentSessionID);
  let error = new Error(
    `${toolName} requires an explicit session_id.`
    + (current ? ` Current session is ${current}.` : '')
    + ' Call session-list with query=<title or id fragment> to resolve the intended target, then retry with that session_id. Nothing was written.',
  );
  error.status = 400;
  return error;
}

export function normalizeStringArray(values) {
  if (!Array.isArray(values))
    return [];

  let output = [];
  for (let value of values) {
    let normalized = normalizeOptionalString(value);
    if (normalized && !output.includes(normalized))
      output.push(normalized);
  }

  return output;
}

export async function resolveAgents(agentManager, refs) {
  let agents = [];
  for (let ref of refs) {
    let agent;
    if (typeof agentManager.resolveAgent === 'function') {
      agent = await agentManager.resolveAgent(ref);
    } else if (typeof agentManager.getAgent === 'function') {
      agent = await agentManager.getAgent(ref);
    } else {
      throw new Error('Agent resolution requires agentManager.resolveAgent() or getAgent()');
    }

    if (!agent?.id)
      throw new Error(`Agent not found: ${ref}`);

    if (!agents.some((candidate) => candidate.id === agent.id))
      agents.push(agent);
  }

  return agents;
}

export function uniqueStrings(values) {
  let output = [];
  for (let value of values || []) {
    let normalized = normalizeOptionalString(value);
    if (normalized && !output.includes(normalized))
      output.push(normalized);
  }

  return output;
}

export async function findReusableChildSession(runtime, { title, parentSessionID, createdByAgentID }) {
  let normalizedTitle = normalizeOptionalString(title).toLowerCase();
  let normalizedParentID = normalizeOptionalString(parentSessionID);
  let normalizedAgentID = normalizeOptionalString(createdByAgentID);
  if (!normalizedTitle || !normalizedParentID || !normalizedAgentID || typeof runtime?.listSessions !== 'function')
    return null;

  let offset = 0;
  let limit = 100;
  while (offset < 1000) {
    let sessions = await runtime.listSessions({ limit, offset });
    for (let session of sessions || []) {
      if (normalizeOptionalString(session.title).toLowerCase() !== normalizedTitle)
        continue;

      if (normalizeOptionalString(session.parentSessionID) !== normalizedParentID)
        continue;

      if (normalizeOptionalString(session.createdByAgentID) !== normalizedAgentID)
        continue;

      return session;
    }

    if (!Array.isArray(sessions) || sessions.length < limit)
      break;

    offset += limit;
  }

  return null;
}

export function normalizeRequiredString(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '')
    throw new TypeError(`${fieldName} must be a non-empty string`);

  return value.trim();
}

export function normalizeOptionalString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizeNonNegativeInteger(value, fallback) {
  let number = Number(value);
  if (!Number.isFinite(number) || number < 0)
    return fallback;

  return Math.trunc(number);
}

export function sessionGeneration(session) {
  if (!session || typeof session !== 'object')
    return 0;

  let number = Number(session.generation);
  if (Number.isFinite(number) && number >= 0)
    return Math.trunc(number);

  return session.parentSessionID ? 1 : 0;
}

export function clampInteger(value, defaultValue, min, max) {
  let number = Number(value);
  if (!Number.isFinite(number))
    number = defaultValue;

  number = Math.trunc(number);
  return Math.min(max, Math.max(min, number));
}

export function resolveContextService(context, name) {
  let appContext = context.services?.context || context.context;
  if (appContext?.has?.(name) && typeof appContext.require === 'function')
    return appContext.require(name);

  if (typeof appContext?.require === 'function') {
    try {
      return appContext.require(name);
    } catch (_error) {
      return null;
    }
  }

  return null;
}
