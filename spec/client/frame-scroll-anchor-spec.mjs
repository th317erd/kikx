'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { captureFrameListAnchor, restoreFrameListAnchor } from '../../src/client/components/frame-scroll-anchor.mjs';

function listWith(items, { top = 100, scrollTop = 0, scrollHeight = 2000, clientHeight = 600 } = {}) {
  return {
    scrollTop,
    scrollHeight,
    clientHeight,
    getBoundingClientRect() { return { top }; },
    querySelectorAll() { return items; },
  };
}

function item(frameID, top, bottom = top + 100) {
  return {
    dataset: { frameId: frameID },
    getBoundingClientRect() { return { top, bottom }; },
  };
}

test('capture names the top-visible frame and its signed offset', () => {
  let list = listWith([
    item('above', -200, -20),
    item('anchor', 90, 190),
    item('below', 220, 320),
  ], { top: 100, scrollTop: 800 });

  assert.deepEqual(captureFrameListAnchor(list), { frameID: 'anchor', offset: -10 });
});

test('restore keeps the same frame at the same visual offset after a prepend', () => {
  let list = listWith([
    item('older_1', 0, 200),
    item('older_2', 200, 400),
    item('anchor', 500, 700),
  ], { top: 100, scrollTop: 0, scrollHeight: 1500 });

  assert.equal(restoreFrameListAnchor(list, { frameID: 'anchor', offset: 0 }), true);
  assert.equal(list.scrollTop, 400);
  assert.equal(list.scrollTop + 500 - 100, 800);

  list = listWith([ item('anchor', 900, 1000) ], { top: 100, scrollTop: 0, scrollHeight: 2000 });
  assert.equal(restoreFrameListAnchor(list, { frameID: 'anchor', offset: -25 }), true);
  assert.equal(list.scrollTop, 825);
});

test('restore reports false when the anchor is outside the current DOM window', () => {
  let list = listWith([ item('other', 100, 200) ]);
  assert.equal(restoreFrameListAnchor(list, { frameID: 'missing', offset: 0 }), false);
});
