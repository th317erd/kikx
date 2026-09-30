'use strict';

import { normalizeOptionalString } from './frame-runtime-normalize.mjs';

export function collectToolResultIDs(frames) {
  let ids = new Set();
  for (let frame of frames) {
    let toolCallID = normalizeOptionalString(frame?.content?.toolCallID);
    if (!toolCallID)
      continue;

    if (frame?.content?.phase === 'result' || frame?.authorType === 'tool')
      ids.add(toolCallID);
  }

  return ids;
}

export function isStaleAgentResponseFrame(frame) {
  return frame?.type === 'AgentMessage'
    && frame.hidden === true
    && frame.deleted !== true
    && frame.content?.status === 'streaming';
}

export function isStaleToolCallFrame(frame, toolResultIDs) {
  if (!frame?.type || !frame.type.endsWith('ToolFrame'))
    return false;

  let content = frame.content || {};
  let toolCallID = normalizeOptionalString(content.toolCallID);
  return content.phase === 'call'
    && (content.status === 'running' || frame.state?.status === 'running')
    && (!toolCallID || !toolResultIDs.has(toolCallID));
}

export function createRecoveredAgentResponseFrame(frame, options = {}) {
  let now = options.clock?.() || Date.now();
  let text = options.message
    || 'Kikx recovered this agent response after a server restart or interrupted provider stream. The original response did not complete.';
  return {
    ...frame,
    hidden: false,
    deleted: false,
    updatedAt: now,
    content: {
      ...(frame.content || {}),
      text,
      status: 'error',
      error: {
        message: text,
        recovered: true,
        previousStatus: frame.content?.status || null,
      },
      thinking: {
        ...(frame.content?.thinking || {}),
        status: 'error',
      },
    },
    state: {
      ...(frame.state || {}),
      status: 'error',
      recovered: true,
    },
  };
}

export function createRecoveredToolCallFrame(frame, options = {}) {
  let now = options.clock?.() || Date.now();
  let text = options.message
    || 'Kikx recovered this tool call after a server restart. The managed process/result state was no longer available.';
  return {
    ...frame,
    hidden: frame.hidden ?? false,
    deleted: false,
    updatedAt: now,
    content: {
      ...(frame.content || {}),
      status: 'failed',
      recovered: true,
      message: text,
      error: {
        message: text,
        recovered: true,
      },
      finishedAt: now,
    },
    state: {
      ...(frame.state || {}),
      status: 'failed',
      recovered: true,
    },
  };
}
