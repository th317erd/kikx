'use strict';

// "Send once" detection for Brief A (P4).
//
// Brief A is sent when an agent (re)starts: the first message in a thread, after
// a compaction boundary, when the coordinator changes, or when a new party joins.
// Per decision D8 the decision is recomputed from the context wherever possible:
//   - first message / post-compaction are derived from the projected frames
//     (a compaction drops the agent's pre-boundary messages, and a boundary
//     newer than the agent's newest message means "re-acquire intent").
//   - coordinator / party changes are compared against a tiny, backwards-safe
//     `session.briefState` marker written only after Brief A is emitted.

import { isCompactionFrame } from '../frames/frame-types/frame-type-helpers.mjs';
import { normalizeOptionalPromptString, normalizeStringArray } from './agent-normalizers.mjs';

// Monotonic compaction boundary identity, using the same precedence the
// compaction builder uses so a boundary advance is detected reliably.
export function compactionBoundaryKey(frame) {
  if (!frame)
    return '';

  return String(
    frame.compaction?.boundaryFrameID
      || frame.content?.boundaryFrameID
      || frame.id
      || '',
  );
}

export function compactionBoundaryOrder(frame) {
  return Number(
    frame?.compaction?.boundaryOrder
      ?? frame?.content?.boundaryOrder
      ?? frame?.order
      ?? 0,
  ) || 0;
}

// Most recent completed compaction frame in a context, or null.
export function latestCompactionFrame(context = {}) {
  let frames = Array.isArray(context.frames) ? context.frames : [];
  let latest = null;

  for (let frame of frames) {
    if (!isCompactionFrame(frame))
      continue;

    // P7: a completed OR trimmed/failed boundary is a real boundary (it advances
    // the agent's memory start). Only an in-flight frame is not yet a boundary.
    if (frame.content?.status === 'started' || frame.content?.status === 'running')
      continue;

    if (!latest || compactionBoundaryOrder(frame) >= compactionBoundaryOrder(latest))
      latest = frame;
  }

  return latest || context.contextMemory?.latestCompaction || null;
}

// Newest durable, visible AgentMessage order (any agent), or null when none.
export function newestAgentMessageOrder(context = {}) {
  let frames = Array.isArray(context.frames) ? context.frames : [];
  let newest = null;

  for (let frame of frames) {
    if (frame?.type !== 'AgentMessage')
      continue;

    if (frame.phantom === true || frame.hidden === true || frame.deleted === true)
      continue;

    let order = Number(frame.order ?? 0) || 0;
    if (newest === null || order > newest)
      newest = order;
  }

  return newest;
}

// Which parties are present, as a stable, ordered key. Counts agents and users
// (decision D3), plus the current agent, so a roster change is detected.
export function partySignature(context = {}) {
  let ids = normalizeStringArray(context.participantAgentIDs || context.session?.participantAgentIDs);
  ids.push(...normalizeStringArray(context.session?.participantUserIDs));

  let selfID = normalizeOptionalPromptString(context.agent?.id);
  if (selfID)
    ids.push(selfID);

  let merged = [];
  for (let id of ids) {
    if (!merged.includes(id))
      merged.push(id);
  }

  return merged.sort().join(',');
}

// In-process markers keyed by the live session object. A WeakMap is deliberate:
// the marker survives across turns within a running process (same session
// instance) but is never serialized into the session manifest, so a process
// restart — a genuine "(re)start" — re-sends Brief A. This keeps persistence
// backwards-safe with no schema change (decision D8).
//
// Markers are tracked PER AGENT (`agents[agentID]`), because a session can have
// several agents taking turns. A single shared slot would treat every speaker
// change as a "new agent" and re-send Brief A on each alternation.
const startBriefMarkers = new WeakMap();

export function getStartBriefMarker(session) {
  if (!session || typeof session !== 'object')
    return null;

  return startBriefMarkers.get(session) || null;
}

// The per-agent entry recorded the last time Brief A was emitted, or null.
export function getStartBriefAgentEntry(session, agentID) {
  let marker = getStartBriefMarker(session);
  if (!marker || !marker.agents)
    return null;

  return marker.agents[agentID || ''] || null;
}

// Whether Brief A should be sent for this turn (P4). Returns `{ send, reason }`.
// Reasons are diagnostic only and must not affect behavior.
export function shouldSendStartBrief(context = {}) {
  let session = context.session;
  let agentID = context.agent?.id || '';
  let entry = getStartBriefAgentEntry(session, agentID);
  let latest = latestCompactionFrame(context);
  let boundaryKey = latest ? compactionBoundaryKey(latest) : '';

  if (!entry) {
    // No memory of briefing this agent in this live session: either the very
    // first message in the thread, or an agent joining / being routed for the
    // first time. Either way it needs the brief.
    return {
      send: true,
      reason: newestAgentMessageOrder(context) === null ? 'first-message' : 'new-agent',
    };
  }

  if ((entry.boundaryKey || '') !== boundaryKey)
    return { send: true, reason: 'compaction' };

  let coordinatorID = context.coordinatorAgentID || session?.coordinatorAgentID || '';
  if ((entry.coordinatorID || '') !== coordinatorID)
    return { send: true, reason: 'coordinator-changed' };

  if ((entry.parties || '') !== partySignature(context))
    return { send: true, reason: 'participants-changed' };

  return { send: false, reason: 'unchanged' };
}

// Record that Brief A was emitted for this turn's boundary state. Only the
// current agent's entry is updated; other agents keep their own markers.
export function markStartBriefSent(context = {}) {
  let session = context.session;
  if (!session || typeof session !== 'object')
    return;

  let latest = latestCompactionFrame(context);
  let previous = getStartBriefMarker(session);
  let agents = { ...(previous?.agents || {}) };
  let agentID = context.agent?.id || '';
  agents[agentID] = {
    coordinatorID: context.coordinatorAgentID || session.coordinatorAgentID || '',
    boundaryKey: compactionBoundaryKey(latest),
    parties: partySignature(context),
    updatedAt: Date.now(),
  };

  startBriefMarkers.set(session, { agents });
}
