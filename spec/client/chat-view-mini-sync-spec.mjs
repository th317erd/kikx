'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

import { installDom } from './support/mini-dom.mjs';

register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);

const { document } = installDom();
const { KikxChatView } = await import('../../src/client/components/kikx-chat-view.mjs');

function frame(id) {
  return { id, type: 'AgentMessage', authorType: 'agent', content: { text: id } };
}

function miniView() {
  let scaler = document.createElement('div');
  let stream = document.createElement('div');
  stream.className = 'kikx-frame-stream';
  scaler.appendChild(stream);
  let view = Object.create(KikxChatView.prototype);
  view._mode = 'mini';
  view._frames = [];
  view._appState = {};
  view._miniScaler = scaler;
  view._created = 0;
  view._updated = 0;
  view._createFrameItem = (value) => {
    view._created++;
    let item = document.createElement('kikx-frame-item');
    item.dataset.frameId = value.id;
    item.updateFrame = () => { view._updated++; };
    return item;
  };
  return { view, stream };
}

test('mini preview updates reconcile frame items instead of rebuilding the stream', () => {
  let { view, stream } = miniView();
  let frames = [ frame('a'), frame('b') ];
  view.syncFrames(frames, {}, { animate: false });
  let first = [ ...stream.children ];
  assert.equal(first.length, 2);

  view.syncFrames([ frame('a'), frame('b'), frame('c') ], {}, { animate: false });
  let second = [ ...stream.children ];
  assert.equal(second.length, 3);
  assert.equal(second[0], first[0], 'existing frame item is reused');
  assert.equal(second[1], first[1], 'existing frame item is reused');
  assert.equal(view._created, 3, 'only the new frame was created');
  assert.equal(view._updated, 2, 'existing frames were reconciled in place');

  view.syncFrames([ frame('a'), frame('c') ], {}, { animate: false });
  assert.deepEqual([ ...stream.children ].map((item) => item.dataset.frameId), [ 'a', 'c' ]);
});
