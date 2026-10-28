'use strict';

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { LocalCommandExecutionService } from '../../../src/core/tools/local-command-execution-service.mjs';
import { ProcessManager } from '../../../src/core/tools/process-manager.mjs';

// Owner decision 2026-10-27: shell commands are bounded by default (15 minutes),
// the bound is overridable to any value, and "never timeout" is expressible.
// These specs pin the three facts that make that true end to end.

const FIFTEEN_MINUTES_MS = 900000;

test('the default command timeout is 15 minutes', () => {
  let service = new LocalCommandExecutionService();

  assert.equal(service.defaultTimeoutMs, FIFTEEN_MINUTES_MS);
});

test('an omitted timeoutMs uses the 15-minute default', () => {
  let service = new LocalCommandExecutionService();

  let request = service.normalizeExecutionRequest({ command: 'true' });

  assert.equal(request.timeoutMs, FIFTEEN_MINUTES_MS);
});

test('an explicit timeoutMs overrides the default', () => {
  let service = new LocalCommandExecutionService();

  assert.equal(service.normalizeExecutionRequest({ command: 'true', timeoutMs: 5000 }).timeoutMs, 5000);
});

// The previous policy threw above a 10-minute ceiling, which made a real build
// impossible to start. "Bots can set this timeout to anything" means no ceiling.
test('there is no upper ceiling on an explicit timeoutMs', () => {
  let service = new LocalCommandExecutionService();
  let anHour = 60 * 60 * 1000;

  assert.equal(service.normalizeExecutionRequest({ command: 'true', timeoutMs: anHour }).timeoutMs, anHour);
  assert.equal(service.defaultTimeoutMs < anHour, true, 'an hour must exceed the default, or this proves nothing');
});

test('a finite ceiling is still enforceable when an embedder asks for one', () => {
  let service = new LocalCommandExecutionService({ maxTimeoutMs: 1000 });

  assert.throws(
    () => service.normalizeExecutionRequest({ command: 'true', timeoutMs: 2000 }),
    /less than or equal to 1000/,
  );
});

// "No deadline" is represented as null downstream; spawnLoginShellCommand only
// arms a timer when timeoutMs != null. Infinity must never reach setTimeout:
// Node clamps it to 1ms, which would kill every process the moment it started.
test('every "never timeout" spelling normalises to a null deadline', () => {
  let service = new LocalCommandExecutionService();
  let spellings = [ 0, Infinity, 'Infinity', 'infinity', 'inf', 'none', 'never' ];

  for (let spelling of spellings)
    assert.equal(service.normalizeExecutionRequest({ command: 'true', timeoutMs: spelling }).timeoutMs, null, `spelling ${spelling}`);
});

test('a malformed timeout is rejected rather than silently becoming unbounded', () => {
  let service = new LocalCommandExecutionService();

  for (let bad of [ -1, 0.5, 'banana', NaN ])
    assert.throws(() => service.normalizeExecutionRequest({ command: 'true', timeoutMs: bad }), TypeError, `value ${bad}`);
});

test('the bounded exec() convenience path refuses an unbounded request', () => {
  let service = new LocalCommandExecutionService();

  assert.throws(
    () => service.startProcess({ command: 'true', timeoutMs: 0 }, { allowNoTimeout: false }),
    /requires a bounded timeoutMs/,
  );
});

// Real process, real timer: a command that outlives its timeout is actually killed.
test('an explicit timeout kills a long-running command', async () => {
  let service = new LocalCommandExecutionService();

  let result = await service.exec({ command: 'sleep 5', timeoutMs: 200 });

  assert.equal(result.timedOut, true);
  assert.notEqual(result.signal, null, 'the process group must receive a signal');
  assert.ok(result.durationMs < 4000, `expected an early kill, took ${result.durationMs}ms`);
});

// The regression guard for the Infinity-clamp trap: if Infinity ever reached
// setTimeout, Node would fire it after 1ms and this command would die instantly.
test('a null deadline lets a real command finish untouched', async () => {
  let service = new LocalCommandExecutionService();

  let result = await service.exec({ command: 'sleep 0.25; echo done', timeoutMs: 0 });

  assert.equal(result.timedOut, false);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.trim(), 'done');
});

