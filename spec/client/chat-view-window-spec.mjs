'use strict';

// The thread state can keep a long history, but the DOM must stay bounded.
// These specs pin the render window: only the newest N frames are materialized,
// scrolling up reveals older frames already in state, and returning to the
// bottom restores the newest window.

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

import { installDom } from './support/mini-dom.mjs';

register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);

const { document } = installDom();
globalThis.document = document;

const { KikxChatView, MAX_RENDERED_FRAMES } = await import('../../src/client/components/kikx-chat-view.mjs');

function frames(count) {
  let output = [];
  for (let index = 0; index < count; index++) {
    output.push({
      id: `frame_${index}`,
      type: 'UserMessage',
      content: { text: `message ${index}` },
    });
  }
  return output;
}

function ids(view) {
  return Array.from(view.querySelectorAll('kikx-frame-item[data-frame-id]'))
    .map((item) => item.dataset.frameId);
}

test('the full thread renders only the newest window and drops older DOM', () => {
  let view = document.createElement('kikx-chat-view');
  view.setFrames(frames(200), {});

  let rendered = ids(view);
  assert.equal(rendered.length, MAX_RENDERED_FRAMES);
  assert.equal(rendered[0], `frame_${200 - MAX_RENDERED_FRAMES}`);
  assert.equal(rendered.at(-1), 'frame_199');
  assert.equal(view.windowStart, 200 - MAX_RENDERED_FRAMES);
});

test('scrolling up reveals older state frames, then the bottom restores the newest window', () => {
  let view = document.createElement('kikx-chat-view');
  view.setFrames(frames(200), {});
  let latestStart = view.windowStart;

  assert.equal(view.expandOlderFrames(), true);
  let older = ids(view);
  assert.equal(older.length, MAX_RENDERED_FRAMES);
  assert.equal(older[0], `frame_${latestStart - 40}`);
  assert.equal(older.includes('frame_199'), false, 'the oldest rendered window no longer holds the newest tail');

  assert.equal(view.expandOlderFrames(10_000), true);
  assert.equal(view.windowStart, 0);
  assert.equal(ids(view)[0], 'frame_0');

  assert.equal(view.showLatestFrames(), true);
  let latest = ids(view);
  assert.equal(latest.at(-1), 'frame_199');
  assert.equal(latest[0], `frame_${200 - MAX_RENDERED_FRAMES}`);
  assert.equal(view.windowStart, 200 - MAX_RENDERED_FRAMES);
});

test('a prepended older page expands the window instead of leaving the new frames hidden', () => {
  let view = document.createElement('kikx-chat-view');
  view.setFrames(frames(80), {});
  let beforeStart = view.windowStart;
  let beforeFirst = ids(view)[0];

  let older = [
    ...frames(20).map((frame) => ({ ...frame, id: `older_${frame.id}` })),
    ...frames(80),
  ];
  view.syncFrames(older, {}, { prepend: true, animate: false });

  let rendered = ids(view);
  assert.equal(rendered.length, MAX_RENDERED_FRAMES);
  assert.equal(rendered[0], 'older_frame_0');
  assert.notEqual(rendered[0], beforeFirst);
  assert.equal(view.windowStart, Math.max(0, beforeStart - 20));
});

test('the view exposes a bounded latest window even when state is small', () => {
  let view = document.createElement('kikx-chat-view');
  view.setFrames(frames(10), {});
  assert.deepEqual(ids(view), frames(10).map((frame) => frame.id));
  assert.equal(view.windowStart, 0);
  assert.equal(view.expandOlderFrames(), false);
  assert.equal(view.showLatestFrames(), false);
});
