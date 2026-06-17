'use strict';

export function createSessionStateSnapshot(input = {}) {
  return {
    sessionIDs: Array.isArray(input.sessionIDs) ? [ ...input.sessionIDs ] : [],
    sessionDetailsByID: { ...(input.sessionDetailsByID || {}) },
    framesBySessionID: { ...(input.framesBySessionID || {}) },
  };
}

export function mergeSessions(state, nextSessions) {
  let snapshot = createSessionStateSnapshot(state);
  let sessionIDs = [];
  let sessionDetailsByID = {};

  for (let session of Array.isArray(nextSessions) ? nextSessions : []) {
    if (!session?.id)
      continue;

    let previous = snapshot.sessionDetailsByID[session.id] || {};
    sessionIDs.push(session.id);
    sessionDetailsByID[session.id] = mergeSessionDetail(previous, session);
  }

  return {
    ...snapshot,
    sessionIDs,
    sessionDetailsByID,
  };
}

export function upsertSessionState(state, session) {
  let snapshot = createSessionStateSnapshot(state);
  if (!session?.id)
    return snapshot;

  let sessionIDs = snapshot.sessionIDs.includes(session.id)
    ? snapshot.sessionIDs
    : [ session.id, ...snapshot.sessionIDs ];

  return {
    ...snapshot,
    sessionIDs,
    sessionDetailsByID: {
      ...snapshot.sessionDetailsByID,
      [session.id]: mergeSessionDetail(snapshot.sessionDetailsByID[session.id], session),
    },
  };
}

export function setSessionFramesState(state, sessionID, frames) {
  let snapshot = createSessionStateSnapshot(state);
  let safeFrames = collapseToolDisplayFrames(sortFrames(Array.isArray(frames) ? [ ...frames ] : []));
  let next = {
    ...snapshot,
    framesBySessionID: {
      ...snapshot.framesBySessionID,
      [sessionID]: safeFrames,
    },
  };

  if (!sessionID)
    return next;

  let previous = snapshot.sessionDetailsByID[sessionID];
  if (!previous)
    return next;

  return {
    ...next,
    sessionDetailsByID: {
      ...next.sessionDetailsByID,
      [sessionID]: {
        ...previous,
        messageCount: typeof previous.messageCount === 'number'
          ? previous.messageCount
          : countMessageFrames(safeFrames),
      },
    },
  };
}

export function upsertFrameState(state, sessionID, frame) {
  let snapshot = createSessionStateSnapshot(state);
  if (!sessionID || !frame?.id)
    return snapshot;

  return setSessionFramesState(snapshot, sessionID, upsertFrameArray(snapshot.framesBySessionID[sessionID] || [], frame));
}

export function upsertFramesState(state, framesBySessionID) {
  let snapshot = createSessionStateSnapshot(state);
  let next = snapshot;

  for (let [sessionID, frames] of normalizeFrameBatch(framesBySessionID)) {
    let nextFrames = next.framesBySessionID[sessionID] || [];
    for (let frame of frames) {
      if (!frame?.id)
        continue;

      nextFrames = upsertFrameArray(nextFrames, frame);
    }

    next = setSessionFramesState(next, sessionID, nextFrames);
  }

  return next;
}

function upsertFrameArray(frames, frame) {
  let normalizedFrame = normalizeLiveFrame(frame);
  if (isResponseFramePhantom(normalizedFrame))
    return upsertResponseFramePhantom(frames, normalizedFrame);

  if (isToolFrame(normalizedFrame))
    return upsertToolDisplayFrame(frames, normalizedFrame);

  let transitionFrames = removeFramesForLiveTransition(frames, normalizedFrame);
  let existingIndex = transitionFrames.findIndex((candidate) => candidate?.id === normalizedFrame.id);

  if (normalizedFrame.type === 'EndTyping')
    return transitionFrames;

  let nextFrame = {
    ...normalizedFrame,
    hidden: normalizedFrame.hidden ?? false,
  };

  if (existingIndex !== -1) {
    let existingFrame = transitionFrames[existingIndex] || {};
    for (let fieldName of [
      'order',
      'createdAt',
      'createdClock',
      'timestamp',
      'sessionID',
      'interactionID',
      'parentID',
      'authorType',
      'authorID',
    ]) {
      if (nextFrame[fieldName] == null && existingFrame[fieldName] != null)
        nextFrame[fieldName] = existingFrame[fieldName];
    }

    if (!nextFrame.authorDisplayName && existingFrame.authorDisplayName)
      nextFrame.authorDisplayName = existingFrame.authorDisplayName;

    if (isPlainObject(nextFrame.content))
      nextFrame.content = mergeContent(existingFrame.content || {}, nextFrame.content);
  }

  if (normalizedFrame.phantom && LIVE_VISIBLE_PHANTOM_TYPES.has(normalizedFrame.type))
    nextFrame.hidden = false;

  return existingIndex === -1
    ? [ ...transitionFrames, nextFrame ]
    : transitionFrames.map((candidate, index) => index === existingIndex ? nextFrame : candidate);
}

