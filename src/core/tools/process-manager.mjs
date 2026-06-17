'use strict';

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { finished } from 'node:stream/promises';

const DEFAULT_TEMP_ROOT = path.join(os.tmpdir(), 'kikx-processes');
const PROCESS_AUTHOR_ID = 'internal:process-manager';
const DEFAULT_PROCESS_READ_BYTES = 128 * 1024;
const DEFAULT_GREP_MATCH_LIMIT = 50;
const DEFAULT_EXEC_GRACE_MS = 2500;
const DEFAULT_EXIT_STDIO_GRACE_MS = 250;

export class ProcessManager {
  constructor(options = {}) {
    let {
      commandExecutor,
      toolOutputStore,
      frameRuntime = null,
      context = null,
      tempRoot = DEFAULT_TEMP_ROOT,
      idGenerator = createProcessID,
      clock = () => new Date().toISOString(),
      defaultExecGraceMs = DEFAULT_EXEC_GRACE_MS,
      exitStdioGraceMs = DEFAULT_EXIT_STDIO_GRACE_MS,
      logger = console,
    } = options;

    if (!commandExecutor?.startProcess)
      throw new TypeError('ProcessManager requires a commandExecutor with startProcess()');

    if (!toolOutputStore?.storeToolOutput)
      throw new TypeError('ProcessManager requires a toolOutputStore');

    this.commandExecutor = commandExecutor;
    this.toolOutputStore = toolOutputStore;
    this.frameRuntime = frameRuntime;
    this.context = context;
    this.tempRoot = tempRoot;
    this.idGenerator = idGenerator;
    this.clock = clock;
    this.defaultExecGraceMs = normalizeNonNegativeInteger(defaultExecGraceMs, DEFAULT_EXEC_GRACE_MS);
    this.exitStdioGraceMs = normalizeNonNegativeInteger(exitStdioGraceMs, DEFAULT_EXIT_STDIO_GRACE_MS);
    this.logger = logger;
    this.processes = new Map();
  }

  async start(params = {}, context = {}, options = {}) {
    let processID = normalizeProcessID(this.idGenerator());
    let processDir = path.join(this.tempRoot, encodeSegment(processID));
    await fsp.mkdir(processDir, { recursive: true });

    let handle = this.commandExecutor.startProcess(params, {
      allowNoTimeout: true,
      defaultTimeoutMs: null,
    });
    let stdoutPath = path.join(processDir, 'stdout.txt');
    let stderrPath = path.join(processDir, 'stderr.txt');
    let stdoutStream = fs.createWriteStream(stdoutPath);
    let stderrStream = fs.createWriteStream(stderrPath);
    let now = this.clock();
    let agentID = normalizeOptionalString(params._agentID || context.agent?.id);
    let sessionID = normalizeOptionalString(params._sessionID || context.session?.id);
    let frameID = normalizeOptionalString(params._frameID || context.frame?.id);

    let record = {
      id: processID,
      processID,
      agentID,
      sessionID,
      frameID,
      command: handle.command,
      shell: handle.shell,
      cwd: handle.cwd,
      pid: handle.child.pid,
      status: 'running',
      exitCode: null,
      signal: null,
      timedOut: false,
      timeoutMs: handle.timeoutMs,
      startedAt: now,
      startedAtMs: handle.startedAt,
      updatedAt: now,
      completedAt: null,
      durationMs: null,
      stdoutPath,
      stderrPath,
      stdoutBytes: 0,
      stderrBytes: 0,
      stdioClosedByManager: false,
      stdioCloseGraceMs: this.exitStdioGraceMs,
      completionToolOutputID: null,
      completionSizeBytes: null,
      completionRetrieval: null,
      completionInlineLimitBytes: null,
      completionLarge: false,
      completionStoreError: null,
      killRequested: null,
      wakeOnCompletion: null,
      wakeFrameID: null,
      wakeError: null,
      handle,
      completionPromise: null,
      _completionStarted: false,
      _resolveCompletion: null,
    };
    record.completionPromise = new Promise((resolve) => {
      record._resolveCompletion = resolve;
    });

    this.processes.set(processID, record);

    handle.child.stdout.on('data', (chunk) => {
      record.stdoutBytes += Buffer.byteLength(chunk);
      record.updatedAt = this.clock();
    });
    handle.child.stderr.on('data', (chunk) => {
      record.stderrBytes += Buffer.byteLength(chunk);
      record.updatedAt = this.clock();
    });
    handle.child.stdout.pipe(stdoutStream);
    handle.child.stderr.pipe(stderrStream);

    handle.child.on('error', (error) => {
      this.beginCompletion(record, { error, stdoutStream, stderrStream });
    });
    handle.child.on('exit', (exitCode, signal) => {
      handle.clearTimeout?.();
      this.scheduleExitCompletion(record, {
        exitCode,
        signal,
        stdoutStream,
        stderrStream,
      });
    });
    handle.child.on('close', (exitCode, signal) => {
      this.beginCompletion(record, {
        exitCode,
        signal,
        stdoutStream,
        stderrStream,
      });
    });

    let graceMs = normalizeNonNegativeInteger(options.graceMs ?? this.defaultExecGraceMs, this.defaultExecGraceMs);
    if (graceMs > 0 && options.returnCompletionIfReady !== false) {
      let completed = await waitForCompletion(record.completionPromise, graceMs);
      if (completed)
        return await this.createCompletedExecResult(record);

      if (record.status !== 'running')
        return await this.createCompletedExecResult(record);
    }

    if (options.autoWake !== false) {
      this.setWake(record, params, context, buildDefaultWakePrompt(record));
      if (record.status !== 'running')
        await this.scheduleWake(record);
    }

    return this.createStartedResult(record);
  }

