'use strict';

import { normalizeOptionalString } from './process-manager-normalizers.mjs';

// Durable persistence + boot recovery for ProcessManager. Kept out of
// process-manager.mjs to respect the file-size budget; every function takes the
// manager as its first argument.
export async function persist(manager, record) {
  if (!manager.processStore || !record)
    return null;

  try {
    return await manager.processStore.saveRecord(record);
  } catch (error) {
    manager.logger?.error?.('Failed to persist async process record', error);
    return null;
  }
}

// Rehydrate durable process records at boot. A record whose process was still
// `running` when the server stopped is marked `interrupted` (its child is gone)
// and its completion output is stored, so a reloaded wake resolves against an
// honest status instead of "Unknown process".
export async function rehydrate(manager, options = {}) {
  if (!manager.processStore)
    return { records: [], interrupted: 0, skipped: true };

  let persisted = await manager.processStore.listRecords(options);
  let records = [];
  let interrupted = 0;
  let now = manager.clock();

  for (let stored of persisted) {
    let record = createRecordFromPersisted(stored);
    if (!record)
      continue;

    await restoreStdio(manager, record);

    if (record.status === 'running') {
      record.status = 'interrupted';
      record.interruptedAt = now;
      record.updatedAt = now;
      record.completedAt ||= now;
      record.error ||= 'Process was interrupted by a server restart; its child is no longer managed.';
      interrupted++;
      await manager.storeCompletionOutput(record);
      await persist(manager, record);
    }

    manager.processes.set(record.processID, record);
    records.push(record);
  }

  return { records, interrupted, skipped: false };
}

// Recover completed records whose wake was persisted but never landed (the
// scheduling step was interrupted). A record that already has a wake frame, an
// already-pending wake in the queue, or whose completion was already consumed is
// left alone.
export async function recoverPendingWakes(manager, options = {}) {
  if (!manager.processStore)
    return { recovered: 0, skipped: true };

  let pendingProcessIDs = pendingWakeProcessIDs(options.frameRuntime);
  let recovered = 0;
  for (let record of manager.processes.values()) {
    if (record.status === 'running' || record.wakeFrameID)
      continue;

    let wake = record.wakeOnCompletion;
    if (!wake?.sessionID || !wake?.agentID)
      continue;

    if (record.completionToolOutputID && record.wakeCompletionOutputID === record.completionToolOutputID)
      continue;

    if (pendingProcessIDs.has(record.processID))
      continue;

    let frameID = await manager.scheduleWake(record);
    if (frameID)
      recovered++;
  }

  return { recovered, skipped: false };
}

function pendingWakeProcessIDs(frameRuntime) {
  let ids = new Set();
  let entries = frameRuntime?.scheduledFrames?.entries;
  if (!entries || typeof entries.values !== 'function')
    return ids;

  for (let entry of entries.values()) {
    let processID = entry?.frame?.continuation?.processID;
    if (processID)
      ids.add(processID);
  }

  return ids;
}

export async function restoreStdio(manager, record) {
  if (!manager.processStore || typeof manager.processStore.readStdio !== 'function')
    return;

  try {
    let stdio = await manager.processStore.readStdio(record);
    if (stdio) {
      record.durableStdout = stdio.stdout;
      record.durableStderr = stdio.stderr;
    }
  } catch (error) {
    manager.logger?.error?.('Failed to read durable process stdio', error);
  }
}

export function createRecordFromPersisted(stored = {}) {
  let processID = normalizeOptionalString(stored.processID || stored.id);
  if (!processID)
    return null;

  return {
    id: stored.id || processID,
    processID,
    agentID: normalizeOptionalString(stored.agentID),
    sessionID: normalizeOptionalString(stored.sessionID),
    frameID: normalizeOptionalString(stored.frameID),
    command: stored.command ?? '',
    shell: stored.shell ?? null,
    cwd: stored.cwd ?? null,
    pid: stored.pid ?? null,
    status: normalizeOptionalString(stored.status) || 'unknown',
    exitCode: stored.exitCode ?? null,
    signal: stored.signal ?? null,
    timedOut: stored.timedOut === true,
    timeoutMs: stored.timeoutMs ?? null,
    startedAt: stored.startedAt ?? null,
    startedAtMs: stored.startedAtMs ?? null,
    updatedAt: stored.updatedAt ?? null,
    completedAt: stored.completedAt ?? null,
    durationMs: stored.durationMs ?? null,
    interruptedAt: stored.interruptedAt ?? null,
    stdoutPath: stored.stdoutPath ?? null,
    stderrPath: stored.stderrPath ?? null,
    stdoutBytes: Number(stored.stdoutBytes) || 0,
    stderrBytes: Number(stored.stderrBytes) || 0,
    stdioClosedByManager: stored.stdioClosedByManager === true,
    stdioCloseGraceMs: stored.stdioCloseGraceMs ?? null,
    completionToolOutputID: stored.completionToolOutputID ?? null,
    completionSizeBytes: stored.completionSizeBytes ?? null,
    completionRetrieval: stored.completionRetrieval ?? null,
    completionInlineLimitBytes: stored.completionInlineLimitBytes ?? null,
    completionLarge: stored.completionLarge === true,
    completionStoreError: stored.completionStoreError ?? null,
    killRequested: stored.killRequested ?? null,
    wakeOnCompletion: stored.wakeOnCompletion ?? null,
    wakeFrameID: stored.wakeFrameID ?? null,
    wakeCompletionOutputID: stored.wakeCompletionOutputID ?? null,
    wakeError: stored.wakeError ?? null,
    wakePausedAt: stored.wakePausedAt ?? null,
    error: stored.error ?? null,
    rehydrated: true,
    handle: null,
    completionPromise: null,
    _completionStarted: true,
    _resolveCompletion: null,
  };
}
