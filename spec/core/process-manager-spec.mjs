'use strict';

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { ProcessManager } from '../../src/core/tools/process-manager.mjs';

test('ProcessManager shutdown kills running exec tasks and stores completion output', async () => {
  let child = createFakeChild();
  let storedOutputs = [];
  let manager = new ProcessManager({
    commandExecutor: {
      startProcess() {
        return {
          command: 'sleep 60',
          shell: '/bin/bash',
          cwd: '/tmp',
          child,
          timeoutMs: null,
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
      async storeToolOutput(output) {
        storedOutputs.push(output);
        return {
          id: `out_${storedOutputs.length}`,
          sizeBytes: Buffer.byteLength(JSON.stringify(output.result || {})),
        };
      },
      createRetrievalInstructions(id, sizeBytes) {
        return { id, sizeBytes };
      },
    },
    tempRoot: '/tmp/kikx-process-manager-spec',
    idGenerator: () => 'proc_spec',
    clock: () => '2026-06-21T00:00:00.000Z',
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
  let result = await manager.shutdown({
    forceAfterMS: 25,
    timeoutMS: 200,
  });

  assert.equal(started.status, 'running');
  assert.deepEqual(child.killSignals, [ 'SIGTERM' ]);
  assert.equal(result.killed, 1);
  assert.equal(result.forced, 0);
  assert.equal(result.remaining, 0);
  assert.equal(storedOutputs.length, 1);
  assert.equal(storedOutputs[0].toolName, 'process-complete');
  assert.equal(storedOutputs[0].result.status, 'killed');
  assert.equal(storedOutputs[0].result.signal, 'SIGTERM');
});

test('ProcessManager shutdown waits for a child to exit after SIGTERM before forcing', async () => {
  let child = createSlowExitingChild(60);
  let manager = createShutdownManager(child);

  let started = await manager.start({ command: 'sleep 60' }, {
    agent: { id: 'agent_1' },
    session: { id: 'ses_1' },
    frame: { id: 'frame_1' },
  }, {
    graceMs: 0,
    autoWake: false,
    returnCompletionIfReady: false,
  });

  let startedAt = Date.now();
  let result = await manager.shutdown({
    forceAfterMS: 250,
    timeoutMS: 500,
  });
  let elapsed = Date.now() - startedAt;

  assert.equal(started.status, 'running');
  assert.deepEqual(child.killSignals, [ 'SIGTERM' ], 'a well-behaved child is only asked to terminate');
  assert.ok(elapsed >= 45, `shutdown must wait for the child, not force it immediately (waited ${elapsed}ms)`);
  assert.equal(result.forced, 0);
  assert.equal(result.remaining, 0);
});

test('ProcessManager shutdown force-kills only after the grace deadline', async () => {
  let child = createIgnoringChild();
  let manager = createShutdownManager(child);

  await manager.start({ command: 'sleep 60' }, {
    agent: { id: 'agent_1' },
    session: { id: 'ses_1' },
    frame: { id: 'frame_1' },
  }, {
    graceMs: 0,
    autoWake: false,
    returnCompletionIfReady: false,
  });

  let result = await manager.shutdown({
    forceAfterMS: 30,
    timeoutMS: 150,
  });

  assert.deepEqual(child.killSignals, [ 'SIGTERM', 'SIGKILL' ]);
  assert.equal(result.forced, 1);
  assert.equal(result.remaining, 0);
});

test('ProcessManager suspends, resumes, and kills a suspended command', async () => {
  let child = createFakeChild();
  let manager = createShutdownManager(child);
  let started = await manager.start({ command: 'sleep 60' }, {
    agent: { id: 'agent_1' },
    session: { id: 'ses_1' },
    frame: { id: 'frame_1' },
  }, {
    graceMs: 0,
    autoWake: false,
    returnCompletionIfReady: false,
  });

  let suspended = await manager.suspend({ processID: started.processID, _agentID: 'agent_1', _sessionID: 'ses_1' });
  assert.equal(suspended.status, 'suspended');
  assert.deepEqual(child.killSignals, [ 'SIGSTOP' ]);
  assert.equal(manager.status({ processID: started.processID, _agentID: 'agent_1' }).status, 'suspended');

  await manager.kill({ processID: started.processID, _agentID: 'agent_1' });
  assert.deepEqual(child.killSignals, [ 'SIGSTOP', 'SIGCONT', 'SIGTERM' ]);
});

test('ProcessManager resumes a suspended command with SIGCONT', async () => {
  let child = createFakeChild();
  let manager = createShutdownManager(child);
  let started = await manager.start({ command: 'sleep 60' }, {
    agent: { id: 'agent_1' },
    session: { id: 'ses_1' },
    frame: { id: 'frame_1' },
  }, {
    graceMs: 0,
    autoWake: false,
    returnCompletionIfReady: false,
  });

  await manager.suspend({ processID: started.processID, _agentID: 'agent_1' });
  let resumed = await manager.resume({ processID: started.processID, _agentID: 'agent_1' });
  assert.equal(resumed.status, 'running');
  assert.deepEqual(child.killSignals, [ 'SIGSTOP', 'SIGCONT' ]);
});

function createShutdownManager(child) {
  return new ProcessManager({
    commandExecutor: {
      startProcess() {
        return {
          command: 'sleep 60',
          shell: '/bin/bash',
          cwd: '/tmp',
          child,
          timeoutMs: null,
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
    tempRoot: '/tmp/kikx-process-manager-spec',
    idGenerator: () => 'proc_spec',
    clock: () => '2026-06-21T00:00:00.000Z',
  });
}

function createSlowExitingChild(delayMs) {
  let child = createFakeChild();
  child.kill = (signal) => {
    child.killSignals.push(signal);
    setTimeout(() => {
      child.stdout.end();
      child.stderr.end();
      child.emit('exit', null, signal);
      child.emit('close', null, signal);
    }, delayMs);
  };
  return child;
}

function createIgnoringChild() {
  let child = createFakeChild();
  child.kill = (signal) => {
    child.killSignals.push(signal);
    if (signal !== 'SIGKILL')
      return;

    child.stdout.end();
    child.stderr.end();
    child.emit('exit', null, signal);
    child.emit('close', null, signal);
  };
  return child;
}

function createFakeChild() {
  let child = new EventEmitter();
  child.pid = 12345;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killSignals = [];
  child.stdin = new PassThrough();

  child.kill = (signal) => {
    child.killSignals.push(signal);
    child.stdout.end();
    child.stderr.end();
    child.emit('exit', null, signal);
    child.emit('close', null, signal);
  };

  return child;
}

test('ProcessManager refuses to start a command for a suspended agent', async () => {
  let child = createFakeChild();
  let manager = createShutdownManager(child);
  let starts = 0;
  manager.commandExecutor.startProcess = () => {
    starts += 1;
    return {
      command: 'sleep 60',
      shell: '/bin/bash',
      cwd: '/tmp',
      child,
      timeoutMs: null,
      startedAt: Date.now(),
      get timedOut() { return false; },
      clearTimeout() {},
      kill(signal) { child.kill(signal); },
    };
  };
  manager.frameRuntime = { isAgentSuspended() { return true; } };

  await assert.rejects(
    () => manager.start({ command: 'sleep 60' }, {
      agent: { id: 'agent_1' },
      session: { id: 'ses_1' },
      frame: { id: 'frame_1' },
    }, { autoWake: false }),
    /session is suspended/,
  );
  assert.equal(starts, 0);
});

test('ProcessManager suspends a command that started during a suspension race', async () => {
  let child = createFakeChild();
  let manager = createShutdownManager(child);
  let suspended = false;
  manager.frameRuntime = {
    isAgentSuspended() { return suspended; },
  };
  let originalStart = manager.commandExecutor.startProcess.bind(manager.commandExecutor);
  manager.commandExecutor.startProcess = (...args) => {
    let handle = originalStart(...args);
    suspended = true;
    return handle;
  };

  let started = await manager.start({ command: 'sleep 60' }, {
    agent: { id: 'agent_1' },
    session: { id: 'ses_1' },
    frame: { id: 'frame_1' },
  }, { autoWake: false, graceMs: 0 });

  assert.equal(started.status, 'suspended');
  assert.deepEqual(child.killSignals, [ 'SIGSTOP' ]);
});

test('a queued message ends the exec grace wait instead of blocking the agent', async () => {
  let child = createFakeChild();
  let manager = createShutdownManager(child);
  manager.frameRuntime = {
    isAgentSuspended() { return false; },
    hasAgentSteering() { return true; },
  };

  let startedAt = Date.now();
  let started = await manager.start({ command: 'sleep 60' }, {
    agent: { id: 'agent_1' },
    session: { id: 'ses_1' },
    frame: { id: 'frame_1' },
  }, {
    graceMs: 1000,
    autoWake: false,
    returnCompletionIfReady: true,
  });
  let elapsed = Date.now() - startedAt;

  assert.equal(started.status, 'running');
  assert.ok(elapsed < 500, `the grace wait should end at the message boundary, not the full timeout (waited ${elapsed}ms)`);
});
