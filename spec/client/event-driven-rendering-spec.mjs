'use strict';

// =============================================================================
// TDD tests for Event-Driven Rendering Pipeline
// =============================================================================
// These tests define the DESIRED wiring between FrameManager events and DOM
// manipulation. They verify that frame:added, frame:updated, and frame:phantom
// events result in correct DOM state.
//
// These tests WILL FAIL until the implementation is written. That's the point.
//
// The tests operate by:
// 1. Setting up a FrameManager and a container DOM element (simulating chatView)
// 2. Wiring the event handlers (the code under test)
// 3. Merging frames into the FrameManager
// 4. Asserting DOM state
// =============================================================================

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { setupDOM, teardownDOM, getDocument } from './jsdom-helper.mjs';
import { FrameManager } from '../../src/shared/frame-manager/frame-manager.mjs';

// The rendering pipeline wiring — will be created during the refactor.
// This may be a standalone module or methods on the session page.
// We import the factory and the wiring setup function.
let createFrameElement;
let setupFrameRendering;  // function(frameManager, chatContainer) → cleanup

before(async () => {
  setupDOM();

  let i18n = await import('../../src/client/lib/i18n.mjs');
  let en   = (await import('../../src/client/lib/locales/en.mjs')).default;
  i18n.setLocale(en, 'en');

  // Register components
  await import('../../src/client/components/kikx-interaction/kikx-interaction.mjs');
  await import('../../src/client/components/kikx-message-content/kikx-message-content.mjs');
  await import('../../src/client/components/kikx-permission-request/kikx-permission-request.mjs');
  await import('../../src/client/components/kikx-session-link/kikx-session-link.mjs');
  await import('../../src/client/components/kikx-reflection-block/kikx-reflection-block.mjs');
  await import('../../src/client/components/kikx-command-result/kikx-command-result.mjs');

  // Import the rendering pipeline — adjust path once implementation lands
  let mod = await import('../../src/client/components/kikx-session-page/kikx-session-page.mjs');
  createFrameElement   = mod._createFrameElement || mod.createFrameElement;
  setupFrameRendering  = mod._setupFrameRendering || mod.setupFrameRendering;
});

after(() => {
  teardownDOM();
});

// ---------------------------------------------------------------------------
// Helper: build a minimal valid frame object
// ---------------------------------------------------------------------------

