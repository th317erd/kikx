'use strict';

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { RuntimeEventGateway } from '../../src/server/runtime-event-gateway.mjs';

function frameEvent(id, type = 'AgentThinking', text = 'x', sessionID = 's1', eventType = 'frame.phantom') {
  return {
    type: eventType,
    sessionID,
    frame: {
      id,
      type,
      content: { thinking: { text } },
    },
  };
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('the gateway owns one runtime subscription and fans out to subscribers', async () => {
  let runtime = new EventEmitter();
  let gateway = new RuntimeEventGateway({ frameRuntime: runtime, batchIntervalMs: 5 });
  let first = [];
  let second = [];
  let unsubscribeFirst = gateway.subscribe({ onBatch: (events) => first.push(...events) });
  let unsubscribeSecond = gateway.subscribe({ onBatch: (events) => second.push(...events) });

  assert.equal(runtime.listenerCount('event'), 1);
  runtime.emit('event', frameEvent('thinking'));
  await wait(15);

  assert.equal(first.length, 1);
  assert.equal(second.length, 1);

  unsubscribeFirst();
  unsubscribeSecond();
  gateway.close();
  assert.equal(runtime.listenerCount('event'), 0);
});

test('the gateway merges repeated deltas and honors session filters', async () => {
  let runtime = new EventEmitter();
  let gateway = new RuntimeEventGateway({ frameRuntime: runtime, batchIntervalMs: 5 });
  let all = [];
  let selected = [];
  gateway.subscribe({ onBatch: (events) => all.push(...events) });
  gateway.subscribe({ sessionID: 's1', onBatch: (events) => selected.push(...events) });

  runtime.emit('event', frameEvent('thinking', 'AgentThinking', 'old'));
  runtime.emit('event', frameEvent('thinking', 'AgentThinking', 'new'));
  runtime.emit('event', frameEvent('other', 'AgentThinking', 'other', 's2'));
  await wait(15);

  assert.equal(all.length, 2, 'one latest update per session/frame, plus the other session');
  assert.equal(selected.length, 1);
  assert.equal(selected[0].frame.content.thinking.text, 'new');
  gateway.close();
});

test('the gateway flushes immediately at its capacity limit', async () => {
  let runtime = new EventEmitter();
  let gateway = new RuntimeEventGateway({ frameRuntime: runtime, batchIntervalMs: 60000, batchLimit: 3 });
  let batches = [];
  gateway.subscribe({ onBatch: (events) => batches.push(events) });

  runtime.emit('event', frameEvent('a'));
  runtime.emit('event', frameEvent('b'));
  assert.equal(batches.length, 0, 'must remain buffered below capacity');

  runtime.emit('event', frameEvent('c'));
  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 3);
  gateway.close();
});

test('closing the gateway cancels a pending batch', async () => {
  let runtime = new EventEmitter();
  let gateway = new RuntimeEventGateway({ frameRuntime: runtime, batchIntervalMs: 20 });
  let batches = [];
  gateway.subscribe({ onBatch: (events) => batches.push(events) });

  runtime.emit('event', frameEvent('a'));
  gateway.close();
  await wait(30);
  assert.equal(batches.length, 0);
});
