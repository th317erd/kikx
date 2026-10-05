'use strict';

import { PROCESS_AUTHOR_ID } from './process-manager-constants.mjs';
import { createProcessID, normalizeOptionalString } from './process-manager-normalizers.mjs';
import { buildProcessWakePrompt } from './process-manager-prompts.mjs';
import {
  createAutonomousPauseFrame,
  exceedsChainLimit,
  nextChainDepth,
} from '../runtime/autonomous-chain.mjs';

// Depth of the frame that caused this wake. The first wake scheduled from a
// user-triggered frame has depth 1; each subsequent autonomous hop increments.
function resolveTriggerDepth(context = {}) {
  return Number(context.frame?.continuationDepth) || 0;
}

function setWake(manager, record, params = {}, context = {}, continuationPrompt = '') {
  record.wakeOnCompletion = {
    agentID: normalizeOptionalString(params._agentID || context.agent?.id || record.agentID),
    sessionID: normalizeOptionalString(params._sessionID || context.session?.id || record.sessionID),
    frameID: normalizeOptionalString(params._frameID || context.frame?.id || record.frameID),
    continuationPrompt: normalizeOptionalString(continuationPrompt)
      || `Process ${record.processID} has completed. Inspect its status and output, then continue the task.`,
    requestedAt: manager.clock(),
    triggerDepth: resolveTriggerDepth(context),
  };
  return record.wakeOnCompletion;
}

async function wakeOnCompletion(manager, params = {}, context = {}) {
  let record = manager.requireProcess(params.processID || params.id, params._agentID || context.agent?.id);
  let continuationPrompt = normalizeOptionalString(params.continuationPrompt || params.prompt)
    || `Process ${record.processID} has completed. Inspect its status and output, then continue the task.`;
  setWake(manager, record, params, context, continuationPrompt);

  if (record.status !== 'running')
    await scheduleWake(manager, record);

  return {
    processID: record.processID,
    status: record.status,
    wakeOnCompletion: true,
    wakeFrameID: record.wakeFrameID,
    continuationPrompt,
    message: record.status === 'running'
      ? `Kikx will wake this agent when process ${record.processID} completes.`
      : `Process ${record.processID} is already ${record.status}; wake has been scheduled if runtime context is available.`,
  };
}

async function scheduleWake(manager, record) {
  if (record.wakeFrameID)
    return record.wakeFrameID;

  // Single-shot per completion: if a wake already fired for this exact
  // completion output, a duplicate completion must schedule nothing.
  if (record.completionToolOutputID && record.wakeCompletionOutputID === record.completionToolOutputID)
    return record.wakeFrameID || null;

  let frameRuntime = resolveFrameRuntime(manager);
  let wake = record.wakeOnCompletion;
  if (!frameRuntime?.ensureSessionEntry || !wake?.sessionID || !wake?.agentID) {
    record.wakeError = 'process wake requires frameRuntime, sessionID, and agentID';
    await manager.persist?.(record);
    return null;
  }

  let depth = nextChainDepth({ continuationDepth: wake.triggerDepth });

  try {
    let entry = await frameRuntime.ensureSessionEntry(wake.sessionID);
    let now = Number(frameRuntime.clock?.() || Date.now());

    if (exceedsChainLimit(depth)) {
      await postPauseNotice(frameRuntime, entry, wake, now);
      record.wakePausedAt = now;
      record.wakeCompletionOutputID = record.completionToolOutputID || null;
      await manager.persist?.(record);
      return null;
    }

    let frameID = frameRuntime.idGenerator?.() || createProcessID();
    let frame = {
      id: frameID,
      type: 'UserMessage',
      sessionID: wake.sessionID,
      interactionID: `process:${record.processID}`,
      parentID: wake.frameID || record.frameID || null,
      authorType: 'system',
      authorID: PROCESS_AUTHOR_ID,
      targetAgentID: wake.agentID,
      continuationDepth: depth,
      timestamp: now,
      createdAt: now,
      updatedAt: now,
      scheduledAt: now,
      scheduledStatus: 'pending',
      hidden: true,
      deleted: false,
      continuation: {
        kind: 'exec-wake-on-completion',
        processID: record.processID,
        processStatus: record.status,
        completionToolOutputID: record.completionToolOutputID,
        continuationPrompt: wake.continuationPrompt,
        continuationDepth: depth,
        createdAt: now,
      },
      content: {
        text: buildProcessWakePrompt(record, wake),
        status: 'scheduled',
        processID: record.processID,
        processStatus: record.status,
        completionToolOutputID: record.completionToolOutputID,
        retrieval: record.completionRetrieval,
        continuationPrompt: wake.continuationPrompt,
      },
    };

    let merged = entry.frameEngine.merge([ frame ], {
      authorType: 'system',
      authorID: PROCESS_AUTHOR_ID,
    });
    await frameRuntime.frameStore?.flush?.();
    record.wakeFrameID = merged[0]?.id || frameID;
    record.wakeCompletionOutputID = record.completionToolOutputID || null;
    await manager.persist?.(record);
    await frameRuntime.processScheduledFrames?.();
    return record.wakeFrameID;
  } catch (error) {
    record.wakeError = error.message || String(error);
    await manager.persist?.(record);
    manager.logger?.error?.('Failed to schedule process completion wake', error);
    return null;
  }
}

async function postPauseNotice(frameRuntime, entry, wake, now) {
  let frame = createAutonomousPauseFrame({
    id: frameRuntime.idGenerator?.() || createProcessID(),
    sessionID: wake.sessionID,
    parentID: wake.frameID || null,
    now,
  });

  try {
    entry.frameEngine.merge([ frame ], {
      authorType: 'system',
      authorID: 'internal:autonomous-chain',
      silent: true,
    });
    await frameRuntime.frameStore?.flush?.();
  } catch (_error) {}
}

function resolveFrameRuntime(manager) {
  if (manager.frameRuntime)
    return manager.frameRuntime;

  let context = manager.context;
  if (context?.has?.('frameRuntime') && typeof context.require === 'function')
    return context.require('frameRuntime');

  if (typeof context?.require === 'function') {
    try {
      return context.require('frameRuntime');
    } catch (_error) {}
  }

  return null;
}

export {
  resolveFrameRuntime,
  scheduleWake,
  setWake,
  wakeOnCompletion,
};
