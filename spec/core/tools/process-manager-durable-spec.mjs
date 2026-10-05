'use strict';

import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ProcessManager } from '../../../src/core/tools/process-manager.mjs';
import { ProcessStore } from '../../../src/core/tools/process-manager-store.mjs';
import { ToolOutputStore } from '../../../src/core/tools/tool-output-store.mjs';
import { FrameRouter } from '../../../src/core/routing/index.mjs';
import { FrameRuntime } from '../../../src/core/runtime/frame-runtime.mjs';

// In-memory AeorDB stand-in: file map + directory listing by glob. Enough for
// ProcessStore/ToolOutputStore round-trips without a live database.
function createClient() {
  return {
    files: new Map(),
    async putFile(path, body) {
      this.files.set(path, body);
      return { path };
    },
    async getFile(path, options = {}) {
      if (!this.files.has(path)) {
        let error = new Error(`missing file: ${path}`);
        error.status = 404;
        throw error;
      }

      let value = this.files.get(path);
      if (options.expectJSON === false)
        return String(value ?? '');

      return value;
    },
    async listDirectory(path, options = {}) {
      let prefix = `${path.replace(/\/+$/g, '')}/`;
      let items = [];
      for (let filePath of this.files.keys()) {
        if (!filePath.startsWith(prefix))
          continue;

        let glob = options?.glob || '';
        if (glob === '**/processes/*.json' && !/\/processes\/[^/]+\.json$/.test(filePath))
          continue;

        if (glob === '**/frames/*.json' && !filePath.includes('/frames/'))
          continue;

        if (glob === '**/*.json' && !filePath.endsWith('.json'))
          continue;

        if ((glob === '*/session.json' || glob === '**/session.json') && !/\/session\.json$/.test(filePath))
          continue;

        items.push({ path: filePath });
      }
      return { items };
    },
  };
}

function createManager(aeordb, options = {}) {
  let outputID = 0;
  let store = new ToolOutputStore({
    aeordb,
    idGenerator: () => `OUT${++outputID}`,
    clock: () => '2026-06-10T00:00:00.000Z',
  });
  let manager = new ProcessManager({
    commandExecutor: {
      startProcess() {
        throw new Error('commandExecutor not used in durable specs');
      },
    },
    toolOutputStore: store,
    aeordb,
    clock: () => '2026-06-10T00:00:00.000Z',
    idGenerator: () => 'PROC_new',
    logger: { error() {} },
    ...options,
  });
  return { manager, store };
}

function seedRecord(overrides = {}) {
  return {
    id: 'PROC1',
    processID: 'PROC1',
    agentID: 'agent_1',
    sessionID: 'ses_1',
    frameID: 'frm_1',
    command: 'echo hi',
    shell: '/bin/bash',
    cwd: '/tmp',
    pid: 12345,
    status: 'running',
    exitCode: null,
    signal: null,
    timedOut: false,
    timeoutMs: null,
    startedAt: '2026-06-10T00:00:00.000Z',
    startedAtMs: 1,
    updatedAt: '2026-06-10T00:00:00.000Z',
    completedAt: null,
    durationMs: null,
    stdoutBytes: 3,
    stderrBytes: 0,
    stdioClosedByManager: false,
    stdioCloseGraceMs: 250,
    completionToolOutputID: null,
    completionSizeBytes: null,
    completionRetrieval: null,
    completionLarge: false,
    completionStoreError: null,
    killRequested: null,
    wakeOnCompletion: null,
    wakeFrameID: null,
    wakeCompletionOutputID: null,
    wakeError: null,
    ...overrides,
  };
}

test('ProcessStore round-trips a process record and its captured stdio', async () => {
  let aeordb = createClient();
  let store = new ProcessStore({ aeordb, clock: () => '2026-06-10T00:00:00.000Z' });
  let dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kikx-process-store-spec-'));
  let stdoutPath = path.join(dir, 'stdout.txt');
  let stderrPath = path.join(dir, 'stderr.txt');
  await fsp.writeFile(stdoutPath, 'hello');
  await fsp.writeFile(stderrPath, '');

  let record = seedRecord({ status: 'completed', exitCode: 0, stdoutPath, stderrPath });
  await store.saveRecord(record);

  let listed = await store.listRecords();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].processID, 'PROC1');
  assert.equal(listed[0].status, 'completed');
  assert.equal(listed[0].exitCode, 0);

  let stdio = await store.readStdio({ sessionID: 'ses_1', processID: 'PROC1' });
  assert.equal(stdio.stdout, 'hello');
  assert.equal(stdio.stderr, '');

  // Process-local handles must never be serialized.
  assert.equal(listed[0].handle, undefined);
  assert.equal(listed[0].stdoutPath, stdoutPath);
});