function collapseToolDisplayFrames(frames) {
  let output = [];
  for (let frame of frames) {
    if (isToolFrame(frame))
      output = upsertToolDisplayFrame(output, frame);
    else
      output.push(frame);
  }

  return output;
}

function upsertToolDisplayFrame(frames, frame) {
  let normalizedFrame = {
    ...frame,
    hidden: frame.hidden ?? false,
  };

  if (isToolResultFrame(normalizedFrame)) {
    let callIndex = findToolCallFrameIndex(frames, normalizedFrame);
    if (callIndex !== -1) {
      let callFrame = frames[callIndex];
      let mergedFrame = mergeToolCallAndResultFrame(callFrame, normalizedFrame);
      return frames.map((candidate, index) => index === callIndex ? mergedFrame : candidate);
    }
  }

  if (isToolCallFrame(normalizedFrame)) {
    let resultIndex = findToolResultFrameIndex(frames, normalizedFrame);
    if (resultIndex !== -1) {
      let resultFrame = frames[resultIndex];
      let mergedFrame = mergeToolCallAndResultFrame(normalizedFrame, resultFrame);
      let existingCallIndex = frames.findIndex((candidate) => candidate?.id === normalizedFrame.id);
      let withoutResult = frames.filter((_candidate, index) => index !== resultIndex);

      if (existingCallIndex !== -1)
        return withoutResult.map((candidate) => candidate?.id === normalizedFrame.id ? mergedFrame : candidate);

      return [
        ...withoutResult.slice(0, resultIndex),
        mergedFrame,
        ...withoutResult.slice(resultIndex),
      ];
    }
  }

  let existingIndex = frames.findIndex((candidate) => candidate?.id === normalizedFrame.id);
  if (existingIndex === -1)
    return [ ...frames, normalizedFrame ];

  let existingFrame = frames[existingIndex];
  let nextFrame = mergeToolFrame(existingFrame, normalizedFrame);
  return frames.map((candidate, index) => index === existingIndex ? nextFrame : candidate);
}

function mergeToolCallAndResultFrame(callFrame, resultFrame) {
  let content = mergeContent(callFrame?.content || {}, resultFrame?.content || {});
  return {
    ...(callFrame || {}),
    type: resultFrame?.type || callFrame?.type,
    updatedAt: resultFrame?.updatedAt || callFrame?.updatedAt,
    updatedClock: resultFrame?.updatedClock || callFrame?.updatedClock,
    commitOrder: resultFrame?.commitOrder ?? callFrame?.commitOrder,
    hidden: resultFrame?.hidden ?? callFrame?.hidden ?? false,
    deleted: resultFrame?.deleted ?? callFrame?.deleted ?? false,
    state: {
      ...(callFrame?.state || {}),
      ...(resultFrame?.state || {}),
    },
    content: {
      ...content,
      phase: 'result',
      toolResultFrameID: resultFrame?.id || content.toolResultFrameID || null,
    },
  };
}

function mergeToolFrame(existingFrame, nextFrame) {
  if (isToolCallFrame(nextFrame) && isToolResultFrame(existingFrame))
    return mergeToolCallAndResultFrame(nextFrame, existingFrame);

  let output = {
    ...existingFrame,
    ...nextFrame,
  };

  for (let fieldName of [
    'order',
    'createdAt',
    'createdClock',
    'timestamp',
    'sessionID',
    'interactionID',
    'parentID',
    'authorType',
    'authorID',
  ]) {
    if (output[fieldName] == null && existingFrame?.[fieldName] != null)
      output[fieldName] = existingFrame[fieldName];
  }

  if (!output.authorDisplayName && existingFrame?.authorDisplayName)
    output.authorDisplayName = existingFrame.authorDisplayName;

  if (isPlainObject(output.content) && isPlainObject(existingFrame?.content))
    output.content = mergeContent(existingFrame.content, output.content);

  return output;
}

function findToolCallFrameIndex(frames, resultFrame) {
  let content = resultFrame?.content || {};
  let resultParentID = stringOr(resultFrame?.parentID);
  let callFrameID = stringOr(content.toolCallFrameID) || resultParentID;
  let toolCallID = stringOr(content.toolCallID);

  return frames.findIndex((candidate) => {
    if (!isToolFrame(candidate) || candidate?.id === resultFrame?.id)
      return false;

    if (callFrameID && candidate.id === callFrameID)
      return true;

    return toolCallID && candidate.content?.toolCallID === toolCallID;
  });
}

