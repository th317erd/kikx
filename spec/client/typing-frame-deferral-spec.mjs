'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

import { installDom } from './support/mini-dom.mjs';

register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);
installDom();
const { flushFrameRuntimeEvents } = await import('../../src/client/components/kikx-runtime-events.mjs');

test('a frame-event flush is deferred while the composer is actively typing', () => {
  let app = {
    isConnected: true,
    _composerTypingUntil: Date.now() + 1000,
    _pendingFrameRuntimeEvents: [ { sessionID: 'ses_1', type: 'frame.added', frame: { id: 'f1' } } ],
    _pendingFrameRuntimeEventKeys: new Map(),
    _frameRuntimeRefreshSessionIDs: new Set(),
  };

  flushFrameRuntimeEvents(app);

  assert.equal(app._pendingFrameRuntimeEvents.length, 1, 'the queue is untouched during typing');
  assert.ok(app._frameRuntimeTypingTimer, 'a post-typing flush was scheduled');
  clearTimeout(app._frameRuntimeTypingTimer);
  app._frameRuntimeTypingTimer = null;
});
