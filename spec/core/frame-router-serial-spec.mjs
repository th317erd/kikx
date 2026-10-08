'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { FrameRouter } from '../../src/core/routing/index.mjs';

function quietLogger() {
  return {
    error() {},
    warn() {},
    log() {},
  };
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('FrameRouter.runSerial does not leak an unhandled rejection from a failing task', async () => {
  let unhandled = [];
  let onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);

  try {
    let router = new FrameRouter({ logger: quietLogger() });

    await router.runSerial('ses_1', async () => {
      throw new Error('agent task failed');
    }).catch(() => {});

    // A microtask + a macrotask gives Node a chance to report a rejection that
    // no handler ever observed.
    await tick();
    await tick();

    assert.deepEqual(unhandled, []);
    assert.equal(router._sessionChains.has('ses_1'), false, 'the serial chain must be cleaned up');
    assert.equal(router._backgroundTasks.size, 0, 'the background task set must be cleaned up');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('FrameRouter.runSerial keeps later tasks on the same session running after a failure', async () => {
  let router = new FrameRouter({ logger: quietLogger() });
  let events = [];

  await router.runSerial('ses_1', async () => {
    events.push('first');
    throw new Error('agent task failed');
  }).catch(() => {});
  await router.runSerial('ses_1', async () => {
    events.push('second');
  });

  assert.deepEqual(events, [ 'first', 'second' ]);
});