function findToolResultFrameIndex(frames, callFrame) {
  let content = callFrame?.content || {};
  let callFrameID = stringOr(callFrame?.id);
  let toolCallID = stringOr(content.toolCallID);

  return frames.findIndex((candidate) => {
    if (!isToolResultFrame(candidate) || candidate?.id === callFrame?.id)
      return false;

    if (callFrameID && (candidate.content?.toolCallFrameID === callFrameID || candidate.parentID === callFrameID))
      return true;

    return toolCallID && candidate.content?.toolCallID === toolCallID;
  });
}

function isToolFrame(frame) {
  return Boolean(frame?.content?.toolName)
    && (
      frame.type === 'ToolCall'
      || frame.type === 'ToolResult'
      || frame.content.phase === 'call'
      || frame.content.phase === 'result'
      || /ToolFrame$/.test(String(frame.type || ''))
    );
}

function isToolCallFrame(frame) {
  return isToolFrame(frame) && (frame.content?.phase === 'call' || frame.type === 'ToolCall');
}

function isToolResultFrame(frame) {
  return isToolFrame(frame) && (frame.content?.phase === 'result' || frame.type === 'ToolResult');
}

export function countMessageFrames(frames) {
  return (Array.isArray(frames) ? frames : []).filter((frame) => frame?.type === 'UserMessage').length;
}

function mergeSessionDetail(previous = {}, next = {}) {
  let merged = {
    ...previous,
    ...next,
  };

  if (typeof next.messageCount !== 'number' && typeof previous.messageCount === 'number')
    merged.messageCount = previous.messageCount;

  return merged;
}

function normalizeLiveFrame(frame) {
  if (frame?.type === 'BeginTyping' || frame?.type === 'EndTyping') {
    let agentID = frame.authorID || frame.content?.agentID || 'default';
    return {
      ...frame,
      id: `typing:${agentID}`,
      authorID: agentID,
      hidden: false,
    };
  }

  if (frame?.phantom && frame.groupID)
    return { ...frame, id: frame.groupID };

  return frame;
}

function removeFramesForLiveTransition(frames, frame) {
  if (!Array.isArray(frames))
    return [];

  if (frame.type === 'EndTyping')
    return frames.filter((candidate) => candidate?.id !== frame.id);

  if (frame.type === 'AgentMessage')
    return frames.filter((candidate) => {
      if (!candidate)
        return false;

      if (candidate.id === frame.id)
        return true;

      if (candidate.parentID !== frame.parentID)
        return true;

      return candidate.type !== 'AgentThinking' && candidate.type !== 'AgentMessageDelta';
    });

  return frames.slice();
}

function isResponseFramePhantom(frame) {
  return frame?.phantom === true
    && typeof frame.responseFrameID === 'string'
    && frame.responseFrameID.trim() !== ''
    && (frame.type === 'AgentThinking' || frame.type === 'AgentMessageDelta');
}

function upsertResponseFramePhantom(frames, frame) {
  let responseFrameID = frame.responseFrameID.trim();
  let transitionFrames = removeResponseFramePhantoms(frames, frame);
  let existingIndex = transitionFrames.findIndex((candidate) => candidate?.id === responseFrameID);
  let existing = existingIndex === -1 ? null : transitionFrames[existingIndex];
  let nextFrame = mergeResponseFramePhantom(existing, frame, responseFrameID);
  return existingIndex === -1
    ? [ ...transitionFrames, nextFrame ]
    : transitionFrames.map((candidate, index) => index === existingIndex ? nextFrame : candidate);
}

function removeResponseFramePhantoms(frames, frame) {
  if (!Array.isArray(frames))
    return [];

  let responseFrameID = frame.responseFrameID;
  return frames.filter((candidate) => {
    if (!candidate)
      return false;

    if (candidate.id === frame.id && candidate.id !== responseFrameID)
      return false;

    if (candidate.phantom && candidate.responseFrameID === responseFrameID && candidate.id !== responseFrameID)
      return false;

    return true;
  });
}

