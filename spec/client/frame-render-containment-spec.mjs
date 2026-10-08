'use strict';

// S1 error containment: a throwing frame renderer, thread rebuild, or SSE
// dispatch must never abort the rest of the batch. These specs deliberately use
// only the pre-existing modules -- they fail today because the exception
// escapes the render/runtime entry points.

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

import { installDom } from './support/mini-dom.mjs';

register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);

const { document, registry: customElements } = installDom();

// A custom frame component that always throws, standing in for a buggy
// plugin renderer.
class ThrowingFrame extends HTMLElement {
  updateFrame() {
    throw new Error('frame renderer exploded');
  }
}
customElements.define('kikx-throwing-frame', ThrowingFrame);

await import('../../src/client/components/kikx-frame-item.mjs');
await import('../../src/client/components/kikx-chat-view.mjs');
await import('../../src/client/components/kikx-app.mjs');
const { syncFrameThread } = await import('../../src/client/components/kikx-frame-scroll.mjs');
const { flushFrameRuntimeEvents, onRuntimeEvent } = await import('../../src/client/components/kikx-runtime-events.mjs');
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

function frame(id, text, type = 'UserMessage') {
  return { id, type, content: { text } };
}

function boomState() {
  return { clientFrameComponentsByType: { BoomThing: { tagName: 'kikx-throwing-frame' } } };
}

test('a throwing frame renderer does not stop later frames from updating', () => {
  let view = document.createElement('kikx-chat-view');
  view.update({ frames: [ frame('base', 'base text') ], appState: {} });
  assert.ok(view.frameStream, 'the initial render must build the frame stream');

  assert.doesNotThrow(() => {
    view.syncFrames([
      { id: 'boom', type: 'BoomThing', content: {} },
      frame('after', 'later frame text'),
    ], boomState());
  });

  assert.match(view.textContent, /later frame text/, 'the frame after the failure must still render');
  assert.equal(view.querySelectorAll('kikx-frame-item[data-frame-id="after"]').length, 1);
});

test('a throwing chat-view sync does not escape syncFrameThread', () => {
  let app = {
    _state: {
      selectedSessionID: 's1',
      sessionIDs: [ 's1' ],
      sessionDetailsByID: { s1: { id: 's1' } },
      framesBySessionID: { s1: [ frame('f1', 'one') ] },
      sessionPagingByID: {},
    },
    _frameListAnchoredToBottom: false,
  };
  let body = document.createElement('div');
  body.className = 'kikx-thread__body';
  app.appendChild = body.appendChild.bind(body);
  Object.defineProperty(app, 'querySelector', {
    value: (selector) => (selector === '.kikx-thread__body' ? body : null),
  });

  let view = document.createElement('kikx-chat-view');
  body.appendChild(view);
  view.syncFrames = () => {
    throw new Error('chat-view sync exploded');
  };

  assert.doesNotThrow(() => syncFrameThread(app, 's1', {}));
});

test('a throw during SSE dispatch does not stop later runtime events', () => {
  let state = createSessionStateSnapshot({
    sessionIDs: [ 's1' ],
    sessionDetailsByID: { s1: { id: 's1', title: 'One' } },
    framesBySessionID: { s1: [] },
    sessionPagingByID: {},
  });
  let app = {
    _state: state,
    _syncSessionShell() {
      throw new Error('shell sync exploded');
    },
    _requestRender() {},
  };
  let event = (payload) => ({ type: 'message', data: JSON.stringify(payload) });

  assert.doesNotThrow(() => {
    onRuntimeEvent(app, event({ type: 'session.saved', session: { id: 's1', title: 'One' } }));
  });
  assert.doesNotThrow(() => {
    onRuntimeEvent(app, event({ type: 'tokens.updated', tokenUsage: {}, totalTokensUsed: 7 }));
  });
  assert.equal(state.totalTokensUsed, 7, 'the next runtime event must still be processed');
});

test('a throwing selected-session sync does not stop other sessions from refreshing', () => {
  let state = createSessionStateSnapshot({
    sessionIDs: [ 's1', 's2' ],
    sessionDetailsByID: { s1: { id: 's1' }, s2: { id: 's2' } },
    framesBySessionID: { s1: [], s2: [] },
    sessionPagingByID: {},
  });
  state.selectedSessionID = 's1';
  state.navigationStack = [ { sessionID: null, collapsed: true } ];

  let refreshed = [];
  let app = {
    _state: state,
    _pendingFrameRuntimeEvents: [
      { sessionID: 's1', frame: frame('f1', 'one') },
      { sessionID: 's2', frame: frame('f2', 'two') },
    ],
    _frameRuntimeFlushScheduled: true,
    _syncFrameThread() {
      throw new Error('thread sync exploded');
    },
    _schedulePreviewRefresh(sessionIDs) {
      for (let sessionID of sessionIDs)
        refreshed.push(sessionID);
    },
  };

  assert.doesNotThrow(() => flushFrameRuntimeEvents(app));
  assert.deepEqual(refreshed, [ 's2' ], 'the non-selected session must still refresh');
  assert.equal(app._frameRuntimeFlushScheduled, false);
});

test('a poison runtime-event payload does not drop the rest of the batch', () => {
  clearRecentErrors();
  let state = createSessionStateSnapshot({
    sessionIDs: [ 's1' ],
    sessionDetailsByID: { s1: { id: 's1' } },
    framesBySessionID: { s1: [] },
    sessionPagingByID: {},
  });
  state.selectedSessionID = 's1';

  let poison = { sessionID: 's1' };
  Object.defineProperty(poison, 'frame', {
    get() {
      throw new Error('poison frame getter');
    },
  });

  let app = {
    _state: state,
    _pendingFrameRuntimeEvents: [ poison, { sessionID: 's1', frame: frame('healthy', 'healthy text') } ],
    _frameRuntimeFlushScheduled: true,
    _syncFrameThread() {},
    _schedulePreviewRefresh() {},
  };

  quietConsole(() => assert.doesNotThrow(() => flushFrameRuntimeEvents(app)));

  assert.equal(app._pendingFrameRuntimeEvents.length, 0, 'the queue must be fully drained');
  let storedIDs = state.framesBySessionID.s1.map((entry) => entry.id);
  assert.ok(storedIDs.includes('healthy'), 'the healthy event after the poison must still be applied');
  assert.ok(
    listRecentErrors().some((entry) => entry.label === 'kikx-runtime-events.batchEntry'),
    'the poison entry must be reported, not swallowed',
  );
});

test('a throwing app shell builder keeps the previous DOM in place', () => {
  let app = document.createElement('kikx-app');
  app._buildAuthShell = () => {
    let stub = document.createElement('div');
    stub.className = 'stub-auth-shell';
    stub.textContent = 'auth shell';
    return stub;
  };

  app._render();
  assert.equal(app.querySelectorAll('.stub-auth-shell').length, 1, 'the initial shell must render');

  app._buildAuthShell = () => {
    throw new Error('shell builder exploded');
  };
  assert.doesNotThrow(() => app._render());
  assert.equal(app.querySelectorAll('.stub-auth-shell').length, 1, 'the previous DOM must survive a failed render');
});
