'use strict';

// S4: malformed and poison runtime events. A bad payload from the stream must
// never wedge dispatch or drop the events that follow it, and a malformed
// payload must be reported rather than vanishing silently.

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

import { installDom } from './support/mini-dom.mjs';

register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);

installDom();

const { onRuntimeEvent } = await import('../../src/client/components/kikx-runtime-events.mjs');
const { parseRuntimeEvent } = await import('../../src/client/components/kikx-app-helpers.mjs');
const { createSessionStateSnapshot } = await import('../../src/client/state/session-state-utils.mjs');
const { clearRecentErrors, listRecentErrors } = await import('../../src/client/lib/error-boundary.mjs');

function quietConsole(callback) {
  let original = console.error;
  console.error = () => {};
  try {
    return callback();
  } finally {
    console.error = original;
  }
}

function createApp() {
  let state = createSessionStateSnapshot({
    sessionIDs: [ 's1' ],
    sessionDetailsByID: { s1: { id: 's1', title: 'One' } },
    framesBySessionID: { s1: [] },
    sessionPagingByID: {},
  });
  state.selectedSessionID = 's1';

  return {
    _state: state,
    isConnected: true,
    _syncSessionShell() {
      return true;
    },
    _requestRender() {},
  };
}

test('a malformed JSON payload is ignored and the next event still applies', () => {
  let app = createApp();
  clearRecentErrors();

  assert.doesNotThrow(() => {
    quietConsole(() => onRuntimeEvent(app, { type: 'message', data: '{not json' }));
  });
  assert.notEqual(app._state.totalTokensUsed, 7, 'a malformed payload must not mutate state');

  assert.doesNotThrow(() => {
    onRuntimeEvent(app, { type: 'tokens.updated', data: JSON.stringify({ type: 'tokens.updated', totalTokensUsed: 7 }) });
  });
  assert.equal(app._state.totalTokensUsed, 7, 'dispatch must recover for the next event');
});

// FINDING (S4) fixed: a malformed payload used to be dropped silently --
// `parseRuntimeEvent` returned null and `dispatchRuntimeEvent` returned before
// recording anything, so a systematic serialization fault was invisible. It is
// now reported through the error boundary under `kikx-runtime-events.parse`.
test('a malformed payload is reported, not silently dropped', () => {
  let app = createApp();
  clearRecentErrors();
  quietConsole(() => onRuntimeEvent(app, { type: 'message', data: '{not json' }));
  let entry = listRecentErrors().find((candidate) => candidate.label === 'kikx-runtime-events.parse');
  assert.ok(entry, 'a malformed payload must reach the error boundary');
  assert.equal(entry.context.eventType, 'message');
  assert.match(entry.context.dataPreview, /^\{not json/);
});

// The diagnostic context is bounded and the report is throttled by the error
// boundary, so a stream that is malformed end to end cannot flood the bounded
// ring or the console one entry/log per event.
test('a malformed-payload flood reports once and throttles the rest', () => {
  let app = createApp();
  clearRecentErrors();
  let logged = 0;
  let originalConsoleError = console.error;
  let originalNow = Date.now;
  console.error = () => { logged += 1; };
  // Pin the clock so the boundary's 1s repeat window is deterministic under load.
  Date.now = () => 1000;
  try {
    for (let index = 0; index < 400; index += 1) {
      onRuntimeEvent(app, { type: 'message', data: `{not json ${index} ${'x'.repeat(500)}` });
    }
  } finally {
    console.error = originalConsoleError;
    Date.now = originalNow;
  }

  let parseEntries = listRecentErrors().filter((entry) => entry.label === 'kikx-runtime-events.parse');
  assert.equal(parseEntries.length, 1, 'a malformed flood must occupy one ring entry, not one per event');
  assert.equal(parseEntries[0].count, 400, 'repeat occurrences are counted on the existing entry');
  assert.equal(parseEntries[0].context.dataPreview.length, 200, 'the payload excerpt is bounded');
  assert.equal(logged, 1, 'a malformed flood must not log once per event');
});

test('a payload getter that throws is contained and later events survive', () => {
  let app = createApp();
  clearRecentErrors();

  let poison = { type: 'message' };
  Object.defineProperty(poison, 'data', {
    get() {
      throw new Error('poison data getter');
    },
  });

  quietConsole(() => assert.doesNotThrow(() => onRuntimeEvent(app, poison)));

  assert.doesNotThrow(() => {
    onRuntimeEvent(app, { type: 'tokens.updated', data: JSON.stringify({ type: 'tokens.updated', totalTokensUsed: 9 }) });
  });
  assert.equal(app._state.totalTokensUsed, 9, 'the event after the poison getter must still apply');
});

test('a throwing session shell sync is reported and does not stop the batch', () => {
  let app = createApp();
  clearRecentErrors();
  app._syncSessionShell = () => {
    throw new Error('shell sync exploded');
  };

  quietConsole(() => assert.doesNotThrow(() => {
    onRuntimeEvent(app, {
      type: 'session.saved',
      data: JSON.stringify({ type: 'session.saved', session: { id: 's2', title: 'Two' } }),
    });
  }));

  assert.ok(
    listRecentErrors().some((entry) => entry.label === 'kikx-runtime-events.dispatch'),
    'a throw after the event parsed must be reported through the error boundary',
  );

  assert.doesNotThrow(() => {
    onRuntimeEvent(app, { type: 'tokens.updated', data: JSON.stringify({ type: 'tokens.updated', totalTokensUsed: 9 }) });
  });
  assert.equal(app._state.totalTokensUsed, 9, 'the event after the poison handler must still apply');
});

test('parseRuntimeEvent returns null for malformed JSON but keeps the event type', () => {
  assert.equal(parseRuntimeEvent({ type: 'message', data: '}{' }), null);
  assert.deepEqual(parseRuntimeEvent({ type: 'frame.added', data: '{"sessionID":"s1"}' }), {
    sessionID: 's1',
    type: 'frame.added',
  });
});
