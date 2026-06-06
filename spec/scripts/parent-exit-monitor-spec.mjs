'use strict';

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createParentExitMonitor,
  defaultIsProcessAlive,
} from '../../scripts/parent-exit-monitor.mjs';

test('createParentExitMonitor calls onParentExit when the parent PID changes', () => {
  let currentParentPID = 100;
  let intervalCallback;
  let clearedTimer = null;
  let unrefCalled = false;
  let events = [];
  let timer = {
    unref() {
      unrefCalled = true;
    },
  };

  createParentExitMonitor({
    parentPID: 100,
    getParentPID: () => currentParentPID,
    isProcessAlive: () => true,
    onParentExit: (event) => events.push(event),
    intervalMS: 10,
    setIntervalFn(callback, intervalMS) {
      assert.equal(intervalMS, 10);
      intervalCallback = callback;
      return timer;
    },
    clearIntervalFn(_timer) {
      clearedTimer = _timer;
    },
  });

  intervalCallback();
  assert.deepEqual(events, []);

  currentParentPID = 1;
  intervalCallback();
  intervalCallback();

  assert.equal(unrefCalled, true);
  assert.equal(clearedTimer, timer);
  assert.deepEqual(events, [
    {
      parentPID: 100,
      currentParentPID: 1,
      parentAlive: true,
    },
  ]);
});

test('createParentExitMonitor calls onParentExit when the original parent no longer exists', () => {
  let intervalCallback;
  let events = [];

  createParentExitMonitor({
    parentPID: 100,
    getParentPID: () => 100,
    isProcessAlive: () => false,
    onParentExit: (event) => events.push(event),
    setIntervalFn(callback) {
      intervalCallback = callback;
      return {};
    },
    clearIntervalFn() {},
  });

  intervalCallback();
  intervalCallback();

  assert.deepEqual(events, [
    {
      parentPID: 100,
      currentParentPID: 100,
      parentAlive: false,
    },
  ]);
});

test('createParentExitMonitor stop prevents parent-exit callbacks', () => {
  let intervalCallback;
  let clearCount = 0;
  let calls = 0;

  let monitor = createParentExitMonitor({
    parentPID: 100,
    getParentPID: () => 1,
    isProcessAlive: () => false,
    onParentExit: () => calls += 1,
    setIntervalFn(callback) {
      intervalCallback = callback;
      return {};
    },
    clearIntervalFn() {
      clearCount += 1;
    },
  });

  monitor.stop();
  monitor.stop();
  intervalCallback();

  assert.equal(calls, 0);
  assert.equal(clearCount, 1);
});

test('createParentExitMonitor rejects missing callbacks', () => {
  assert.throws(
    () => createParentExitMonitor({}),
    /onParentExit must be a function/u,
  );
});

test('defaultIsProcessAlive maps process signal checks to liveness', () => {
  let originalKill = process.kill;

  try {
    process.kill = () => true;
    assert.equal(defaultIsProcessAlive(100), true);

    process.kill = () => {
      let error = new Error('missing process');
      error.code = 'ESRCH';
      throw error;
    };
    assert.equal(defaultIsProcessAlive(100), false);

    process.kill = () => {
      let error = new Error('not allowed');
      error.code = 'EPERM';
      throw error;
    };
    assert.equal(defaultIsProcessAlive(100), true);

    let unexpected = new Error('unexpected');
    process.kill = () => {
      throw unexpected;
    };
    assert.throws(
      () => defaultIsProcessAlive(100),
      (error) => error === unexpected,
    );
  } finally {
    process.kill = originalKill;
  }
});
