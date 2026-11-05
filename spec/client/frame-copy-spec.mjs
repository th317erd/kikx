'use strict';

// Copy quick action (owner, 2026-11-06): "add a 'Copy' feature to the Quick
// Actions... standard 'double-paper' copy icon... copy the entire frame
// message (the important bits, not command output, and all that nonsense).
// This will copy the raw markdown."
//
// Pinned here:
//   1. copyTextForFrame takes message-shaped frames only (type gate) and
//      returns the RAW markdown — exact text, internal newlines intact;
//      tool/command frames resolve to '' even when a fixture parks command
//      text under `text`;
//   2. the spec/builder pair offers the button only when there is something
//      to copy (no dead affordance);
//   3. clicking writes the raw markdown to the clipboard (legacy fallback
//      returns false when no clipboard exists) and flashes the check glyph.

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

import { installDom } from './support/mini-dom.mjs';

register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);
const { document } = installDom();
globalThis.document = document;

const {
  buildFrameQuickActions,
  copyTextForFrame,
  copyTextToClipboard,
  quickActionSpecForFrame,
} = await import('../../src/client/components/kikx-frame-quick-actions.mjs');

const RAW = '**bold** and _lite_\nsecond line `code`';

function frame(type, content) {
  return { id: 'f1', type, content };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function withClipboard(fn) {
  let writes = [];
  let original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    value: { clipboard: { writeText(text) { writes.push(text); return Promise.resolve(); } } },
    configurable: true,
    writable: true,
  });
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (original)
        Object.defineProperty(globalThis, 'navigator', original);
      else
        delete globalThis.navigator;
    })
    .then(() => writes);
}

test('copyTextForFrame returns the raw markdown of message-shaped frames only', () => {
  assert.equal(copyTextForFrame(frame('AgentMessage', { text: RAW })), RAW, 'exact source, newlines intact');
  assert.equal(copyTextForFrame(frame('AgentMessageDelta', { delta: 'streaming **md**' })), 'streaming **md**', 'a streaming head copies its live delta');
  assert.equal(
    copyTextForFrame(frame('CompactionFrame', { turnReport: true, summary: 'short visible report' })),
    'short visible report',
    'a collapsed turn report copies what is visible',
  );
  assert.equal(copyTextForFrame(frame('UserMessage', { text: 'hello **world**' })), 'hello **world**');

  // The owner's exclusion: command output and tool payloads never copy.
  assert.equal(copyTextForFrame(frame('ToolCall', { text: 'ran a command', command: 'ls' })), '',
    'tool frames are gated by TYPE even with text present');
  assert.equal(copyTextForFrame(frame('ShellToolFrame', { output: 'stdout noise', command: 'ls -la' })), '');
  assert.equal(copyTextForFrame(frame('AgentMessage', { output: 'only output here' })), '', 'no message text, nothing to copy');
  assert.equal(copyTextForFrame(null), '');
  assert.equal(copyTextForFrame(frame('AgentMessage', {})), '');
});

test('the spec offers copy only when there is message markdown to copy', () => {
  assert.equal(quickActionSpecForFrame(frame('AgentMessage', { text: RAW }), false).copy, true);
  assert.equal(quickActionSpecForFrame(frame('ToolCall', { text: 'cmd' }), true).copy, false,
    'a tool frame never gets the button');
  assert.equal(
    quickActionSpecForFrame({
      type: 'AgentMessage',
      content: { text: RAW },
      getQuickActionButtons: () => ({ copy: false }),
    }, false).copy,
    false,
    'a frame class may decline the button',
  );
  assert.equal(quickActionSpecForFrame({ getQuickActionButtons: () => ({ expand: true }) }, false).copy, false,
    'no content, no button');
});

test('the rail builds a Copy button for messages and none for tools', () => {
  let messageBar = buildFrameQuickActions(frame('AgentMessage', { text: RAW }), document);
  assert.ok(messageBar.querySelector('.kikx-frame__quick-action--copy'), 'message frames offer copy');
  assert.ok(messageBar.querySelector('.kikx-frame__quick-action--quote'), 'quote still ships');

  let toolBar = buildFrameQuickActions(frame('ToolCall', { text: 'cmd out' }), document);
  assert.equal(toolBar.querySelector('.kikx-frame__quick-action--copy'), null,
    'no copy button where copying would copy command noise');
});

test('clicking Copy writes the raw markdown and flashes the check glyph', async () => {
  let writes = [];
  let original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    value: { clipboard: { writeText(text) { writes.push(text); return Promise.resolve(); } } },
    configurable: true,
    writable: true,
  });
  try {
    let bar = buildFrameQuickActions(frame('AgentMessage', { text: RAW }), document);
    let copy = bar.querySelector('.kikx-frame__quick-action--copy');
    assert.ok(copy, 'button exists');
    assert.equal(copy.querySelector('svg')?.dataset?.icon ?? copy.dataset.icon, 'copy',
      'the double-paper icon renders (svg dataset or fallback host)');

    copy.dispatchEvent(new Event('click', { bubbles: true, cancelable: true }));
    await sleep(20);
    assert.deepEqual(writes, [ RAW ], 'the clipboard received the exact raw markdown');
    assert.equal(copy.title, 'Copied!', 'success feedback title');
    assert.ok(
      copy.querySelector('svg')?.dataset?.icon === 'check',
      `the glyph flips to a check, got ${copy.querySelector('svg')?.dataset?.icon}`,
    );

    // ...and it returns to the copy icon after the beat.
    await sleep(1500);
    assert.equal(copy.querySelector('svg')?.dataset?.icon, 'copy', 'the glyph returns to the double-paper icon');
    assert.equal(copy.title, 'Copy message');
  } finally {
    if (original)
      Object.defineProperty(globalThis, 'navigator', original);
    else
      delete globalThis.navigator;
  }
});

test('copyTextToClipboard reports failure when no clipboard API works', async () => {
  let original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true });
  try {
    let document_exec = document.execCommand;
    try { delete document.execCommand; } catch (_e) { document.execCommand = undefined; }
    assert.equal(await copyTextToClipboard(RAW), false, 'no API, no false success');
    assert.equal(await copyTextToClipboard(''), false, 'empty text never claims success');
    if (document_exec)
      document.execCommand = document_exec;
  } finally {
    if (original)
      Object.defineProperty(globalThis, 'navigator', original);
    else
      delete globalThis.navigator;
  }
});
