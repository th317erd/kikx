'use strict';

// S4: an oversized frame body. A huge `content.text` (a pasted log, a big tool
// output) must parse, queue, and apply without throwing, and it must not let the
// pending-event queue grow past its hard cap.

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

import { installDom } from './support/mini-dom.mjs';

register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);

installDom();

const {
  flushFrameRuntimeEvents,
  onRuntimeEvent,
  MAX_PENDING_FRAME_RUNTIME_EVENTS,
} = await import('../../src/client/components/kikx-runtime-events.mjs');
const { createSessionStateSnapshot } = await import('../../src/client/state/session-state-utils.mjs');

function createApp() {
  let state = createSessionStateSnapshot({
    sessionIDs: [ 's1' ],
    sessionDetailsByID: { s1: { id: 's1' } },
    framesBySessionID: { s1: [] },
    sessionPagingByID: {},
  });
  state.selectedSessionID = 's1';

  return {
    isConnected: true,
    _state: state,
    _pendingFrameRuntimeEvents: [],
    _frameRuntimeFlushScheduled: true,
    _syncFrameThread() {},
    _schedulePreviewRefresh() {},
    _requestRender() {},
  };
}

function frameAddedEvent(sessionID, frame) {
  return {
    type: 'frame.added',
    data: JSON.stringify({ type: 'frame.added', sessionID, frame }),
  };
}

test('a multi-megabyte frame body queues, drains, and applies intact', () => {
  let app = createApp();
  let huge = 'x'.repeat(4 * 1024 * 1024);
  let frame = { id: 'big', type: 'ToolResult', content: { text: huge } };

  assert.doesNotThrow(() => {
    onRuntimeEvent(app, frameAddedEvent('s1', frame));
  });

  assert.equal(app._pendingFrameRuntimeEvents.length, 1);
  assert.equal(app._pendingFrameRuntimeEvents[0].frame.content.text.length, huge.length);

  app._frameRuntimeFlushScheduled = false;
  flushFrameRuntimeEvents(app);

  assert.equal(app._pendingFrameRuntimeEvents.length, 0);
  let stored = app._state.framesBySessionID.s1.find((entry) => entry.id === 'big');
  assert.ok(stored, 'the oversized frame must reach session state');
  assert.equal(stored.content.text.length, huge.length);
});

test('an oversized body for the same frame coalesces instead of growing the queue', () => {
  let app = createApp();
  for (let index = 0; index < 4; index += 1) {
    onRuntimeEvent(app, frameAddedEvent('s1', {
      id: 'streaming',
      type: 'AgentMessageDelta',
      content: { text: 'y'.repeat(1024 * 1024) },
    }));
  }

  assert.equal(app._pendingFrameRuntimeEvents.length, 1, 'same session+frame occupies one slot');
});

test('distinct oversized frames cannot push the queue past its hard cap', () => {
  let app = createApp();
  let total = MAX_PENDING_FRAME_RUNTIME_EVENTS + 50;

  for (let index = 0; index < total; index += 1) {
    onRuntimeEvent(app, frameAddedEvent('s1', {
      id: `f${index}`,
      type: 'UserMessage',
      content: { text: `body ${index}` },
    }));
  }

  assert.equal(app._pendingFrameRuntimeEvents.length, MAX_PENDING_FRAME_RUNTIME_EVENTS);
  assert.ok(app._frameRuntimeRefreshSessionIDs instanceof Set);
  assert.equal(app._frameRuntimeRefreshSessionIDs.has('s1'), true, 'dropped frames must mark the session for refresh');
});