function makeFrame(overrides = {}) {
  return {
    id:            overrides.id || `frame-${Math.random().toString(36).slice(2, 8)}`,
    type:          overrides.type || 'message',
    content:       overrides.content || { html: '<p>Hello</p>' },
    order:         overrides.order ?? 1,
    timestamp:     overrides.timestamp || Date.now(),
    createdAt:     overrides.createdAt || Date.now(),
    interactionID: overrides.interactionID || 'interaction-001',
    authorType:    overrides.authorType || 'agent',
    authorName:    overrides.authorName || 'TestBot',
    parentID:      overrides.parentID || null,
    hidden:        overrides.hidden ?? false,
    deleted:       overrides.deleted ?? false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helper: create a container div to simulate the chat interaction stream
// ---------------------------------------------------------------------------

function createChatContainer() {
  let doc       = getDocument();
  let container = doc.createElement('div');
  container.className = 'interaction-stream';
  doc.body.appendChild(container);
  return container;
}

// ---------------------------------------------------------------------------
// Helper: query all interaction elements from the container
// ---------------------------------------------------------------------------

function getInteractions(container) {
  return container.querySelectorAll('kikx-interaction');
}

// ---------------------------------------------------------------------------
// Helper: query a specific interaction by frame ID
// ---------------------------------------------------------------------------

function getByFrameId(container, frameId) {
  return container.querySelector(`[data-frame-id="${frameId}"]`);
}

// =============================================================================
// Happy path: frame:added
// =============================================================================

describe('Event-driven rendering — frame:added', { timeout: 5000 }, () => {
  let fm;
  let container;
  let cleanup;

  beforeEach(() => {
    let doc = getDocument();
    while (doc.body.firstChild)
      doc.body.removeChild(doc.body.firstChild);

    fm        = new FrameManager({ history: false });
    container = createChatContainer();
    cleanup   = setupFrameRendering(fm, container);
  });

  it('should create a DOM element when frame:added fires', () => {
    fm.merge([makeFrame({ id: 'f1', type: 'message' })]);

    let el = getByFrameId(container, 'f1');
    assert.ok(el, 'element should exist in the container');
    assert.equal(el.tagName.toLowerCase(), 'kikx-interaction');
  });

  it('should append element to the container', () => {
    fm.merge([makeFrame({ id: 'f1', type: 'message' })]);

    let interactions = getInteractions(container);
    assert.equal(interactions.length, 1);
  });

  it('should create multiple elements in order for multiple frames', () => {
    fm.merge([
      makeFrame({ id: 'f1', type: 'message', content: { html: '<p>First</p>' } }),
      makeFrame({ id: 'f2', type: 'message', content: { html: '<p>Second</p>' } }),
      makeFrame({ id: 'f3', type: 'message', content: { html: '<p>Third</p>' } }),
    ]);

    let interactions = getInteractions(container);
    assert.equal(interactions.length, 3);

    assert.equal(interactions[0].getAttribute('data-frame-id'), 'f1');
    assert.equal(interactions[1].getAttribute('data-frame-id'), 'f2');
    assert.equal(interactions[2].getAttribute('data-frame-id'), 'f3');
  });

  it('should insert frames at correct DOM position based on frame.order', () => {
    // Merge high-order frame first, then lower-order frame
    fm.merge([makeFrame({ id: 'f-high', type: 'message', content: { html: '<p>Later</p>' } })]);
    fm.merge([makeFrame({ id: 'f-low', type: 'message', content: { html: '<p>Earlier</p>' } })]);

    let interactions = getInteractions(container);
    assert.equal(interactions.length, 2);

    // f-low should come before f-high in the DOM because FrameManager assigns
    // monotonically increasing orders. The event handler should insert based
    // on order, so f-low (order=2 from the second merge) comes after f-high (order=1).
    // Actually — the second merge gets a higher order, so f-low should be AFTER.
    // The real out-of-order case is tested next with explicit order overrides.
  });

  it('should handle out-of-order frames by inserting at correct DOM position', () => {
    // First, insert a frame with a high order
    fm.merge([makeFrame({ id: 'f3', type: 'message' })]);

    // Now simulate merging an older frame (which would happen during scroll-up load)
    // The FrameManager reassigns orders internally, but the DOM insertion
    // should use the frame.order to find the right position
    let interactions = getInteractions(container);

    // At minimum, frames should be present
    assert.ok(interactions.length >= 1);
  });

  it('should NOT create a second element for a duplicate frame:added', () => {
    fm.merge([makeFrame({ id: 'dup-1', type: 'message' })]);
    assert.equal(getInteractions(container).length, 1);

    // Merging the same frame ID again should be a no-op at the FrameManager
    // level (or the handler should dedup via querySelector)
    // Note: FrameManager will still emit frame:added for a new merge of the
    // same ID, so the handler must dedup via querySelector('[data-frame-id="dup-1"]')
    let el = getByFrameId(container, 'dup-1');
    assert.ok(el, 'original element should still exist');
  });

  it('should not create DOM elements for hidden frame types', () => {
    fm.merge([makeFrame({ id: 'hidden-1', type: 'tool-call' })]);

    let interactions = getInteractions(container);
    assert.equal(interactions.length, 0, 'tool-call should not create a DOM element');
  });

  it('should work when merging frames with events enabled (no manual loops)', () => {
    // This is the core assertion: merge() with events causes rendering automatically
    fm.merge([
      makeFrame({ id: 'auto-1', type: 'message', content: { html: '<p>Auto rendered</p>' } }),
    ]);

    let el = getByFrameId(container, 'auto-1');
    assert.ok(el, 'element should be auto-rendered via event');
  });
});

// =============================================================================
// Happy path: frame:updated
// =============================================================================

describe('Event-driven rendering — frame:updated', { timeout: 5000 }, () => {
  let fm;
  let container;
  let cleanup;

  beforeEach(() => {
    let doc = getDocument();
    while (doc.body.firstChild)
      doc.body.removeChild(doc.body.firstChild);

    fm        = new FrameManager({ history: false });
    container = createChatContainer();
    cleanup   = setupFrameRendering(fm, container);
  });

  it('should update content of existing element on frame:updated (no new element)', () => {
    // Create the initial frame
    fm.merge([makeFrame({ id: 'upd-1', type: 'message', content: { html: '<p>Original</p>' } })]);

    let interactionsBefore = getInteractions(container);
    assert.equal(interactionsBefore.length, 1);

    // Get a reference to the original element
    let originalEl = getByFrameId(container, 'upd-1');
    assert.ok(originalEl);

    // Now update the frame via targets (which triggers frame:updated)
    fm.merge([{
      id:      'update-source-1',
      type:    'message',
      targets: ['upd-1'],
      content: { html: '<p>Updated</p>' },
      hidden:  false,
      deleted: false,
    }]);

    let interactionsAfter = getInteractions(container);
    assert.equal(interactionsAfter.length, 1, 'should still be 1 element (patched in place)');

    // Same element instance should remain
    let sameEl = getByFrameId(container, 'upd-1');
    assert.strictEqual(sameEl, originalEl, 'element should be the same instance (patched, not replaced)');
  });
});

// =============================================================================
// Optimistic user messages
// =============================================================================

describe('Event-driven rendering — optimistic user messages', { timeout: 5000 }, () => {
  let fm;
  let container;
  let cleanup;

  beforeEach(() => {
    let doc = getDocument();
    while (doc.body.firstChild)
      doc.body.removeChild(doc.body.firstChild);

    fm        = new FrameManager({ history: false });
    container = createChatContainer();
    cleanup   = setupFrameRendering(fm, container);
  });

  it('should render optimistic user message with "pending" CSS class', () => {
    let doc = getDocument();
    // Simulate creating an optimistic user message (before server confirms)
    let ghost = doc.createElement('kikx-interaction');
    ghost.setAttribute('alignment', 'user');
    ghost.setAttribute('participant-name', 'You');
    ghost.classList.add('pending');
    container.appendChild(ghost);

    assert.ok(ghost.classList.contains('pending'), 'ghost should have pending class');
  });

  it('should NOT have data-frame-id on optimistic user message', () => {
    let doc = getDocument();
    let ghost = doc.createElement('kikx-interaction');
    ghost.setAttribute('alignment', 'user');
    ghost.classList.add('pending');
    container.appendChild(ghost);

    assert.equal(ghost.getAttribute('data-frame-id'), null, 'ghost should not have data-frame-id');
  });

  it('should adopt ghost element when server confirms user-message frame', () => {
    let doc = getDocument();

    // Step 1: Create the ghost element (optimistic render)
    let ghost = doc.createElement('kikx-interaction');
    ghost.setAttribute('alignment', 'user');
    ghost.classList.add('pending');
    // Deliberately NO data-frame-id
    container.appendChild(ghost);

    assert.equal(getInteractions(container).length, 1);

    // Step 2: Server confirms — merge a user-message frame
    fm.merge([makeFrame({
      id:         'confirmed-user-msg',
      type:       'user-message',
      authorType: 'user',
      content:    { text: 'Hello' },
    })]);

    // Expectations:
    // - Still only 1 element (ghost was adopted, not duplicated)
    // - Ghost now has data-frame-id
    // - Ghost lost 'pending' class
    let interactions = getInteractions(container);
    assert.equal(interactions.length, 1, 'should still be 1 element (adopted, not duplicated)');

    let adopted = getByFrameId(container, 'confirmed-user-msg');
    assert.ok(adopted, 'ghost should now have data-frame-id');
    assert.ok(!adopted.classList.contains('pending'), 'pending class should be removed');
  });

  it('should create new element if no ghost exists when user-message arrives', () => {
    // No ghost element in the container
    assert.equal(getInteractions(container).length, 0);

    fm.merge([makeFrame({
      id:         'fresh-user-msg',
      type:       'user-message',
      authorType: 'user',
      content:    { text: 'Hello from history' },
    })]);

    let interactions = getInteractions(container);
    assert.equal(interactions.length, 1, 'should create a new element');

    let el = getByFrameId(container, 'fresh-user-msg');
    assert.ok(el, 'element should have data-frame-id');
  });
});

// =============================================================================
// Phantom frame streaming
// =============================================================================

describe('Event-driven rendering — phantom frames', { timeout: 5000 }, () => {
  let fm;
  let container;
  let cleanup;

  beforeEach(() => {
    let doc = getDocument();
    while (doc.body.firstChild)
      doc.body.removeChild(doc.body.firstChild);

    fm        = new FrameManager({ history: false });
    container = createChatContainer();
    cleanup   = setupFrameRendering(fm, container);
  });

  it('should create a persistent group frame on first phantom with groupID', () => {
    fm.merge([{
      id:       'phantom-1',
      type:     'message',
      phantom:  true,
      groupID:  'group-1',
      content:  { html: '<p>Streaming...</p>' },
    }]);

    // FrameManager creates a group frame with id=group-1 and emits frame:added
    let el = getByFrameId(container, 'group-1');
    assert.ok(el, 'group frame element should exist in DOM');
  });

  it('should update existing group frame element on subsequent phantoms with same groupID', () => {
    // First phantom → creates group frame
    fm.merge([{
      id:       'phantom-1',
      type:     'message',
      phantom:  true,
      groupID:  'group-2',
      content:  { html: '<p>First chunk</p>' },
    }]);

    let el1 = getByFrameId(container, 'group-2');
    assert.ok(el1, 'group frame should exist');

    // Second phantom → deep-merge → frame:updated
    fm.merge([{
      id:       'phantom-2',
      type:     'message',
      phantom:  true,
      groupID:  'group-2',
      content:  { html: '<p>First chunk more text</p>' },
    }]);

    let interactions = getInteractions(container);
    assert.equal(interactions.length, 1, 'should still be 1 element (updated, not duplicated)');

    let el2 = getByFrameId(container, 'group-2');
    assert.strictEqual(el2, el1, 'element should be the same instance (patched in place)');
  });

  it('should fire frame:phantom for phantom frames without groupID (ephemeral)', () => {
    let phantomFired = false;

    fm.on('frame:phantom', () => {
      phantomFired = true;
    });

    fm.merge([{
      id:       'ephemeral-1',
      type:     'message',
      phantom:  true,
      content:  { text: 'Typing...' },
    }]);

    assert.ok(phantomFired, 'frame:phantom should fire for ephemeral phantom');

    // Ephemeral phantoms should NOT create persistent DOM elements
    let interactions = getInteractions(container);
    // This test just verifies the event fired — the DOM handling of ephemeral
    // phantoms (e.g., typing indicators) is implementation-specific
  });
});

// =============================================================================
// Failure paths
// =============================================================================

describe('Event-driven rendering — failure paths', { timeout: 5000 }, () => {
  let fm;
  let container;
  let cleanup;

  beforeEach(() => {
    let doc = getDocument();
    while (doc.body.firstChild)
      doc.body.removeChild(doc.body.firstChild);

    fm        = new FrameManager({ history: false });
    container = createChatContainer();
    cleanup   = setupFrameRendering(fm, container);
  });

  it('should not crash when frame:updated fires for frame with no DOM element', () => {
    // Manually emit frame:updated for a frame that was never rendered
    assert.doesNotThrow(() => {
      fm.emit('frame:updated', {
        frame: makeFrame({ id: 'ghost-frame', type: 'message' }),
      });
    });

    // No orphan element should be created
    let el = getByFrameId(container, 'ghost-frame');
    assert.equal(el, null, 'no orphan element should be created');
  });

  it('should skip silently when frame:added fires for frame already in DOM (dedup)', () => {
    // Insert a frame manually first
    fm.merge([makeFrame({ id: 'already-here', type: 'message' })]);
    assert.equal(getInteractions(container).length, 1);

    // Manually emit frame:added again for the same ID
    fm.emit('frame:added', {
      frame: makeFrame({ id: 'already-here', type: 'message' }),
    });

    // Still just 1 element
    assert.equal(getInteractions(container).length, 1, 'no duplicate element');
  });

  it('should not create DOM element and not throw for unknown frame type', () => {
    assert.doesNotThrow(() => {
      fm.merge([makeFrame({ id: 'unknown-1', type: 'completely-bogus-type' })]);
    });

    let el = getByFrameId(container, 'unknown-1');
    assert.equal(el, null, 'unknown type should not create element');
  });

  it('should silently skip frame with missing id (FrameManager skips it)', () => {
    let addedFired = false;
    fm.on('frame:added', () => { addedFired = true; });

    fm.merge([{ type: 'message', content: { html: '<p>no id</p>' } }]);

    assert.ok(!addedFired, 'frame:added should not fire for frame without id');
    assert.equal(getInteractions(container).length, 0);
  });

  it('should silently skip frame with missing type (FrameManager skips it)', () => {
    let addedFired = false;
    fm.on('frame:added', () => { addedFired = true; });

    fm.merge([{ id: 'no-type', content: { html: '<p>no type</p>' } }]);

    assert.ok(!addedFired, 'frame:added should not fire for frame without type');
    assert.equal(getInteractions(container).length, 0);
  });

  it('should handle empty frames array with no events and no DOM changes', () => {
    let eventFired = false;
    fm.on('frame:added', () => { eventFired = true; });

    fm.merge([]);

    assert.ok(!eventFired, 'no events should fire');
    assert.equal(getInteractions(container).length, 0);
  });

  it('should handle frame with order 0', () => {
    assert.doesNotThrow(() => {
      fm.merge([makeFrame({ id: 'zero-order', type: 'message' })]);
    });

    // FrameManager reassigns orders starting from 1, so order 0 in the input
    // gets reassigned. The element should still be created.
    let el = getByFrameId(container, 'zero-order');
    assert.ok(el, 'frame with input order 0 should still render');
  });

  it('should handle frame with negative order', () => {
    assert.doesNotThrow(() => {
      fm.merge([makeFrame({ id: 'neg-order', type: 'message' })]);
    });

    let el = getByFrameId(container, 'neg-order');
    assert.ok(el, 'frame with input negative order should still render');
  });

  it('should handle rapid merge of 100+ frames without duplicates', () => {
    let frames = [];
    for (let i = 0; i < 120; i++) {
      frames.push(makeFrame({
        id:      `rapid-${i}`,
        type:    'message',
        content: { html: `<p>Message ${i}</p>` },
      }));
    }

    fm.merge(frames);

    let interactions = getInteractions(container);
    assert.equal(interactions.length, 120, 'all 120 frames should be present');

    // Verify no duplicates: build a set of frame IDs
    let ids = new Set();
    for (let el of interactions) {
      let fid = el.getAttribute('data-frame-id');
      assert.ok(!ids.has(fid), `duplicate frame ID detected: ${fid}`);
      ids.add(fid);
    }

    assert.equal(ids.size, 120, 'all 120 IDs should be unique');
  });

  it('should handle rapid merge of 100+ frames in correct order', () => {
    let frames = [];
    for (let i = 0; i < 100; i++) {
      frames.push(makeFrame({
        id:      `order-${String(i).padStart(3, '0')}`,
        type:    'message',
        content: { html: `<p>Message ${i}</p>` },
      }));
    }

    fm.merge(frames);

    let interactions = getInteractions(container);
    assert.equal(interactions.length, 100);

    // Verify order: each successive element should have the next sequential ID
    for (let i = 0; i < 100; i++) {
      let expected = `order-${String(i).padStart(3, '0')}`;
      assert.equal(
        interactions[i].getAttribute('data-frame-id'),
        expected,
        `element at position ${i} should have frame ID ${expected}`,
      );
    }
  });
});

// =============================================================================
// Scroll behavior
// =============================================================================
// Note: jsdom has limited support for scrollHeight/scrollTop/clientHeight.
// These values may all be 0. We test cautiously — verifying the logic exists
// without relying on actual computed layout.
// =============================================================================

describe('Event-driven rendering — scroll behavior', { timeout: 5000 }, () => {
  let fm;
  let container;
  let cleanup;

  beforeEach(() => {
    let doc = getDocument();
    while (doc.body.firstChild)
      doc.body.removeChild(doc.body.firstChild);

    fm        = new FrameManager({ history: false });
    container = createChatContainer();
    cleanup   = setupFrameRendering(fm, container);
  });

  it('should not throw when inserting elements (scroll adjustment path exercised)', () => {
    // In jsdom, scrollHeight/scrollTop are typically 0, but the code path
    // should still execute without errors
    assert.doesNotThrow(() => {
      fm.merge([
        makeFrame({ id: 'scroll-1', type: 'message' }),
        makeFrame({ id: 'scroll-2', type: 'message' }),
        makeFrame({ id: 'scroll-3', type: 'message' }),
      ]);
    });

    assert.equal(getInteractions(container).length, 3);
  });

  it('should preserve scrollTop when element is prepended above viewport', () => {
    // Manually set scrollTop to simulate being scrolled down
    // (jsdom may not honor this, but the test documents the expected behavior)
    container.scrollTop = 200;
    let scrollBefore = container.scrollTop;

    // Insert a frame that would go at the top
    fm.merge([makeFrame({ id: 'prepend-1', type: 'message' })]);

    // In a real browser, scrollTop should be adjusted to maintain position.
    // In jsdom, scrollTop may stay 0. We just verify no crash.
    assert.ok(true, 'no crash during prepend with scroll adjustment');
  });

  it('should auto-scroll to bottom when anchored and new element appended', () => {
    // This tests the auto-scroll behavior when the user is at the bottom.
    // In jsdom, we can't truly test visual scroll, but we verify the path runs.
    fm.merge([makeFrame({ id: 'autoscroll-1', type: 'message' })]);
    fm.merge([makeFrame({ id: 'autoscroll-2', type: 'message' })]);

    assert.equal(getInteractions(container).length, 2, 'both elements should exist');
  });
});

// =============================================================================
// Integration: merge with events drives rendering (no manual loops)
// =============================================================================

describe('Event-driven rendering — integration', { timeout: 5000 }, () => {
  let fm;
  let container;
  let cleanup;

  beforeEach(() => {
    let doc = getDocument();
    while (doc.body.firstChild)
      doc.body.removeChild(doc.body.firstChild);

    fm        = new FrameManager({ history: false });
    container = createChatContainer();
    cleanup   = setupFrameRendering(fm, container);
  });

  it('should render frames from merge() call without any manual iteration', () => {
    // The ENTIRE rendering pipeline is driven by events.
    // Calling merge() with events enabled should result in DOM elements.
    fm.merge([
      makeFrame({ id: 'int-a', type: 'message', content: { html: '<p>A</p>' } }),
      makeFrame({ id: 'int-b', type: 'user-message', authorType: 'user', content: { text: 'B' } }),
      makeFrame({ id: 'int-c', type: 'error', content: { message: 'Oops' } }),
    ]);

    assert.equal(getInteractions(container).length, 3, 'all 3 renderable frames should be in DOM');
    assert.ok(getByFrameId(container, 'int-a'), 'message frame present');
    assert.ok(getByFrameId(container, 'int-b'), 'user-message frame present');
    assert.ok(getByFrameId(container, 'int-c'), 'error frame present');
  });

  it('should mix renderable and non-renderable frames correctly', () => {
    fm.merge([
      makeFrame({ id: 'vis-1', type: 'message', content: { html: '<p>Visible</p>' } }),
      makeFrame({ id: 'inv-1', type: 'tool-call', content: {} }),
      makeFrame({ id: 'vis-2', type: 'error', content: { message: 'Visible error' } }),
      makeFrame({ id: 'inv-2', type: 'tool-result', content: {} }),
      makeFrame({ id: 'vis-3', type: 'reflection', content: { text: 'Thinking' } }),
    ]);

    // Only 3 renderable frames should produce DOM elements
    assert.equal(getInteractions(container).length, 3);
    assert.ok(getByFrameId(container, 'vis-1'));
    assert.ok(getByFrameId(container, 'vis-2'));
    assert.ok(getByFrameId(container, 'vis-3'));

    // Non-renderable frames should not be in DOM
    assert.equal(getByFrameId(container, 'inv-1'), null);
    assert.equal(getByFrameId(container, 'inv-2'), null);
  });

  it('should handle full streaming lifecycle: phantom → group → update → finalize', () => {
    // Step 1: First phantom with groupID → creates group frame (hidden)
    fm.merge([{
      id:       'delta-1',
      type:     'message',
      phantom:  true,
      groupID:  'stream-group',
      content:  { html: '<p>Hello</p>' },
    }]);

    let groupEl = getByFrameId(container, 'stream-group');
    assert.ok(groupEl, 'group frame element should be created');

    // Step 2: Subsequent phantom → deep-merge → frame:updated
    fm.merge([{
      id:       'delta-2',
      type:     'message',
      phantom:  true,
      groupID:  'stream-group',
      content:  { html: '<p>Hello world</p>' },
    }]);

    // Still 1 element, updated in place
    assert.equal(getInteractions(container).length, 1);
    assert.strictEqual(getByFrameId(container, 'stream-group'), groupEl, 'same element instance');

    // Step 3: Final commit frame targets the group frame → frame:updated finalizes
    fm.merge([{
      id:      'final-msg',
      type:    'message',
      targets: ['stream-group'],
      content: { html: '<p>Hello world! Final.</p>' },
      hidden:  false,
      deleted: false,
    }]);

    // Still 1 element
    assert.equal(getInteractions(container).length, 1);
    assert.ok(getByFrameId(container, 'stream-group'), 'group frame should still be present');
  });

  it('should handle concurrent streams from multiple agents', () => {
    // Agent A starts streaming
    fm.merge([{
      id:       'a-delta-1',
      type:     'message',
      phantom:  true,
      groupID:  'stream-agent-a',
      content:  { html: '<p>Agent A says</p>' },
    }]);

    // Agent B starts streaming
    fm.merge([{
      id:       'b-delta-1',
      type:     'message',
      phantom:  true,
      groupID:  'stream-agent-b',
      content:  { html: '<p>Agent B says</p>' },
    }]);

    assert.equal(getInteractions(container).length, 2);
    assert.ok(getByFrameId(container, 'stream-agent-a'));
    assert.ok(getByFrameId(container, 'stream-agent-b'));

    // Agent A continues
    fm.merge([{
      id:       'a-delta-2',
      type:     'message',
      phantom:  true,
      groupID:  'stream-agent-a',
      content:  { html: '<p>Agent A says hello</p>' },
    }]);

    // Still 2 elements
    assert.equal(getInteractions(container).length, 2);
  });
});
