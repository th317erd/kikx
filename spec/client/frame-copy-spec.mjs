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

test('copyTextForFrame returns the frame visible text everywhere it exists', () => {
  // Quote-parity coverage: messages, progress, reports, tool rows — the
  // owner's "pretty much everywhere".
  assert.equal(copyTextForFrame(frame('AgentMessage', { text: RAW })), RAW, 'exact raw markdown source, newlines intact');
  assert.equal(copyTextForFrame(frame('AgentMessageDelta', { delta: 'streaming **md**' })), 'streaming **md**');
  assert.equal(
    copyTextForFrame(frame('CompactionFrame', { turnReport: true, summary: 'short visible report' })),
    'short visible report',
    'a collapsed turn report copies what is visible',
  );
  assert.equal(copyTextForFrame(frame('UserMessage', { text: 'hello **world**' })), 'hello **world**');
  assert.equal(copyTextForFrame(frame('AgentProgress', { text: 'still working on the deploy' })), 'still working on the deploy');
  assert.equal(copyTextForFrame(frame('ToolCall', { text: 'ran a command', command: 'ls' })), 'ran a command',
    'tool frames copy too, message-text first');

  // Priority still protects messages from tool noise...
  assert.equal(
    copyTextForFrame(frame('AgentMessage', { text: 'the reply', output: 'stdout noise' })),
    'the reply',
    'a message copies its text, never embedded output',
  );
  // ...and a tool row whose visible content IS its output/command copies that.
  assert.equal(
    copyTextForFrame(frame('ExecReadToolFrame', { output: 'file1 file2', command: 'ls -la' })),
    'file1 file2',
    'output-only tool rows copy their visible content (quote parity)',
  );

  // The only 'makes no sense' case: nothing to copy.
  assert.equal(copyTextForFrame(null), '');
  assert.equal(copyTextForFrame(frame('AgentMessage', {})), '', 'an empty frame gets no button');
  assert.equal(copyTextForFrame(frame('AgentMessage', { status: 'running' })), '', 'non-text status alone copies nothing');
});

test('the spec offers copy everywhere there is visible text to copy', () => {
  assert.equal(quickActionSpecForFrame(frame('AgentMessage', { text: RAW }), false).copy, true);
  assert.equal(quickActionSpecForFrame(frame('AgentProgress', { text: 'streaming status' }), false).copy, true,
    'progress frames are messages people copy');
  assert.equal(quickActionSpecForFrame(frame('ToolCall', { text: 'cmd out' }), true).copy, true,
    'tool rows copy their visible content too (owner: pretty much everywhere)');
  assert.equal(
    quickActionSpecForFrame({
      type: 'AgentMessage',
      content: { text: RAW },
      getQuickActionButtons: () => ({ copy: false }),
    }, false).copy,
    false,
    'a frame class may still decline the button',
  );
  assert.equal(quickActionSpecForFrame({ getQuickActionButtons: () => ({ expand: true }) }, false).copy, false,
    'no content at all, no button — the one makes-no-nonsense exception');
});

test('the rail builds a Copy button on text-bearing frames and none on empty ones', () => {
  let messageBar = buildFrameQuickActions(frame('AgentMessage', { text: RAW }), document);
  assert.ok(messageBar.querySelector('.kikx-frame__quick-action--copy'), 'message frames offer copy');
  assert.ok(messageBar.querySelector('.kikx-frame__quick-action--quote'), 'quote still ships');

  let toolBar = buildFrameQuickActions(frame('ToolCall', { text: 'cmd out' }), document);
  assert.ok(toolBar.querySelector('.kikx-frame__quick-action--copy'),
    'a tool row with visible text gets copy too (owner: pretty much everywhere)');

  let emptyBar = buildFrameQuickActions(frame('AgentMessage', {}), document);
  assert.equal(emptyBar.querySelector('.kikx-frame__quick-action--copy'), null,
    'a frame with nothing to copy gets no dead affordance');
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
