'use strict';

// Expansion state for compact frames must survive the DOM being rebuilt.
//
// Reported symptom: "If I expand a frame, the next frame that gets created, and
// it goes back to collapsed all by itself." The cause is structural, not a
// missed assignment: `kikx-frame-item._render()` runs `$(this).empty()` and
// rebuilds a fresh `<details>` disclosure. A `<details>` element is created
// closed, so every rebuild silently collapsed whatever the user had opened.
//
// These specs pin the fix: expansion is model state keyed by frame id, so it
// survives a rebuild, a type change on the same id (ToolCall -> ToolResult is
// the common one), and a rebuilt chat view. The store is deliberately
// asymmetric -- it can only restore something the user opened, never open a
// frame on its own.
//
// NOTE ON THE HARNESS: mini-dom does not implement `<details>` opening
// behaviour, so setting `details.open` does not fire a `toggle` event the way a
// browser does. Every test below dispatches `toggle` explicitly, which is what
// the browser does after the user interacts. A test that set `.open` without
// dispatching would prove nothing about the listener wiring.

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

import { installDom } from './support/mini-dom.mjs';

register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);

const { document, registry: customElements } = installDom();

class RecordingTool extends HTMLElement {
  constructor() {
    super();
    this.frames = [];
  }

  updateFrame(frame) {
    this.frames.push(frame);
  }
}

class StubSessionCard extends HTMLElement {
  update(values) {
    this.values = values;
  }
}

customElements.define('kikx-read-file-use', RecordingTool);
customElements.define('kikx-session-card', StubSessionCard);

await import('../../src/client/components/kikx-frame-item.mjs');
const {
  MAX_TRACKED_FRAME_EXPANSIONS,
  createFrameExpansionStore,
  frameExpansionStore,
  isFrameExpanded,
  setFrameExpanded,
} = await import('../../src/client/state/frame-expansion.mjs');

// A tool frame is the compact shape -- a `details.kikx-frame__compact`
// disclosure -- so it is the kind of row the user expands.
function toolFrame(id, overrides = {}) {
  return {
    id,
    type: 'ToolCall',
    content: { toolName: 'read_file', arguments: '{"path":"/tmp/x"}', status: 'completed' },
    ...overrides,
  };
}

function toolState() {
  return {
    clientToolComponentsByName: {
      read_file: { tagName: 'kikx-read-file-use' },
    },
  };
}

// Mount a frame item with a real parent, because mini-dom only runs
// connectedCallback for elements that are attached to a tree.
function mountItem(frame, appState = toolState()) {
  let host = document.createElement('div');
  document.body.appendChild(host);
  let item = document.createElement('kikx-frame-item');
  item.updateFrame(frame, appState);
  host.appendChild(item);
  return item;
}

function compactDetails(item) {
  return item.querySelector('details.kikx-frame__compact');
}

// Perform what the browser does when the user opens or closes the disclosure.
function setOpen(details, open) {
  details.open = open;
  details.dispatchEvent(new CustomEvent('toggle', { bubbles: false }));
}

test.afterEach(() => {
  frameExpansionStore.clear();
});

test('expanding a frame is remembered in the model, not only in the DOM', () => {
  let item = mountItem(toolFrame('f1'));
  let details = compactDetails(item);
  assert.ok(details, 'a tool frame must render a compact disclosure');
  assert.equal(details.open, false, 'frames start collapsed');

  setOpen(details, true);

  assert.equal(isFrameExpanded('f1'), true, 'the user opening the frame must be recorded');
});

test('a rebuild restores the frame the user had opened', () => {
  let item = mountItem(toolFrame('f1'));
  setOpen(compactDetails(item), true);

  // This is the reported bug: new activity arrives, the item rebuilds, and the
  // disclosure came back closed.
  item.updateFrame(toolFrame('f1'), toolState(), { force: true });

  let details = compactDetails(item);
  assert.ok(details, 'the rebuilt item still renders a compact disclosure');
  assert.equal(details.open, true, 'a rebuild must not collapse a frame the user opened');
});

