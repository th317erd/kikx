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
    && frame.startedProcessingAt != null
    && frame.finishedProcessingAt == null
    && (!toolCallID || !toolResultIDs.has(toolCallID));
}

export function createRecoveredToolCallWakeFrame({ id, frame, frames = [], clock, message } = {}) {
  let now = clock?.() || Date.now();
  let toolFrames = Array.isArray(frames) && frames.length > 0 ? frames : [ frame ];
  let commands = [];
  let seen = new Set();
  for (let toolFrame of toolFrames) {
    let command = normalizeOptionalString(toolFrame?.content?.input?.command);
    if (!command || seen.has(command))
      continue;

    seen.add(command);
    commands.push(command);
  }

  let text = message || [
    'Kikx restarted while a command was still running. The managed process and its result were lost, so treat the command as failed; do not assume it succeeded.',
    ...(commands.length > 0
      ? [ `Command${commands.length === 1 ? '' : 's'}:\n${commands.slice(0, 5).map((command) => `- ${truncateCommand(command, 1200)}`).join('\n')}` ]
      : []),
    'Inspect the current state and continue the task.',
  ].join('\n\n');
  let agentID = normalizeOptionalString(toolFrames[0]?.authorID);
  let source = toolFrames[0] || frame || {};

  return {
    id,
    type: 'UserMessage',
    sessionID: source.sessionID || frame?.sessionID || '',
    interactionID: source.interactionID || frame?.interactionID || `recovery:${now}`,
    parentID: source.id || frame?.id || null,
    authorType: 'system',
    authorID: 'internal:runtime-recovery',
    authorDisplayName: 'Kikx recovery',
    targetAgentID: agentID || null,
    timestamp: now,
    createdAt: now,
    updatedAt: now,
    scheduledAt: now,
    scheduledStatus: 'pending',
    hidden: true,
    deleted: false,
    continuation: {
      kind: 'server-restart-recovery',
      toolCallIDs: toolFrames.map((toolFrame) => toolFrame?.content?.toolCallID).filter(Boolean),
      createdAt: now,
    },
    content: {
      text,
      status: 'scheduled',
      reason: 'server-restart',
      toolCallIDs: toolFrames.map((toolFrame) => toolFrame?.content?.toolCallID).filter(Boolean),
    },
  };
}

function truncateCommand(command, limit) {
  let text = String(command || '');
  return text.length <= limit ? text : `${text.slice(0, limit)}\n…`;
}

export function createRecoveredAgentResponseFrame(frame, options = {}) {
  let now = options.clock?.() || Date.now();
  let text = options.message
    || 'Kikx recovered this agent response after a server restart or interrupted provider stream. The original response did not complete. The working tree may contain uncommitted changes from your interrupted turn; inspect the current state before repeating work.';
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
  let command = normalizeOptionalString(frame?.content?.input?.command);
  let text = options.message
    || [
      'Kikx recovered this tool call after a server restart. The managed process/result state was no longer available; treat the command as failed and continue.',
      ...(command ? [ `Command:\n${truncateCommand(command, 2000)}` ] : []),
    ].join('\n\n');
  return {
    ...frame,
    hidden: frame.hidden ?? false,
    deleted: false,
    updatedAt: now,
    startedProcessingAt: frame.startedProcessingAt ?? now,
    finishedProcessingAt: now,
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
