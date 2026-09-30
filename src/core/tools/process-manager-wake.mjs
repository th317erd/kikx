'use strict';

import { PROCESS_AUTHOR_ID } from './process-manager-constants.mjs';
import { createProcessID, normalizeOptionalString } from './process-manager-normalizers.mjs';
import { buildProcessWakePrompt } from './process-manager-prompts.mjs';

function setWake(manager, record, params = {}, context = {}, continuationPrompt = '') {
  record.wakeOnCompletion = {
    agentID: normalizeOptionalString(params._agentID || context.agent?.id || record.agentID),
    sessionID: normalizeOptionalString(params._sessionID || context.session?.id || record.sessionID),
    frameID: normalizeOptionalString(params._frameID || context.frame?.id || record.frameID),
    continuationPrompt: normalizeOptionalString(continuationPrompt)
      || `Process ${record.processID} has completed. Inspect its status and output, then continue the task.`,
    requestedAt: manager.clock(),
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

  let frameRuntime = resolveFrameRuntime(manager);
  let wake = record.wakeOnCompletion;
  if (!frameRuntime?.ensureSessionEntry || !wake?.sessionID || !wake?.agentID) {
    record.wakeError = 'process wake requires frameRuntime, sessionID, and agentID';
    return null;
  }

  try {
    let entry = await frameRuntime.ensureSessionEntry(wake.sessionID);
    let now = Number(frameRuntime.clock?.() || Date.now());
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
        completionToolOutputID: record.completionToolOutputID,
        continuationPrompt: wake.continuationPrompt,
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
    await frameRuntime.processScheduledFrames?.();
    return record.wakeFrameID;
  } catch (error) {
    record.wakeError = error.message || String(error);
    manager.logger?.error?.('Failed to schedule process completion wake', error);
    return null;
  }
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
