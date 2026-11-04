'use strict';

// Expand/collapse is an opt-in affordance, not a default.
//
// The hover toolbar used to build the expand button on EVERY frame while the
// disclosure (`<details>`) only exists on some frames. On a frame with none,
// the button's toggleAll() iterated an empty list — a control the user could
// click forever with zero effect. Frames are polymorphic: a class that renders
// disclosures supplies its button via getQuickActionButtons(), and the frame
// item measures the detached subtree as a fallback. Either way, the button
// ships only when there is something to expand.

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

import { installDom } from './support/mini-dom.mjs';

register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);

const { document } = installDom();
globalThis.document = document;

const {
  buildFrameQuickActions,
  isFrameExpandedState,
  quickActionSpecForFrame,
} = await import('../../src/client/components/kikx-frame-quick-actions.mjs');
await import('../../src/client/components/kikx-frame-item.mjs');

function frameItem() {
  return document.createElement('kikx-frame-item');
}

function click(element) {
  element.dispatchEvent(new Event('click', { bubbles: true, cancelable: true }));
}

test('a frame whose subtree has no disclosures gets no expand button', () => {
  let item = frameItem();
  item.updateFrame(
    { id: 'frame-plain', type: 'AgentMessage', content: { text: 'a plain reply' } },
    {},
  );

  assert.ok(item.querySelector('details') === null, 'a plain reply has nothing to expand');
  assert.ok(item.querySelector('.kikx-frame__quick-action--quote'), 'quote is always available');
  assert.equal(
    item.querySelector('.kikx-frame__quick-action--expand-collapse'),
    null,
    'an expand button with zero disclosures is a dead affordance and must not ship',
  );
});

test('a frame whose class renders disclosures gets an expand button that expands', () => {
  let item = frameItem();
  item.updateFrame(
    { id: 'frame-user', type: 'UserMessage', content: { text: 'hello' } },
    {},
  );

  let details = item.querySelector('details.kikx-user-message__prompt');
  assert.ok(details, 'the user-message component renders its prompt disclosure');

  let expand = item.querySelector('.kikx-frame__quick-action--expand-collapse');
  assert.ok(expand, 'a frame with disclosures gets the expand button');

  click(expand);
  assert.equal(details.open, true, 'clicking the hover button opens the disclosure');
  assert.ok(isFrameExpandedState(item), 'the icon sync sees the expanded state');

  click(expand);
  assert.equal(details.open, false, 'a second click collapses it again');
});

test('a compact tool frame keeps the button and toggles its compact disclosure', () => {
  let item = frameItem();
  item.updateFrame(
    { id: 'frame-tool', type: 'ToolCall', content: { toolName: 'exec', text: 'ran a command' } },
    {},
  );

  let details = item.querySelector('details.kikx-frame__compact');
  assert.ok(details, 'the compact disclosure exists');

  let expand = item.querySelector('.kikx-frame__quick-action--expand-collapse');
  assert.ok(expand, 'compact frames measure their disclosure and get the button');

  click(expand);
  assert.equal(details.open, true, 'the button opens the compact disclosure');
});

test('quickActionSpecForFrame resolves declared buttons over the measured fallback', () => {
  // A frame class's declaration is authoritative in both directions.
  assert.deepEqual(
    quickActionSpecForFrame({ getQuickActionButtons: () => ({ expand: true }) }, false),
    { quote: true, expand: true },
    'declared can-expand wins even when the build-time probe found no details (lazy content)',
  );
  assert.deepEqual(
    quickActionSpecForFrame({ getQuickActionButtons: () => ({ expand: false }) }, true),
    { quote: true, expand: false },
    'a frame may decline the button even with disclosures present',
  );
  assert.deepEqual(
    quickActionSpecForFrame({ getQuickActionButtons: () => ({ quote: false }) }, false),
    { quote: false, expand: false },
  );

  // No declaration: the measured subtree decides.
  assert.deepEqual(quickActionSpecForFrame({}, false), { quote: true, expand: false });
  assert.deepEqual(quickActionSpecForFrame({}, true), { quote: true, expand: true });
  assert.deepEqual(
    quickActionSpecForFrame({ getQuickActionButtons: () => null }, true),
    { quote: true, expand: true },
    'a class returning nothing falls back to measurement',
  );
});

test('buildFrameQuickActions builds only the buttons the spec declares', () => {
  let quoteOnly = buildFrameQuickActions({ id: 'frame_x' }, document, { quote: true, expand: false });
  assert.ok(quoteOnly.querySelector('.kikx-frame__quick-action--quote'));
  assert.equal(quoteOnly.querySelector('.kikx-frame__quick-action--expand-collapse'), null);

  let both = buildFrameQuickActions({ id: 'frame_x' }, document, { quote: true, expand: true });
  assert.ok(both.querySelector('.kikx-frame__quick-action--quote'));
  assert.ok(both.querySelector('.kikx-frame__quick-action--expand-collapse'));

  let bare = buildFrameQuickActions({ id: 'frame_x' }, document, { quote: false, expand: false });
  assert.equal(bare.querySelector('button'), null, 'an empty spec yields an empty toolbar');
});
