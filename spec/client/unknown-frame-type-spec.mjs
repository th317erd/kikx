'use strict';

// S4: unknown frame types. The runtime must accept a frame type it has never
// seen (a newer server, a plugin that was removed) and render a safe plain-text
// fallback instead of throwing or blanking the thread.

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

import { installDom } from './support/mini-dom.mjs';

register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);

const { document } = installDom();

await import('../../src/client/components/kikx-frame-item.mjs');

const { createTypedFrame, frameTypeClass } = await import('../../src/core/frames/frame-types/create-typed-frame.mjs');
const { clearRecentErrors, listRecentErrors } = await import('../../src/client/lib/error-boundary.mjs');

const UNKNOWN_TYPE = 'TotallyUnknownFrameType';

test('the core factory falls back to FrameTypeDefault for an unknown type', () => {
  assert.equal(frameTypeClass(UNKNOWN_TYPE, null).name, 'FrameTypeDefault');

  let typed = createTypedFrame({ id: 'x1', type: UNKNOWN_TYPE, content: { text: 'mystery body' } });
  assert.equal(typed.isRenderable(), true, 'an unknown frame must still be renderable');
  assert.equal(typed.toMessage(), 'mystery body');
  assert.equal(typed.getAlignment(), null, 'an unknown frame contributes nothing to the model');
});

test('an unknown frame renders its text rather than throwing', () => {
  clearRecentErrors();
  let item = document.createElement('kikx-frame-item');

  assert.doesNotThrow(() => {
    item.updateFrame({ id: 'x1', type: UNKNOWN_TYPE, content: { text: 'mystery body' } }, {});
  });

  assert.match(item.textContent, /mystery body/);
  assert.equal(item.dataset.frameType, UNKNOWN_TYPE);
  assert.equal(item.dataset.frameId, 'x1');
  assert.deepEqual(listRecentErrors(), [], 'an unknown frame type is not an error');
});

test('an unknown frame with no text falls back to its id', () => {
  let item = document.createElement('kikx-frame-item');
  item.updateFrame({ id: 'x2', type: UNKNOWN_TYPE, content: {} }, {});
  assert.match(item.textContent, /x2/);
});

test('a known frame after an unknown frame still renders', () => {
  clearRecentErrors();
  let item = document.createElement('kikx-frame-item');

  item.updateFrame({ id: 'x1', type: UNKNOWN_TYPE, content: { text: 'first' } }, {});
  assert.doesNotThrow(() => {
    item.updateFrame({ id: 'm1', type: 'AgentMessage', content: { text: 'known message' } }, {}, { force: true });
  });

  assert.match(item.textContent, /known message/);
  assert.equal(item.dataset.frameType, 'AgentMessage');
  assert.deepEqual(listRecentErrors(), []);
});