test('durable stdio survives a reboot that clears the volatile capture directory', async () => {
  let aeordb = createClient();
  let store = new ProcessStore({ aeordb });
  let dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kikx-process-reboot-spec-'));
  let stdoutPath = path.join(dir, 'stdout.txt');
  let stderrPath = path.join(dir, 'stderr.txt');
  await fsp.writeFile(stdoutPath, 'before reboot');
  await fsp.writeFile(stderrPath, 'err');

  await store.saveRecord(seedRecord({ status: 'completed', stdoutPath, stderrPath }));
  // Simulate a host reboot that wipes the volatile /tmp capture files.
  await fsp.rm(dir, { recursive: true, force: true });

  let stdio = await store.readStdio({ sessionID: 'ses_1', processID: 'PROC1' });
  assert.equal(stdio.stdout, 'before reboot');
  assert.equal(stdio.stderr, 'err');
});

test('ProcessManager.rehydrate marks a shutdown-time running process interrupted and resolves it', async () => {
  let aeordb = createClient();
  let processStore = new ProcessStore({ aeordb });
  let dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kikx-process-rehydrate-spec-'));
  let stdoutPath = path.join(dir, 'stdout.txt');
  await fsp.writeFile(stdoutPath, 'partial');

  await processStore.saveRecord(seedRecord({ status: 'running', stdoutBytes: 7, stdoutPath, stderrPath: path.join(dir, 'none') }));

  let { manager } = createManager(aeordb);
  let result = await manager.rehydrate();

  assert.equal(result.interrupted, 1);
  let record = manager.requireProcess('PROC1', 'agent_1');
  assert.equal(record.status, 'interrupted');
  assert.ok(record.completionToolOutputID, 'interrupted record stores completion output');
  assert.equal(record.durableStdout, 'partial');

  let read = await manager.read({ processID: 'PROC1', _agentID: 'agent_1' });
  assert.equal(read.content, 'partial');
  assert.equal(read.status, 'interrupted');
});

test('ProcessManager.rehydrate preserves a completed process and its wake marker', async () => {
  let aeordb = createClient();
  let processStore = new ProcessStore({ aeordb });
  await processStore.saveRecord(seedRecord({
    status: 'completed',
    exitCode: 0,
    completionToolOutputID: 'OUT9',
    wakeCompletionOutputID: 'OUT9',
    wakeOnCompletion: { agentID: 'agent_1', sessionID: 'ses_1', frameID: 'frm_1', continuationPrompt: 'go' },
  }));

  let { manager } = createManager(aeordb);
  let result = await manager.rehydrate();

  assert.equal(result.interrupted, 0);
  let record = manager.requireProcess('PROC1', 'agent_1');
  assert.equal(record.status, 'completed');
  assert.equal(record.wakeCompletionOutputID, 'OUT9');
});

test('recoverPendingWakes reschedules an unconsumed completed wake exactly once and skips a consumed one', async () => {
  let aeordb = createClient();
  let processStore = new ProcessStore({ aeordb });
  await processStore.saveRecord(seedRecord({
    processID: 'PROC_consumed',
    agentID: 'agent_1',
    sessionID: 'ses_1',
    status: 'completed',
    completionToolOutputID: 'OUT1',
    wakeCompletionOutputID: 'OUT1',
    wakeOnCompletion: { agentID: 'agent_1', sessionID: 'ses_1', frameID: 'frm_1', continuationPrompt: 'go' },
  }));
  await processStore.saveRecord(seedRecord({
    processID: 'PROC_pending',
    agentID: 'agent_1',
    sessionID: 'ses_1',
    status: 'completed',
    completionToolOutputID: 'OUT2',
    wakeCompletionOutputID: null,
    wakeOnCompletion: { agentID: 'agent_1', sessionID: 'ses_1', frameID: 'frm_1', continuationPrompt: 'go' },
  }));

  let scheduled = [];
  let { manager } = createManager(aeordb, {
    frameRuntime: {
      clock: () => 1000,
      idGenerator: () => 'wake_frame_1',
      async ensureSessionEntry() {
        return { session: { id: 'ses_1' }, frameEngine: { merge(frames) { return frames; } } };
      },
      frameStore: { async flush() {} },
      async processScheduledFrames() {},
    },
  });
  manager.scheduleWake = async (record) => {
    scheduled.push(record.processID);
    record.wakeFrameID = `wake_${record.processID}`;
    return record.wakeFrameID;
  };

  await manager.rehydrate();
  let result = await manager.recoverPendingWakes();

  assert.deepEqual(scheduled, [ 'PROC_pending' ]);
  assert.equal(result.recovered, 1);
});

