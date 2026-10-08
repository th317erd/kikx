'use strict';

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { installProcessErrorPolicy } from '../../src/server/process-error-policy.mjs';

function createHarness(options = {}) {
  let processRef = new EventEmitter();
  let logs = [];
  let fatals = [];
  let exits = [];
  processRef.exit = (code) => exits.push(code);

  let logger = {
    error: (...args) => logs.push(args),
  };
  let uninstall = installProcessErrorPolicy({
    processRef,
    logger,
    onFatal: (error, type) => fatals.push({ error, type }),
    ...options,
  });

  return { processRef, logs, fatals, exits, uninstall };
}

test('uncaughtException is logged with context and routed to the fatal handler', () => {
  let harness = createHarness();
  let error = new Error('timer blew up');

  harness.processRef.emit('uncaughtException', error);

  assert.equal(harness.logs.length, 1);
  assert.match(String(harness.logs[0][0]), /uncaughtException/i);
  assert.equal(harness.fatals.length, 1);
  assert.equal(harness.fatals[0].error, error);
  assert.equal(harness.fatals[0].type, 'uncaughtException');
  assert.deepEqual(harness.exits, [], 'a fatal handler owns recovery; the policy must not exit itself');
});

test('uncaughtException exits when no fatal handler owns recovery', () => {
  let harness = createHarness({ onFatal: null });

  harness.processRef.emit('uncaughtException', new Error('timer blew up'));

  assert.equal(harness.exits.length, 1);
  assert.equal(harness.exits[0], 1);
});

test('unhandledRejection is logged without terminating the process', () => {
  let harness = createHarness();
  let promise = Promise.reject(new Error('stray'));
  // The rejection is intentionally observed by the policy, not by this test.
  promise.catch(() => {});

  harness.processRef.emit('unhandledRejection', new Error('stray'), promise);

  assert.equal(harness.logs.length, 1);
  assert.match(String(harness.logs[0][0]), /unhandledRejection/i);
  // The app may observe the rejection, but the policy never exits for it.
  assert.equal(harness.fatals.length, 1);
  assert.equal(harness.fatals[0].type, 'unhandledRejection');
  assert.deepEqual(harness.exits, [], 'a stray rejection must not drop every connected client');
});

test('uninstall removes both process handlers', () => {
  let harness = createHarness();
  assert.equal(harness.processRef.listenerCount('uncaughtException'), 1);
  assert.equal(harness.processRef.listenerCount('unhandledRejection'), 1);

  harness.uninstall();

  assert.equal(harness.processRef.listenerCount('uncaughtException'), 0);
  assert.equal(harness.processRef.listenerCount('unhandledRejection'), 0);
});
