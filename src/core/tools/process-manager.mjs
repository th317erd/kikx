'use strict';

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { finished } from 'node:stream/promises';

import {
  DEFAULT_EXEC_GRACE_MS,
  DEFAULT_EXIT_STDIO_GRACE_MS,
  DEFAULT_TEMP_ROOT,
} from './process-manager-constants.mjs';
import {
  createProcessID,
  encodeSegment,
  isVisibleToAgent,
  normalizeNonNegativeInteger,
  normalizeOptionalString,
  normalizeProcessID,
  normalizeSignal,
} from './process-manager-normalizers.mjs';
import {
  buildCompletionResult,
  createCompletedExecResult,
  createStartedResult,
} from './process-manager-results.mjs';
import {
  grepProcess,
  killProcess,
  listProcesses,
  readProcess,
  statusProcess,
} from './process-manager-queries.mjs';
import {
  forceCloseCaptureStreams,
  waitForCompletion,
  waitForRecords,
} from './process-manager-streams.mjs';
import {
  resolveFrameRuntime,
  scheduleWake,
  setWake,
  wakeOnCompletion,
} from './process-manager-wake.mjs';
import { buildDefaultWakePrompt } from './process-manager-prompts.mjs';

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

    let executionParams = await this.resolveExecutionParams(params, context);
    let handle = this.commandExecutor.startProcess(executionParams, {
      allowNoTimeout: true,
      defaultTimeoutMs: null,
    });
    let stdoutPath = path.join(processDir, 'stdout.txt');
    let stderrPath = path.join(processDir, 'stderr.txt');
    let stdoutStream = fs.createWriteStream(stdoutPath);
    let stderrStream = fs.createWriteStream(stderrPath);
    let now = this.clock();
    let agentID = normalizeOptionalString(executionParams._agentID || context.agent?.id);
    let sessionID = normalizeOptionalString(executionParams._sessionID || context.session?.id);
    let frameID = normalizeOptionalString(executionParams._frameID || context.frame?.id);

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
        return await createCompletedExecResult(record);

      if (record.status !== 'running')
        return await createCompletedExecResult(record);
    }

    if (options.autoWake !== false) {
      this.setWake(record, executionParams, context, buildDefaultWakePrompt(record));
      if (record.status !== 'running')
        await this.scheduleWake(record);
    }

    return createStartedResult(record);
  }

  async resolveExecutionParams(params = {}, context = {}) {
    if (params.cwd != null && params.cwd !== '')
      return params;

    let cwdStore = resolveAgentCwdStore(context, this.context);
    let agentID = normalizeOptionalString(params._agentID || context.agent?.id);
    let sessionID = normalizeOptionalString(params._sessionID || context.session?.id);
    if (!cwdStore?.getCWD || !agentID || !sessionID)
      return params;

    let state = await cwdStore.getCWD(agentID, sessionID);
    if (!state?.cwd)
      return params;

    return {
      ...params,
      cwd: state.cwd,
    };
  }

  list(params = {}) {
    return listProcesses(this, params);
  }

  status(params = {}) {
    return statusProcess(this, params);
  }

  async read(params = {}) {
    return await readProcess(this, params);
  }

  async grep(params = {}) {
    return await grepProcess(this, params);
  }

  kill(params = {}) {
    return killProcess(this, params);
  }

  async shutdown(options = {}) {
    let signal = normalizeSignal(options.signal || 'SIGTERM');
    let forceSignal = normalizeSignal(options.forceSignal || 'SIGKILL');
    let forceAfterMS = normalizeNonNegativeInteger(options.forceAfterMS, 1000);
    let timeoutMS = normalizeNonNegativeInteger(options.timeoutMS, 3000);
    let running = Array.from(this.processes.values()).filter((record) => record.status === 'running');
    let shutdownAt = this.clock();

    for (let record of running) {
      record.killRequested ||= {
        signal,
        requestedAt: shutdownAt,
        agentID: record.agentID || null,
        reason: 'server-shutdown',
      };
      record.updatedAt = shutdownAt;
      record.handle.kill(signal);
    }

    if (running.length === 0) {
      return {
        signal,
        forceSignal,
        killed: 0,
        forced: 0,
        remaining: 0,
      };
    }

    await waitForRecords(running, Math.min(forceAfterMS, timeoutMS));
    let stillRunning = running.filter((record) => record.status === 'running');
    for (let record of stillRunning)
      record.handle.kill(forceSignal);

    let remainingBudget = Math.max(0, timeoutMS - forceAfterMS);
    await waitForRecords(stillRunning, remainingBudget);
    let remaining = running.filter((record) => record.status === 'running');

    return {
      signal,
      forceSignal,
      killed: running.length,
      forced: stillRunning.length,
      remaining: remaining.length,
    };
  }

  async wakeOnCompletion(params = {}, context = {}) {
    return await wakeOnCompletion(this, params, context);
  }

  setWake(record, params = {}, context = {}, continuationPrompt = '') {
    return setWake(this, record, params, context, continuationPrompt);
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
      let result = await buildCompletionResult(record);
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

  async scheduleWake(record) {
    return await scheduleWake(this, record);
  }

  resolveFrameRuntime() {
    return resolveFrameRuntime(this);
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
}

function resolveAgentCwdStore(context = {}, appContext = null) {
  if (context.agentCwdStore)
    return context.agentCwdStore;

  if (context.services?.agentCwdStore)
    return context.services.agentCwdStore;

  let serviceContext = context.services?.context || context.context || appContext;
  if (serviceContext?.has?.('agentCwdStore') && typeof serviceContext.require === 'function')
    return serviceContext.require('agentCwdStore');

  if (typeof serviceContext?.require === 'function') {
    try {
      return serviceContext.require('agentCwdStore');
    } catch (_error) {}
  }

  return null;
}
