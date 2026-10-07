'use strict';

// Regression: syncFrameThread() rebuilt the empty/thread-less case by calling
// `.build(document)` on the element buildFrameThread() already returned, so
// opening a session with no visible frames threw
// "buildFrameThread(...).build is not a function" and left the thread body
// unreplaced. The rebuild path must swap in the built element itself.

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

import { installDom } from './support/mini-dom.mjs';

register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);

const { document, registry: customElements } = installDom();

class StubChatView extends HTMLElement {
  constructor() {
    super();
    this.mode = 'full';
    this.syncCalls = [];
  }

  update() {}

  syncFrames(frames, appState, options) {
    this.syncCalls.push({ count: frames.length, options });
    return { insertedNew: false };
  }
}
customElements.define('kikx-chat-view', StubChatView);

const { syncFrameThread } = await import('../../src/client/components/kikx-frame-scroll.mjs');

function createApp({ frames = [], extra = {} } = {}) {
  let root = document.createElement('div');
  root.className = 'kikx-app';
  root._state = {
    selectedSessionID: 's1',
    sessionIDs: [ 's1' ],
    sessionDetailsByID: { s1: { id: 's1' } },
    framesBySessionID: { s1: frames },
    sessionPagingByID: {},
    ...extra,
  };
  let body = document.createElement('div');
  body.className = 'kikx-thread__body';
  root.appendChild(body);
  return root;
}

function bodyOf(app) {
  return app.querySelector('.kikx-thread__body');
}

test('an empty selected session rebuilds the thread instead of throwing', () => {
  let app = createApp({ frames: [] });

  assert.doesNotThrow(() => syncFrameThread(app, 's1', {}));
  assert.equal(bodyOf(app).children.length, 1);
  assert.ok(bodyOf(app).firstElementChild.classList.contains('kikx-thread__empty'));
});

test('a thread body with no chat view is rebuilt even when frames exist', () => {
  let app = createApp({ frames: [ { id: 'f1', type: 'UserMessage' } ] });

  assert.doesNotThrow(() => syncFrameThread(app, 's1', {}));
  assert.equal(bodyOf(app).querySelector('kikx-chat-view')?.tagName, 'KIKX-CHAT-VIEW');
});

test('the normal path still syncs frames into the existing chat view', () => {
  let app = createApp({ frames: [ { id: 'f1', type: 'UserMessage' } ] });
  let view = document.createElement('kikx-chat-view');
  bodyOf(app).appendChild(view);

  syncFrameThread(app, 's1', {});

  assert.equal(view.syncCalls.length, 1);
  assert.equal(view.syncCalls[0].count, 1);
  assert.equal(bodyOf(app).children.length, 1, 'the existing view must be reused, not replaced');
});

test('hidden and deleted frames count as no frames', () => {
  let app = createApp({
    frames: [
      { id: 'f1', type: 'UserMessage', deleted: true },
      { id: 'f2', type: 'UserMessage', hidden: true },
    ],
  });

  syncFrameThread(app, 's1', {});

  assert.ok(bodyOf(app).firstElementChild.classList.contains('kikx-thread__empty'));
});

test('syncFrameThread ignores a session that is not selected', () => {
  let app = createApp({ frames: [] });

  syncFrameThread(app, 'other', {});

  assert.equal(bodyOf(app).children.length, 0);
});

test('syncFrameThread is a no-op without a thread body', () => {
  let app = document.createElement('div');
  app._state = { selectedSessionID: 's1', framesBySessionID: { s1: [] } };

  assert.doesNotThrow(() => syncFrameThread(app, 's1', {}));
});