test('a frame the user never touched stays collapsed across rebuilds', () => {
  let item = mountItem(toolFrame('f2'));
  item.updateFrame(toolFrame('f2'), toolState(), { force: true });

  assert.equal(isFrameExpanded('f2'), false);
  assert.equal(compactDetails(item).open, false, 'the store must never open a frame by itself');
});

test('collapsing a frame is remembered too, so a rebuild does not re-open it', () => {
  let item = mountItem(toolFrame('f3'));
  setOpen(compactDetails(item), true);
  assert.equal(compactDetails(item).open, true);

  setOpen(compactDetails(item), false);
  assert.equal(isFrameExpanded('f3'), false, 'closing must clear the record');

  item.updateFrame(toolFrame('f3'), toolState(), { force: true });
  assert.equal(compactDetails(item).open, false, 'a collapsed frame must stay collapsed');
});

test('expansion survives the ToolCall -> ToolResult type change on the same id', () => {
  let item = mountItem(toolFrame('f4'));
  setOpen(compactDetails(item), true);

  // Type changes while the id is stable. `updateFrame` treats a changed
  // type+id key as a wholesale rebuild, so this path also had to restore.
  item.updateFrame(toolFrame('f4', {
    type: 'ToolResult',
    content: { toolName: 'read_file', status: 'completed', result: 'ok' },
  }), toolState());

  assert.equal(item.dataset.frameType, 'ToolResult');
  assert.equal(compactDetails(item).open, true, 'the row must stay expanded through the transition');
});

test('expansion is per frame id, so one open frame does not open the others', () => {
  let first = mountItem(toolFrame('f5'));
  let second = mountItem(toolFrame('f6'));

  setOpen(compactDetails(first), true);

  assert.equal(compactDetails(first).open, true);
  assert.equal(compactDetails(second).open, false, 'opening one frame must not open another');
  assert.equal(isFrameExpanded('f6'), false);
});

test('the store is bounded and evicts the oldest expansion first', () => {
  let store = createFrameExpansionStore(3);

  store.set('a', true);
  store.set('b', true);
  store.set('c', true);
  store.set('d', true);

  assert.equal(store.size, 3, 'the store must not grow past its bound');
  assert.equal(store.has('a'), false, 'the oldest entry is evicted first');
  assert.equal(store.has('d'), true, 'the newest entry is retained');
  assert.equal(MAX_TRACKED_FRAME_EXPANSIONS, 2000, 'the production bound is 2000 frames');
});

test('re-expanding an id refreshes its recency so it is not evicted', () => {
  let store = createFrameExpansionStore(2);

  store.set('a', true);
  store.set('b', true);
  // Touch `a` again: it is now the most recently expanded and must survive.
  store.set('a', true);
  store.set('c', true);

  assert.equal(store.has('a'), true, 'a re-expanded frame must not be evicted');
  assert.equal(store.has('b'), false, 'the least recently expanded frame is evicted');
});

test('a missing frame id is never recorded', () => {
  let store = createFrameExpansionStore();

  assert.equal(store.set(null, true), false);
  assert.equal(store.set(undefined, true), false);
  assert.equal(store.set('', true), false);
  assert.equal(store.size, 0, 'ids that cannot be restored later must not be stored');
});

test('setFrameExpanded only opens for a literal true, never a truthy value', () => {
  let store = createFrameExpansionStore();

  // Strict `=== true` is deliberate: a stray string from an attribute or a
  // truthy object must not be able to expand a frame. Only what the DOM's
  // `details.open` actually reports (a real boolean) records an expansion.
  assert.equal(setFrameExpanded('x', 'yes', store), false, 'a truthy non-boolean must not expand');
  assert.equal(isFrameExpanded('x', store), false);

  assert.equal(setFrameExpanded('x', true, store), true);
  assert.equal(isFrameExpanded('x', store), true);

  assert.equal(setFrameExpanded('x', false, store), false);
  assert.equal(isFrameExpanded('x', store), false);
});
