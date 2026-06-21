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
