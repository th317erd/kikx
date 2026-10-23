'use strict';

import {
  DEFAULT_GREP_MATCH_LIMIT,
  DEFAULT_PROCESS_READ_BYTES,
} from './process-manager-constants.mjs';
import {
  clampInteger,
  isLiveProcessStatus,
  isVisibleToAgent,
  normalizeOptionalString,
  normalizeReadRange,
  normalizeRegexFlags,
  normalizeRequiredString,
  normalizeSignal,
  normalizeStatusFilter,
  normalizeStreamName,
} from './process-manager-normalizers.mjs';
import {
  grepText,
  readCombined,
  readStreamRange,
} from './process-manager-reading.mjs';
import { publicRecord } from './process-manager-results.mjs';

function listProcesses(manager, params = {}) {
  let agentID = normalizeOptionalString(params._agentID);
  let statuses = normalizeStatusFilter(params.status || params.statuses);
  let includeCompleted = params.includeCompleted !== false;
  let limit = clampInteger(params.limit, 50, 1, 500);
  let offset = clampInteger(params.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  let records = [];

  let sessionID = normalizeOptionalString(params._sessionID);
  for (let record of manager.processes.values()) {
    if (sessionID && record.sessionID !== sessionID)
      continue;

    if (!isVisibleToAgent(record, agentID, params._isCoordinator === true))
      continue;

    if (!includeCompleted && !isLiveProcessStatus(record.status))
      continue;

    if (statuses.length > 0 && !statuses.includes(record.status))
      continue;

    records.push(publicRecord(record));
  }

  records.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)) || a.processID.localeCompare(b.processID));
  return {
    processes: records.slice(offset, offset + limit),
    total: records.length,
    limit,
    offset,
  };
}

function statusProcess(manager, params = {}) {
  let record = manager.requireProcess(params.processID || params.id, params._agentID, params._isCoordinator === true, params._sessionID);
  return publicRecord(record, { includeInstructions: true });
}

async function readProcess(manager, params = {}) {
  let record = manager.requireProcess(params.processID || params.id, params._agentID, params._isCoordinator === true, params._sessionID);
  let stream = normalizeStreamName(params.stream || 'combined');
  let full = params.full === true;
  let range = normalizeReadRange({
    start: params.start,
    end: params.end,
    maxBytes: full ? null : params.maxBytes ?? DEFAULT_PROCESS_READ_BYTES,
  });
  let content = stream === 'combined'
    ? await readCombined(record, range)
    : await readStreamRange(record, stream, range);
  let sizeBytes = stream === 'combined'
    ? record.stdoutBytes + record.stderrBytes + (record.stderrBytes > 0 ? Buffer.byteLength('\n--- stderr ---\n') : 0)
    : record[`${stream}Bytes`];
  let returnedBytes = Buffer.byteLength(content);

  return {
    processID: record.processID,
    status: record.status,
    stream,
    start: range.start,
    end: range.hasEnd ? range.end : range.start + returnedBytes,
    returnedBytes,
    sizeBytes,
    truncated: range.hasEnd ? range.end < sizeBytes : returnedBytes < sizeBytes - range.start,
    content,
    completionToolOutputID: record.completionToolOutputID,
    retrieval: record.completionRetrieval,
  };
}

async function grepProcess(manager, params = {}) {
  let record = manager.requireProcess(params.processID || params.id, params._agentID, params._isCoordinator === true, params._sessionID);
  let stream = normalizeStreamName(params.stream || 'combined');
  let pattern = normalizeRequiredString(params.pattern || params.regexp || params.regex, 'pattern');
  let flags = normalizeRegexFlags(params.flags);
  let maxMatches = clampInteger(params.maxMatches ?? params.limit, DEFAULT_GREP_MATCH_LIMIT, 1, 500);
  let content = stream === 'combined'
    ? await readCombined(record, { start: 0, end: null, hasEnd: false, maxBytes: null })
    : await readStreamRange(record, stream, { start: 0, end: null, hasEnd: false, maxBytes: null });
  let matches = grepText(content, pattern, flags, maxMatches);

  return {
    processID: record.processID,
    status: record.status,
    stream,
    pattern,
    flags,
    matches,
    matchCount: matches.length,
    truncated: matches.length >= maxMatches,
    completionToolOutputID: record.completionToolOutputID,
  };
}