function mergeResponseFramePhantom(existing, frame, responseFrameID) {
  let content = mergeContent(existing?.content || {}, responseFramePhantomContent(frame));
  let hasOutputText = typeof content.text === 'string' && content.text.length > 0;
  let shouldShow = frame.type === 'AgentMessageDelta' || existing?.hidden === false || hasOutputText;

  return {
    ...(existing || {}),
    id: responseFrameID,
    type: existing?.type || 'AgentMessage',
    sessionID: existing?.sessionID || frame.sessionID,
    interactionID: existing?.interactionID || frame.interactionID,
    parentID: existing?.parentID ?? frame.parentID ?? null,
    authorType: existing?.authorType || frame.authorType || 'agent',
    authorID: existing?.authorID || frame.authorID || frame.content?.agentID || null,
    authorDisplayName: existing?.authorDisplayName || frame.authorDisplayName || frame.content?.agentName || null,
    order: existing?.order ?? frame.order,
    commitOrder: existing?.commitOrder ?? frame.commitOrder,
    timestamp: existing?.timestamp || frame.timestamp,
    createdAt: existing?.createdAt || frame.createdAt,
    updatedAt: frame.updatedAt || existing?.updatedAt,
    createdClock: existing?.createdClock || frame.createdClock,
    updatedClock: frame.updatedClock || existing?.updatedClock,
    hidden: shouldShow ? false : existing?.hidden ?? true,
    deleted: existing?.deleted ?? frame.deleted ?? false,
    phantom: false,
    responseFrameID,
    content,
  };
}

function responseFramePhantomContent(frame) {
  let content = frame.content || {};

  if (frame.type === 'AgentThinking') {
    return {
      thinking: content.thinking || {
        text: content.text || '',
        status: 'streaming',
      },
    };
  }

  if (frame.type === 'AgentMessageDelta') {
    return {
      ...content,
      status: content.status || 'streaming',
    };
  }

  return content;
}

function mergeContent(previous, patch) {
  let output = { ...previous };

  for (let [key, value] of Object.entries(patch || {})) {
    if (isPlainObject(value) && isPlainObject(output[key]))
      output[key] = mergeContent(output[key], value);
    else
      output[key] = value;
  }

  return output;
}

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeFrameBatch(input) {
  if (!input || typeof input !== 'object')
    return [];

  if (input instanceof Map)
    return Array.from(input.entries())
      .filter(([sessionID, frames]) => typeof sessionID === 'string' && sessionID && Array.isArray(frames));

  return Object.entries(input)
    .filter(([sessionID, frames]) => typeof sessionID === 'string' && sessionID && Array.isArray(frames));
}

const LIVE_VISIBLE_PHANTOM_TYPES = new Set([
  'AgentThinking',
  'AgentMessageDelta',
]);

function sortFrames(frames) {
  return frames
    .map((frame, index) => ({ frame, index }))
    .sort((a, b) => {
      let order = compareFrameOrder(a.frame, b.frame);
      if (order !== 0)
        return order;

      return a.index - b.index;
    })
    .map((entry) => entry.frame);
}

function compareFrameOrder(a, b) {
  return compareNumber(liveSortWeight(a), liveSortWeight(b))
    || compareClock(visibleSortClock(a), visibleSortClock(b))
    || compareNumber(visibleSortTime(a), visibleSortTime(b))
    || compareNumber(a?.order, b?.order)
    || compareNumber(sortCommitOrder(a), sortCommitOrder(b))
    || String(a?.id || '').localeCompare(String(b?.id || ''));
}

function liveSortWeight(frame) {
  return frame?.type === 'BeginTyping' ? 1 : 0;
}

function sortCommitOrder(frame) {
  if (typeof frame?.commitOrder === 'number' && Number.isFinite(frame.commitOrder))
    return frame.commitOrder;

  if (typeof frame?.order === 'number' && Number.isFinite(frame.order))
    return frame.order;

  return Number.MAX_SAFE_INTEGER;
}

function visibleSortClock(frame) {
  if (isVisibleAgentResponseFrame(frame))
    return frame?.updatedClock || frame?.createdClock;

  return frame?.createdClock;
}

function visibleSortTime(frame) {
  if (isVisibleAgentResponseFrame(frame))
    return numberOr(frame?.updatedAt, frame?.createdAt);

  return frame?.createdAt;
}

function isVisibleAgentResponseFrame(frame) {
  if (frame?.type !== 'AgentMessage' || frame.hidden === true || frame.phantom === true)
    return false;

  let content = frame.content || {};
  return content.status === 'complete'
    || (typeof content.text === 'string' && content.text.trim() !== '');
}

function compareClock(a, b) {
  if (!a || !b)
    return 0;

  if (a && b && a !== b)
    return String(a).localeCompare(String(b));

  return 0;
}

function compareNumber(a, b) {
  let left = (typeof a === 'number' && Number.isFinite(a)) ? a : 0;
  let right = (typeof b === 'number' && Number.isFinite(b)) ? b : 0;
  return left - right;
}

function numberOr(value, fallback) {
  return (typeof value === 'number' && Number.isFinite(value)) ? value : fallback;
}

function stringOr(value, fallback = null) {
  return (typeof value === 'string' && value.trim() !== '') ? value : fallback;
}