// Reachability: the tool path must actually receive the 15-minute default.
// ProcessManager used to pass `defaultTimeoutMs: null`, which silently made every
// async exec unbounded no matter what the executor's own default was.
test('ProcessManager.start hands the executor default through to the process record', async () => {
  let child = createFakeChild();
  let manager = new ProcessManager({
    commandExecutor: {
      defaultTimeoutMs: FIFTEEN_MINUTES_MS,
      startProcess(params, options) {
        // Mirror the real service's contract for an omitted timeoutMs.
        let timeoutMs = options?.defaultTimeoutMs === undefined
          ? this.defaultTimeoutMs
          : options.defaultTimeoutMs;

        return {
          command: params.command,
          shell: '/bin/bash',
          cwd: '/tmp',
          child,
          timeoutMs: params.timeoutMs ?? timeoutMs,
          startedAt: Date.now(),
          get timedOut() {
            return false;
          },
          clearTimeout() {},
          kill(signal) {
            child.kill(signal);
          },
        };
      },
    },
    toolOutputStore: {
      inlineLimitBytes: 196608,
      async storeToolOutput() {
        return { id: 'out_1', sizeBytes: 1 };
      },
      createRetrievalInstructions(id, sizeBytes) {
        return { id, sizeBytes };
      },
    },
    tempRoot: '/tmp/kikx-command-timeout-policy-spec',
    idGenerator: () => 'proc_timeout_spec',
    clock: () => '2026-10-27T00:00:00.000Z',
  });

  let started = await manager.start({ command: 'sleep 60' }, {
    agent: { id: 'agent_1' },
    session: { id: 'ses_1' },
    frame: { id: 'frame_1' },
  }, {
    graceMs: 0,
    autoWake: false,
    returnCompletionIfReady: false,
  });

  assert.equal(started.timeoutMs, FIFTEEN_MINUTES_MS, 'a defaulted exec must be bounded');
  await manager.shutdown({ forceAfterMS: 25, timeoutMS: 200 });
});

// The end-to-end version: the real executor's default reaches a real record.
test('a defaulted exec through the real executor is bounded at 15 minutes', async () => {
  let child = createFakeChild();
  let service = new LocalCommandExecutionService();
  let observed = [];
  let manager = new ProcessManager({
    commandExecutor: service,
    toolOutputStore: {
      inlineLimitBytes: 196608,
      async storeToolOutput() {
        return { id: 'out_1', sizeBytes: 1 };
      },
      createRetrievalInstructions(id, sizeBytes) {
        return { id, sizeBytes };
      },
    },
    tempRoot: '/tmp/kikx-command-timeout-policy-spec',
    idGenerator: () => 'proc_timeout_real',
    clock: () => '2026-10-27T00:00:00.000Z',
  });

  // Swap the spawned child for one that never exits, so the record stays running.
  let realStart = service.startProcess.bind(service);
  service.startProcess = (params, options) => {
    let handle = realStart(params, options);
    observed.push(handle.timeoutMs);
    try {
      handle.child.kill('SIGKILL');
    } catch (_error) {}
    return { ...handle, child };
  };

  let started = await manager.start({ command: 'sleep 60' }, {
    agent: { id: 'agent_1' },
    session: { id: 'ses_1' },
    frame: { id: 'frame_1' },
  }, {
    graceMs: 0,
    autoWake: false,
    returnCompletionIfReady: false,
  });

  assert.deepEqual(observed, [ FIFTEEN_MINUTES_MS ], 'the executor must default, not be forced to null');
  assert.equal(started.timeoutMs, FIFTEEN_MINUTES_MS);
  await manager.shutdown({ forceAfterMS: 25, timeoutMS: 200 });
});

function createFakeChild() {
  let child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.pid = 12345;
  child.killSignals = [];
  child.kill = (signal) => {
    child.killSignals.push(signal);
  };

  return child;
}