function killProcess(manager, params = {}) {
  let record = manager.requireProcess(params.processID || params.id, params._agentID, params._isCoordinator === true, params._sessionID);
  let signal = normalizeSignal(params.signal || 'SIGTERM');
  if (!isLiveProcessStatus(record.status)) {
    return {
      processID: record.processID,
      status: record.status,
      message: `Process ${record.processID} is not running.`,
    };
  }

  record.killRequested = {
    signal,
    requestedAt: manager.clock(),
    agentID: normalizeOptionalString(params._agentID),
  };
  record.updatedAt = record.killRequested.requestedAt;
  if (record.status === 'suspended' && signal !== 'SIGKILL')
    record.handle.kill('SIGCONT');
  record.handle.kill(signal);

  return {
    processID: record.processID,
    status: record.status,
    signal,
    message: `Sent ${signal} to process ${record.processID}.`,
  };
}

async function suspendProcess(manager, params = {}) {
  let record = manager.requireProcess(
    params.processID || params.id,
    params._agentID,
    params._isCoordinator,
    params._sessionID,
  );
  if (record.status === 'suspended')
    return { processID: record.processID, status: record.status, message: `Process ${record.processID} is already suspended.` };
  if (record.status !== 'running')
    return { processID: record.processID, status: record.status, message: `Process ${record.processID} is not running.` };

  if (process.platform === 'win32') {
    record.handle.kill('SIGTERM');
    setTimeout(() => record.handle.kill('SIGKILL'), 1000).unref?.();
    record.status = 'terminating';
    record.suspensionAborted = true;
    record.updatedAt = manager.clock();
    await manager.persist?.(record);
    return { processID: record.processID, status: record.status, aborted: true, message: `Terminating process ${record.processID} (Windows cannot suspend).` };
  }

  record.handle.kill('SIGSTOP');
  record.status = 'suspended';
  record.suspendedAt = manager.clock();
  record.updatedAt = record.suspendedAt;
  await manager.persist?.(record);
  return { processID: record.processID, status: record.status, message: `Suspended process ${record.processID}.` };
}

async function resumeProcess(manager, params = {}) {
  let record = manager.requireProcess(
    params.processID || params.id,
    params._agentID,
    params._isCoordinator,
    params._sessionID,
  );
  if (record.status !== 'suspended')
    return { processID: record.processID, status: record.status, message: `Process ${record.processID} is not suspended.` };

  record.handle.kill('SIGCONT');
  record.status = 'running';
  record.resumedAt = manager.clock();
  record.updatedAt = record.resumedAt;
  await manager.persist?.(record);
  return { processID: record.processID, status: record.status, message: `Resumed process ${record.processID}.` };
}

async function suspendSessionProcesses(manager, sessionID, options = {}) {
  let agentID = normalizeOptionalString(options.agentID);
  let suspended = [];
  for (let record of manager.processes.values()) {
    if (record.sessionID !== sessionID || record.status !== 'running')
      continue;
    if (agentID && record.agentID !== agentID)
      continue;

    if (process.platform === 'win32') {
      record.handle.kill('SIGTERM');
      setTimeout(() => record.handle.kill('SIGKILL'), 1000).unref?.();
      record.status = 'terminating';
      record.suspensionAborted = true;
    } else {
      record.handle.kill('SIGSTOP');
      record.status = 'suspended';
      record.suspendedAt = manager.clock();
    }
    record.updatedAt = manager.clock();
    suspended.push(record.processID);
    await manager.persist?.(record);
  }
  return suspended;
}

export {
  grepProcess,
  killProcess,
  listProcesses,
  readProcess,
  statusProcess,
  suspendProcess,
  resumeProcess,
  suspendSessionProcesses,
};
