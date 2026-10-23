'use strict';

import { collectToolResultIDs } from '../runtime/frame-runtime-recovery.mjs';

const DEFAULT_SESSION_LIMIT = 500;
const RESUME_INPUT_TRUNCATED_MESSAGE = 'Kikx could not resume this tool call because its stored input was truncated. Please reissue it with the full input.';
const RESUMED_WAKE_AUTHOR = 'internal:pending-tool-recovery';

export async function processPendingToolCalls({
  frameRuntime,
  toolExecutor,
  pluginRegistry,
  agentManager,
  services = {},
  logger = console,
  sessionLimit = DEFAULT_SESSION_LIMIT,
} = {}) {
  if (!frameRuntime?.listSessions || !frameRuntime?.ensureSessionEntry || !toolExecutor?.executeTool)
    return { processed: 0, failed: 0, reconciled: 0, skipped: true };

  let sessions = await frameRuntime.listSessions({ limit: sessionLimit, offset: 0 });
  let totals = { processed: 0, failed: 0, reconciled: 0, wakes: 0, sessions: 0, skipped: false };

  for (let session of sessions) {
    if (!session?.id)
      continue;

    let entry = await frameRuntime.ensureSessionEntry(session.id);
    let frames = entry.frameEngine.toArray();
    let resultIDs = collectToolResultIDs(frames);
    let resultFrames = new Map();
    for (let frame of frames) {
      let toolCallID = normalizeString(frame.content?.toolCallID);
      if (toolCallID && isToolResultFrame(frame))
        resultFrames.set(toolCallID, frame);
    }

    let callFrames = frames.filter(isToolCallFrame);
    let outcomes = [];

    for (let frame of callFrames) {
      let toolCallID = normalizeString(frame.content?.toolCallID);
      let resultFrame = toolCallID ? resultFrames.get(toolCallID) : null;

      // A result landed but the call frame did not get its finish stamp (crash
      // between result commit and call update). Reconcile before deciding.
      if (resultFrame && frame.finishedProcessingAt == null) {
        await reconcileFinishedCall(frameRuntime, entry, frame, resultFrame);
        totals.reconciled++;
        continue;
      }

      if (resultFrame || resultIDs.has(toolCallID))
        continue;

      // Only frames that never started are resumed. A started-but-unfinished
      // call was interrupted mid-flight and is handled as a failure by runtime
      // recovery, never replayed.
      if (frame.startedProcessingAt != null || frame.finishedProcessingAt != null)
        continue;

      let outcome = await resumeToolCall({
        frame,
        session: entry.session,
        frameRuntime,
        toolExecutor,
        pluginRegistry,
        agentManager,
        services,
        logger,
      });
      if (outcome) {
        outcomes.push(outcome);
        if (outcome.status === 'success')
          totals.processed++;
        else
          totals.failed++;
      }
    }

    if (outcomes.length > 0) {
      let woke = await scheduleResumeWake(frameRuntime, entry, outcomes);
      if (woke)
        totals.wakes++;
    }

    if (outcomes.length > 0 || totals.reconciled > 0)
      totals.sessions++;
  }

  return totals;
}

async function resumeToolCall({
  frame,
  session,
  frameRuntime,
  toolExecutor,
  pluginRegistry,
  agentManager,
  services,
  logger,
}) {
  let toolName = normalizeString(frame.content?.toolName);
  if (!toolName)
    return null;

  let context = await createResumeContext({ frame, session, frameRuntime, agentManager, services });
  let ToolClass = pluginRegistry?.getTool?.(toolName) || null;

  if (frame.content?.input?.truncated === true) {
    await toolExecutor.failInterruptedToolCalls([ {
      frame,
      toolName,
      ToolClass,
      input: frame.content.input,
      context,
    } ], { message: RESUME_INPUT_TRUNCATED_MESSAGE });
    return { frameID: frame.id, toolName, agentID: frame.authorID, interactionID: frame.interactionID, status: 'failed', text: RESUME_INPUT_TRUNCATED_MESSAGE };
  }

  if (!ToolClass) {
    let message = `Kikx could not resume ${toolName}: the tool is no longer registered.`;
    await toolExecutor.failInterruptedToolCalls([ { frame, toolName, ToolClass, input: frame.content?.input || {}, context } ], { message });
    return { frameID: frame.id, toolName, agentID: frame.authorID, interactionID: frame.interactionID, status: 'failed', text: message };
  }

  try {
    let result = await toolExecutor.executeTool({
      toolName,
      ToolClass,
      input: frame.content?.input || {},
      context,
      existingToolCallFrame: frame,
    });
    return {
      frameID: frame.id,
      toolName,
      agentID: frame.authorID,
      interactionID: frame.interactionID,
      status: 'success',
      text: previewResult(result),
    };
  } catch (error) {
    logger?.warn?.(`Kikx could not resume pending tool ${toolName}`, error);
    return {
      frameID: frame.id,
      toolName,
      agentID: frame.authorID,
      interactionID: frame.interactionID,
      status: 'failed',
      text: error?.message || String(error),
    };
  }
}