  list(params = {}) {
    let agentID = normalizeOptionalString(params._agentID);
    let statuses = normalizeStatusFilter(params.status || params.statuses);
    let includeCompleted = params.includeCompleted !== false;
    let limit = clampInteger(params.limit, 50, 1, 500);
    let offset = clampInteger(params.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    let records = [];

    for (let record of this.processes.values()) {
      if (!isVisibleToAgent(record, agentID))
        continue;

      if (!includeCompleted && record.status !== 'running')
        continue;

      if (statuses.length > 0 && !statuses.includes(record.status))
        continue;

      records.push(this.publicRecord(record));
    }

    records.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)) || a.processID.localeCompare(b.processID));
    return {
      processes: records.slice(offset, offset + limit),
      total: records.length,
      limit,
      offset,
    };
  }

  status(params = {}) {
    let record = this.requireProcess(params.processID || params.id, params._agentID);
    return this.publicRecord(record, { includeInstructions: true });
  }

  async read(params = {}) {
    let record = this.requireProcess(params.processID || params.id, params._agentID);
    let stream = normalizeStreamName(params.stream || 'combined');
    let full = params.full === true;
    let range = normalizeReadRange({
      start: params.start,
      end: params.end,
      maxBytes: full ? null : params.maxBytes ?? DEFAULT_PROCESS_READ_BYTES,
    });
    let content = stream === 'combined'
      ? await this.readCombined(record, range)
      : await readFileRange(record[`${stream}Path`], range);
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

  async grep(params = {}) {
    let record = this.requireProcess(params.processID || params.id, params._agentID);
    let stream = normalizeStreamName(params.stream || 'combined');
    let pattern = normalizeRequiredString(params.pattern || params.regexp || params.regex, 'pattern');
    let flags = normalizeRegexFlags(params.flags);
    let maxMatches = clampInteger(params.maxMatches ?? params.limit, DEFAULT_GREP_MATCH_LIMIT, 1, 500);
    let content = stream === 'combined'
      ? await this.readCombined(record, { start: 0, end: null, hasEnd: false, maxBytes: null })
      : await readWholeFile(record[`${stream}Path`]);
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

  kill(params = {}) {
    let record = this.requireProcess(params.processID || params.id, params._agentID);
    let signal = normalizeSignal(params.signal || 'SIGTERM');
    if (record.status !== 'running') {
      return {
        processID: record.processID,
        status: record.status,
        message: `Process ${record.processID} is not running.`,
      };
    }

    record.killRequested = {
      signal,
      requestedAt: this.clock(),
      agentID: normalizeOptionalString(params._agentID),
    };
    record.updatedAt = record.killRequested.requestedAt;
    record.handle.kill(signal);

    return {
      processID: record.processID,
      status: record.status,
      signal,
      message: `Sent ${signal} to process ${record.processID}.`,
    };
  }

  async wakeOnCompletion(params = {}, context = {}) {
    let record = this.requireProcess(params.processID || params.id, params._agentID || context.agent?.id);
    let continuationPrompt = normalizeOptionalString(params.continuationPrompt || params.prompt)
      || `Process ${record.processID} has completed. Inspect its status and output, then continue the task.`;
    this.setWake(record, params, context, continuationPrompt);

    if (record.status !== 'running')
      await this.scheduleWake(record);

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

  setWake(record, params = {}, context = {}, continuationPrompt = '') {
    record.wakeOnCompletion = {
      agentID: normalizeOptionalString(params._agentID || context.agent?.id || record.agentID),
      sessionID: normalizeOptionalString(params._sessionID || context.session?.id || record.sessionID),
      frameID: normalizeOptionalString(params._frameID || context.frame?.id || record.frameID),
      continuationPrompt: normalizeOptionalString(continuationPrompt)
        || `Process ${record.processID} has completed. Inspect its status and output, then continue the task.`,
      requestedAt: this.clock(),
    };
    return record.wakeOnCompletion;
  }

  beginCompletion(record, completionParams) {
    if (record._completionStarted)
      return;

    record._completionStarted = true;
    this.complete(record, completionParams)
      .then((completedRecord) => record._resolveCompletion?.(completedRecord))
      .catch((error) => {
        record.status = 'failed';
        record.error = error.message || String(error);
        record.completedAt = this.clock();
        record.updatedAt = record.completedAt;
        this.logger?.error?.('Failed to complete async process', error);
        record._resolveCompletion?.(record);
      });
  }

  scheduleExitCompletion(record, completionParams) {
    if (record._completionStarted)
      return;

    let timer = setTimeout(() => {
      if (record._completionStarted)
        return;

      forceCloseCaptureStreams(record, completionParams.stdoutStream, completionParams.stderrStream);
      this.beginCompletion(record, completionParams);
    }, this.exitStdioGraceMs);
    timer.unref?.();
  }

  async complete(record, { exitCode = null, signal = null, error = null, stdoutStream, stderrStream } = {}) {
    record.handle.clearTimeout?.();
    await Promise.allSettled([
      finished(stdoutStream),
      finished(stderrStream),
    ]);

    let now = this.clock();
    record.completedAt = now;
    record.updatedAt = now;
    record.durationMs = Date.now() - record.startedAtMs;
    record.exitCode = exitCode;
    record.signal = signal;
    record.timedOut = record.handle.timedOut === true;
    if (error) {
      record.status = 'failed';
      record.error = error.message || String(error);
    } else if (record.timedOut) {
      record.status = 'timed-out';
    } else if (record.killRequested) {
      record.status = 'killed';
    } else {
      record.status = 'completed';
    }

    await this.storeCompletionOutput(record);

    if (record.wakeOnCompletion)
      await this.scheduleWake(record);

    return record;
  }

  async storeCompletionOutput(record) {
    try {
      let result = await this.buildCompletionResult(record);
      let stored = await this.toolOutputStore.storeToolOutput({
        toolName: 'process-complete',
        input: {
          processID: record.processID,
          command: record.command,
        },
        result,
        context: {
          agent: record.agentID ? { id: record.agentID } : null,
          session: record.sessionID ? { id: record.sessionID } : null,
          frame: record.frameID ? { id: record.frameID } : null,
        },
      });
      record.completionToolOutputID = stored.id;
      record.completionSizeBytes = stored.sizeBytes;
      record.completionInlineLimitBytes = this.toolOutputStore.inlineLimitBytes || null;
      record.completionLarge = Boolean(record.completionInlineLimitBytes && stored.sizeBytes > record.completionInlineLimitBytes);
      record.completionRetrieval = this.toolOutputStore.createRetrievalInstructions?.(stored.id, stored.sizeBytes) || null;
    } catch (error) {
      record.completionStoreError = error.message || String(error);
      this.logger?.error?.('Failed to store async process completion output', error);
    }
  }

  async buildCompletionResult(record) {
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

  async scheduleWake(record) {
    if (record.wakeFrameID)
      return record.wakeFrameID;

    let frameRuntime = this.resolveFrameRuntime();
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
      this.logger?.error?.('Failed to schedule process completion wake', error);
      return null;
    }
  }

  resolveFrameRuntime() {
    if (this.frameRuntime)
      return this.frameRuntime;

    let context = this.context;
    if (context?.has?.('frameRuntime') && typeof context.require === 'function')
      return context.require('frameRuntime');

    if (typeof context?.require === 'function') {
      try {
        return context.require('frameRuntime');
      } catch (_error) {}
    }

    return null;
  }

  async readCombined(record, range) {
    let stdout = await readWholeFile(record.stdoutPath);
    let stderr = await readWholeFile(record.stderrPath);
    let combined = stderr ? `${stdout}\n--- stderr ---\n${stderr}` : stdout;
    return sliceTextByByteRange(combined, range);
  }

  requireProcess(processID, agentID) {
    let normalizedID = normalizeProcessID(processID);
    let record = this.processes.get(normalizedID);
    if (!record)
      throw new Error(`Unknown process: ${normalizedID}`);

    let normalizedAgentID = normalizeOptionalString(agentID);
    if (!isVisibleToAgent(record, normalizedAgentID))
      throw new Error(`Process ${normalizedID} is not owned by this agent`);

    return record;
  }

  createStartedResult(record) {
    return {
      ...this.publicRecord(record, { includeInstructions: true }),
      message: [
        `Async exec ID# ${record.processID} is currently running.`,
        record.wakeOnCompletion ? 'You will get the result automatically when it completes.' : '',
        `Poll progress with exec-status {"processID":"${record.processID}"}.`,
        `Read buffered output with exec-read {"processID":"${record.processID}","stream":"combined"}.`,
        `Search buffered output with exec-grep {"processID":"${record.processID}","pattern":"..."}.`,
        'Use agent-respond-and-continue to report progress and schedule yourself to poll later.',
      ].filter(Boolean).join(' '),
    };
  }

  async createCompletedExecResult(record) {
    let result = await this.buildCompletionResult(record);
    return {
      ...this.publicRecord(record, { includeInstructions: true }),
      completedWithinGrace: true,
      message: `Async exec ID# ${record.processID} completed quickly with status ${record.status}.`,
      result,
    };
  }

  publicRecord(record, options = {}) {
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
}

function buildProcessWakePrompt(record, wake) {
  let responseLine = record.completionLarge
    ? [
      `Async exec ID# ${record.processID} finished, but the completion response is large (${record.completionSizeBytes} bytes).`,
      record.completionToolOutputID
        ? `Use output-read with {"id":"${record.completionToolOutputID}","start":0,"end":<exclusive_byte_offset>} to fetch ranges of the persisted response.`
        : '',
      record.completionToolOutputID
        ? `Use output-grep with {"id":"${record.completionToolOutputID}","pattern":"<regexp>"} to search/filter it without reading everything.`
        : '',
    ].filter(Boolean).join(' ')
    : record.completionToolOutputID
      ? `The full completion result was stored in AeorDB as tool output ${record.completionToolOutputID}. Use output-read {"id":"${record.completionToolOutputID}"} to read it.`
      : 'The completion result could not be stored; inspect exec-status for the storage error.';

  return [
    `Async process ${record.processID} has completed with status ${record.status}.`,
    `Command: ${record.command}`,
    `Exit code: ${record.exitCode}; signal: ${record.signal}; durationMs: ${record.durationMs}.`,
    responseLine,
    wake.continuationPrompt,
  ].filter(Boolean).join('\n\n');
}

function buildDefaultWakePrompt(record) {
  return [
    `Async exec ID# ${record.processID} has completed.`,
    'Review the completion output, continue the user task if needed, and report the result when appropriate.',
  ].join(' ');
}

async function waitForCompletion(promise, timeoutMs) {
  let timeout;
  let timeoutSymbol = Symbol('timeout');
  let result = await Promise.race([
    promise,
    new Promise((resolve) => {
      timeout = setTimeout(() => resolve(timeoutSymbol), timeoutMs);
      timeout.unref?.();
    }),
  ]);
  clearTimeout(timeout);
  return result === timeoutSymbol ? null : result;
}

async function readFileRange(filePath, range) {
  let content = await readWholeFile(filePath);
  return sliceTextByByteRange(content, range);
}

function forceCloseCaptureStreams(record, stdoutStream, stderrStream) {
  record.stdioClosedByManager = true;

  closeCaptureStream(record.handle?.child?.stdout, stdoutStream);
  closeCaptureStream(record.handle?.child?.stderr, stderrStream);
}

function closeCaptureStream(readable, writable) {
  try {
    readable?.unpipe?.(writable);
  } catch (_error) {}

  try {
    readable?.destroy?.();
  } catch (_error) {}

  try {
    writable?.end?.();
  } catch (_error) {}
}

async function readWholeFile(filePath) {
  try {
    return await fsp.readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT')
      return '';

    throw error;
  }
}

function sliceTextByByteRange(content, range) {
  let buffer = Buffer.from(String(content ?? ''), 'utf8');
  let start = Math.min(range.start, buffer.length);
  let end = range.hasEnd ? Math.min(range.end, buffer.length) : buffer.length;
  if (range.maxBytes != null)
    end = Math.min(end, start + range.maxBytes);

  return buffer.subarray(start, end).toString('utf8');
}

function grepText(content, pattern, flags, maxMatches) {
  let regex = new RegExp(pattern, normalizeSearchFlags(flags));
  let matches = [];
  let byteOffset = 0;
  let lines = String(content ?? '').split(/\n/g);

  for (let index = 0; index < lines.length; index++) {
    let line = lines[index];
    regex.lastIndex = 0;
    let match = regex.exec(line);
    if (match) {
      matches.push({
        lineNumber: index + 1,
        byteOffset,
        match: match[0],
        line,
      });
      if (matches.length >= maxMatches)
        break;
    }
    byteOffset += Buffer.byteLength(line) + 1;
  }

  return matches;
}

function normalizeReadRange({ start, end, maxBytes }) {
  let normalizedStart = normalizeNonNegativeInteger(start, 0);
  let normalizedEnd = end == null ? null : normalizeNonNegativeInteger(end, 0);
  if (normalizedEnd != null && normalizedEnd < normalizedStart)
    throw new TypeError('end must be greater than or equal to start');

  return {
    start: normalizedStart,
    end: normalizedEnd,
    hasEnd: normalizedEnd != null,
    maxBytes: maxBytes == null ? null : normalizePositiveInteger(maxBytes, 'maxBytes'),
  };
}

function normalizeStatusFilter(value) {
  let values = Array.isArray(value) ? value : value ? [ value ] : [];
  return values
    .map((item) => normalizeOptionalString(item))
    .filter(Boolean);
}

function normalizeStreamName(value) {
  let normalized = normalizeOptionalString(value || 'combined');
  if (![ 'combined', 'stdout', 'stderr' ].includes(normalized))
    throw new TypeError('stream must be combined, stdout, or stderr');

  return normalized;
}

function normalizeSignal(value) {
  let signal = normalizeOptionalString(value || 'SIGTERM').toUpperCase();
  if (!/^SIG[A-Z0-9]+$/.test(signal))
    throw new TypeError('signal must be a POSIX signal name such as SIGTERM');

  return signal;
}

function normalizeRegexFlags(value) {
  let flags = normalizeOptionalString(value);
  if (!/^[dgimsuvy]*$/.test(flags))
    throw new TypeError('flags contains unsupported regular expression flags');

  return Array.from(new Set(flags.replace(/g/g, '').split(''))).join('');
}

function normalizeSearchFlags(flags) {
  return normalizeRegexFlags(flags);
}

function normalizeProcessID(value) {
  let normalized = normalizeRequiredString(value, 'processID');
  if (!/^[A-Za-z0-9_-]+$/.test(normalized))
    throw new TypeError('processID may only contain letters, numbers, underscores, and hyphens');

  return normalized;
}

function createProcessID() {
  return `proc-${randomBytes(8).toString('hex')}`;
}

function isVisibleToAgent(record, agentID) {
  return !agentID || !record.agentID || record.agentID === agentID;
}

function encodeSegment(value) {
  return encodeURIComponent(String(value)).replace(/%/g, '_');
}

function normalizeRequiredString(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '')
    throw new TypeError(`${fieldName} must be a non-empty string`);

  return value.trim();
}

function normalizeOptionalString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizePositiveInteger(value, fieldName) {
  let number = Number(value);
  if (!Number.isFinite(number) || number <= 0)
    throw new TypeError(`${fieldName} must be a positive integer`);

  return Math.trunc(number);
}

function normalizeNonNegativeInteger(value, defaultValue) {
  let number = Number(value);
  if (!Number.isFinite(number) || number < 0)
    return defaultValue;

  return Math.trunc(number);
}

function clampInteger(value, defaultValue, min, max) {
  let number = Number(value);
  if (!Number.isFinite(number))
    number = defaultValue;

  number = Math.trunc(number);
  return Math.min(max, Math.max(min, number));
}