test('scheduleWake persists the wake frame id and consumed output so a reload is idempotent', async () => {
  let aeordb = createClient();
  let { manager } = createManager(aeordb);
  let record = seedRecord({
    status: 'completed',
    completionToolOutputID: 'OUT7',
    wakeOnCompletion: { agentID: 'agent_1', sessionID: 'ses_1', frameID: 'frm_1', continuationPrompt: 'go' },
  });
  manager.processes.set('PROC1', record);
  manager.frameRuntime = {
    clock: () => 1000,
    idGenerator: () => 'wake_frame_1',
    async ensureSessionEntry() {
      return { session: { id: 'ses_1' }, frameEngine: { merge(frames) { return frames; } } };
    },
    frameStore: { async flush() {} },
    async processScheduledFrames() {},
  };

  let frameID = await manager.scheduleWake(record);
  assert.equal(frameID, 'wake_frame_1');

  let persisted = await manager.processStore.loadRecord('ses_1', 'PROC1');
  assert.equal(persisted.wakeFrameID, 'wake_frame_1');
  assert.equal(persisted.wakeCompletionOutputID, 'OUT7');
});

// End-to-end durability: an interrupted process is rehydrated from a live
// FrameRuntime store, and `recoverPendingWakes` produces exactly one reloaded
// scheduled wake that the queue then dispatches once — no duplicate turns.
test('an interrupted process yields exactly one reloaded, dispatched wake', async () => {
  let aeordb = createClient();
  let micros = () => Date.now() * 1000;
  let router = new FrameRouter({ logger: { error() {} } });

  let runtime = new FrameRuntime({
    aeordb,
    frameRouter: router,
    clock: micros,
    idGenerator: (() => {
      let ids = [ 'ses_1' ];
      let index = 0;
      return () => ids[index++] || `gen_${index}`;
    })(),
    scheduledFrameWorkerIntervalMS: 1000000,
    logger: { error() {}, warn() {} },
  });
  await runtime.createSession({ title: 'Durable' });

  let { manager } = createManager(aeordb, {
    frameRuntime: runtime,
    idGenerator: () => 'PROC_live',
    clock: () => new Date().toISOString(),
  });

  // Seed a persisted running process, as a crash mid-exec would leave it.
  let processStore = new ProcessStore({ aeordb });
  let dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kikx-process-e2e-spec-'));
  let stdoutPath = path.join(dir, 'stdout.txt');
  await fsp.writeFile(stdoutPath, 'ran halfway');
  let live = seedRecord({
    processID: 'PROC_crash',
    sessionID: 'ses_1',
    frameID: 'frm_1',
    status: 'running',
    stdoutPath,
    stderrPath: path.join(dir, 'none.txt'),
    wakeOnCompletion: { agentID: 'agent_1', sessionID: 'ses_1', frameID: 'frm_1', continuationPrompt: 'continue', triggerDepth: 0 },
  });
  await processStore.saveRecord(live);

  // Boot: rehydrate (marks interrupted, stores completion output, reschedules the
  // wake) then arm the worker over the persisted timer.
  let result = await manager.rehydrate();
  assert.equal(result.interrupted, 1);
  let recovered = await manager.recoverPendingWakes();
  assert.equal(recovered.recovered, 1);

  let wake = manager.requireProcess('PROC_crash', 'agent_1');
  assert.ok(wake.wakeFrameID, 'a reloaded wake frame was scheduled');

  // The timer is now in the runtime's in-memory queue and fires exactly once.
  await runtime.startScheduledFrameWorker();
  await runtime.processScheduledFrames();
  runtime.stopScheduledFrameWorker();

  let frames = await runtime.listFrames('ses_1', { limit: 1000 });
  let wakes = frames.filter((frame) => frame.continuation?.kind === 'exec-wake-on-completion');
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0].scheduledStatus, 'fired');
  assert.equal(wakes[0].continuation.processStatus, 'interrupted');

  // A second rehydrate/pass must not schedule a duplicate wake for the completed
  // and now-consumed process.
  let again = await manager.recoverPendingWakes();
  assert.equal(again.recovered, 0);
});