async function createResumeContext({ frame, session, frameRuntime, agentManager, services }) {
  let agent = null;
  if (frame.authorID) {
    try {
      agent = await agentManager?.getAgent?.(frame.authorID, { includeSecrets: true }) || null;
    } catch (_error) {
      agent = null;
    }
  }

  let contextServices = {
    ...services,
    context: services?.context || null,
    frameRuntime,
    clock: services?.clock || frameRuntime.clock,
  };

  return {
    agent,
    session,
    frame: {
      id: frame.parentID || frame.id,
      sessionID: frame.sessionID,
      interactionID: frame.interactionID || null,
    },
    responseFrameID: frame.parentID || null,
    services: contextServices,
  };
}

async function reconcileFinishedCall(frameRuntime, entry, frame, resultFrame) {
  let completedAt = resultFrame.updatedAt || resultFrame.createdAt || Date.now();
  entry.frameEngine.merge([ {
    ...frame,
    startedProcessingAt: frame.startedProcessingAt ?? completedAt,
    finishedProcessingAt: completedAt,
  } ], {
    authorType: 'tool',
    authorID: frame.authorID || 'tool',
    silent: true,
  });
  await frameRuntime.frameStore?.flush?.();
}

async function scheduleResumeWake(frameRuntime, entry, outcomes) {
  let frameID = frameRuntime.idGenerator?.();
  if (!frameID)
    return false;

  let now = Number(frameRuntime.clock?.() || Date.now());
  let text = [
    'Kikx resumed pending tool call(s) after a restart.',
    ...outcomes.map((outcome) => `- ${outcome.toolName}: ${outcome.status}${outcome.text ? ` — ${outcome.text}` : ''}`),
    'Continue the task from the current state. Do not repeat calls that already completed.',
  ].join('\n');

  let wake = {
    id: frameID,
    type: 'UserMessage',
    sessionID: entry.session.id,
    interactionID: outcomes[0]?.interactionID || entry.session.id,
    parentID: outcomes[0]?.frameID || null,
    authorType: 'system',
    authorID: RESUMED_WAKE_AUTHOR,
    targetAgentID: resolveWakeAgentID(outcomes),
    timestamp: now,
    createdAt: now,
    updatedAt: now,
    scheduledAt: now,
    scheduledStatus: 'pending',
    hidden: true,
    deleted: false,
    content: {
      text,
      status: 'scheduled',
      reason: 'pending-tool-recovery',
    },
  };

  if (!wake.targetAgentID)
    return false;

  let merged = entry.frameEngine.merge([ wake ], {
    authorType: 'system',
    authorID: RESUMED_WAKE_AUTHOR,
    silent: true,
  });
  frameRuntime.scheduledFrames?.trackFrames?.(merged.length > 0 ? merged : [ wake ]);
  await frameRuntime.frameStore?.flush?.();
  return true;
}

function resolveWakeAgentID(outcomes) {
  for (let outcome of outcomes) {
    if (outcome.agentID)
      return outcome.agentID;
  }
  return null;
}

function isToolCallFrame(frame) {
  return /ToolFrame$/.test(String(frame?.type || ''))
    && frame?.content?.phase === 'call'
    || frame?.type === 'ToolCall';
}

function isToolResultFrame(frame) {
  return /ToolFrame$/.test(String(frame?.type || ''))
    && frame?.content?.phase === 'result'
    || frame?.type === 'ToolResult';
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function previewResult(result) {
  if (result == null)
    return '';
  if (typeof result === 'string')
    return result.slice(0, 240);
  try {
    return JSON.stringify(result).slice(0, 240);
  } catch (_error) {
    return String(result).slice(0, 240);
  }
}
