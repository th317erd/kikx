'use strict';

import { readWholeFile } from './process-manager-reading.mjs';

async function buildCompletionResult(record) {
  let stdout = await readWholeFile(record.stdoutPath);
  let stderr = await readWholeFile(record.stderrPath);
  return {
    processID: record.processID,
    agentID: record.agentID || null,
    sessionID: record.sessionID || null,
    frameID: record.frameID || null,
    command: record.command,
    shell: record.shell,
    cwd: record.cwd,
    pid: record.pid,
    status: record.status,
    exitCode: record.exitCode,
    signal: record.signal,
    timedOut: record.timedOut,
    timeoutMs: record.timeoutMs,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    durationMs: record.durationMs,
    stdout,
    stderr,
    stdoutBytes: Buffer.byteLength(stdout),
    stderrBytes: Buffer.byteLength(stderr),
    stdioClosedByManager: record.stdioClosedByManager,
    stdioCloseGraceMs: record.stdioCloseGraceMs,
    killRequested: record.killRequested,
    error: record.error || null,
  };
}

function createStartedResult(record) {
  return {
    ...publicRecord(record, { includeInstructions: true }),
    message: [
      `Async exec ID# ${record.processID} is currently running.`,
      record.wakeOnCompletion ? 'You will get the result automatically when it completes.' : '',
      `Poll progress with exec-status {"processID":"${record.processID}"}.`,
      `Read buffered output with exec-read {"processID":"${record.processID}","stream":"combined"}.`,
      `Search buffered output with exec-grep {"processID":"${record.processID}","pattern":"..."}.`,
      'Use continue-turn to report progress and schedule yourself to poll later.',
    ].filter(Boolean).join(' '),
  };
}

async function createCompletedExecResult(record) {
  let result = await buildCompletionResult(record);
  return {
    ...publicRecord(record, { includeInstructions: true }),
    completedWithinGrace: true,
    message: `Async exec ID# ${record.processID} completed quickly with status ${record.status}.`,
    result,
  };
}

function publicRecord(record, options = {}) {
  let output = {
    processID: record.processID,
    agentID: record.agentID || null,
    sessionID: record.sessionID || null,
    frameID: record.frameID || null,
    command: record.command,
    cwd: record.cwd,
    pid: record.pid,
    status: record.status,
    exitCode: record.exitCode,
    signal: record.signal,
    timedOut: record.timedOut,
    timeoutMs: record.timeoutMs,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    completedAt: record.completedAt,
    durationMs: record.durationMs,
    stdoutBytes: record.stdoutBytes,
    stderrBytes: record.stderrBytes,
    stdioClosedByManager: record.stdioClosedByManager,
    stdioCloseGraceMs: record.stdioCloseGraceMs,
    completionToolOutputID: record.completionToolOutputID,
    completionSizeBytes: record.completionSizeBytes,
    completionLarge: record.completionLarge,
    retrieval: record.completionRetrieval,
    wakeOnCompletion: Boolean(record.wakeOnCompletion),
    wakeFrameID: record.wakeFrameID,
    wakeError: record.wakeError,
    completionStoreError: record.completionStoreError,
  };

  if (options.includeInstructions) {
    output.tools = {
      status: { tool: 'exec-status', arguments: { processID: record.processID } },
      read: { tool: 'exec-read', arguments: { processID: record.processID, stream: 'combined' } },
      grep: { tool: 'exec-grep', arguments: { processID: record.processID, pattern: '<regexp>' } },
      kill: { tool: 'exec-kill', arguments: { processID: record.processID, signal: 'SIGTERM' } },
    };

    if (record.completionToolOutputID) {
      output.tools.outputRead = { tool: 'output-read', arguments: { id: record.completionToolOutputID } };
      output.tools.outputGrep = { tool: 'output-grep', arguments: { id: record.completionToolOutputID, pattern: '<regexp>' } };
    }
  }

  return output;
}

export {
  buildCompletionResult,
  createCompletedExecResult,
  createStartedResult,
  publicRecord,
};
