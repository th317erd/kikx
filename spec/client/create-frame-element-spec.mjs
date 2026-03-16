'use strict';

// =============================================================================
// TDD tests for _createFrameElement(frame)
// =============================================================================
// These tests define the DESIRED interface for the pure DOM factory function
// that will replace the monolithic _renderFrame() method. The function takes a
// frame object and returns an HTMLElement (or null for hidden/invalid types).
//
// These tests WILL FAIL until the implementation is written. That's the point.
// =============================================================================

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { setupDOM, teardownDOM, getDocument } from './jsdom-helper.mjs';

// The function under test — will be created during the refactor.
// Importing from the session page module (or a separate factory module).
// The exact import path may change during implementation.
let createFrameElement;

before(async () => {
  setupDOM();

  // Import i18n and set locale (required by interaction/message components)
  let i18n = await import('../../src/client/lib/i18n.mjs');
  let en   = (await import('../../src/client/lib/locales/en.mjs')).default;
  i18n.setLocale(en, 'en');

  // Register all components that _createFrameElement depends on
  await import('../../src/client/components/kikx-interaction/kikx-interaction.mjs');
  await import('../../src/client/components/kikx-message-content/kikx-message-content.mjs');
  await import('../../src/client/components/kikx-permission-request/kikx-permission-request.mjs');
  await import('../../src/client/components/kikx-session-link/kikx-session-link.mjs');
  await import('../../src/client/components/kikx-reflection-block/kikx-reflection-block.mjs');
  await import('../../src/client/components/kikx-command-result/kikx-command-result.mjs');

  // Import the factory — adjust path once implementation lands
  let mod = await import('../../src/client/components/kikx-session-page/kikx-session-page.mjs');
  createFrameElement = mod._createFrameElement || mod.createFrameElement;
});

after(() => {
  teardownDOM();
});

beforeEach(() => {
  let doc = getDocument();
  while (doc.body.firstChild)
    doc.body.removeChild(doc.body.firstChild);
});

// ---------------------------------------------------------------------------
// Helper: build a minimal valid frame object
// ---------------------------------------------------------------------------

function makeFrame(overrides = {}) {
  return {
    id:            overrides.id || 'frame-001',
    type:          overrides.type || 'message',
    content:       overrides.content || { html: '<p>Hello world</p>' },
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

// =============================================================================
// Renderable frame types
// =============================================================================

describe('_createFrameElement — renderable types', { timeout: 5000 }, () => {

  // -------------------------------------------------------------------------
  // message
  // -------------------------------------------------------------------------

  describe('message frames', () => {
    it('should return a kikx-interaction element for type "message"', () => {
      let frame = makeFrame({ type: 'message', content: { html: '<p>Agent reply</p>' } });
      let el    = createFrameElement(frame);

      assert.ok(el, 'should return an element');
      assert.equal(el.tagName.toLowerCase(), 'kikx-interaction');
    });

    it('should set alignment="agent" for agent message frames', () => {
      let frame = makeFrame({ type: 'message', authorType: 'agent' });
      let el    = createFrameElement(frame);

      assert.equal(el.getAttribute('alignment'), 'agent');
    });

    it('should contain a kikx-message-content child with the HTML content', () => {
      let frame = makeFrame({ type: 'message', content: { html: '<p>Some content</p>' } });
      let el    = createFrameElement(frame);

      let messageContent = el.querySelector('kikx-message-content');
      assert.ok(messageContent, 'should contain kikx-message-content child');
    });

    it('should render plain text content via escaping when no html key', () => {
      let frame = makeFrame({ type: 'message', content: { text: 'Plain text message' } });
      let el    = createFrameElement(frame);

      let messageContent = el.querySelector('kikx-message-content');
      assert.ok(messageContent, 'should contain kikx-message-content');
    });
  });

  // -------------------------------------------------------------------------
  // user-message
  // -------------------------------------------------------------------------

  describe('user-message frames', () => {
    it('should return a kikx-interaction element for type "user-message"', () => {
      let frame = makeFrame({ type: 'user-message', authorType: 'user', content: { text: 'Hello' } });
      let el    = createFrameElement(frame);

      assert.ok(el, 'should return an element');
      assert.equal(el.tagName.toLowerCase(), 'kikx-interaction');
    });

    it('should set alignment="user" for user-message frames', () => {
      let frame = makeFrame({ type: 'user-message', authorType: 'user' });
      let el    = createFrameElement(frame);

      assert.equal(el.getAttribute('alignment'), 'user');
    });

    it('should set estimated token count if present in content', () => {
      let frame = makeFrame({
        type:       'user-message',
        authorType: 'user',
        content:    { text: 'Hi', estimatedTokens: 42 },
      });
      let el = createFrameElement(frame);

      assert.equal(el.getAttribute('token-count'), '42');
    });
  });

  // -------------------------------------------------------------------------
  // permission-request
  // -------------------------------------------------------------------------

  describe('permission-request frames', () => {
    it('should return a kikx-interaction element for type "permission-request"', () => {
      let frame = makeFrame({
        type:    'permission-request',
        content: { toolName: 'shell:execute', parsedCommands: [{ command: 'ls', arguments: [], status: 'needs-approval' }] },
      });
      let el = createFrameElement(frame);

      assert.ok(el, 'should return an element');
      assert.equal(el.tagName.toLowerCase(), 'kikx-interaction');
    });

    it('should set bubble-type="permission"', () => {
      let frame = makeFrame({
        type:    'permission-request',
        content: { toolName: 'shell:execute', parsedCommands: [] },
      });
      let el = createFrameElement(frame);

      assert.equal(el.getAttribute('bubble-type'), 'permission');
    });

    it('should contain a kikx-permission-request child element', () => {
      let frame = makeFrame({
        type:    'permission-request',
        content: { toolName: 'shell:execute', parsedCommands: [] },
      });
      let el = createFrameElement(frame);

      let perm = el.querySelector('kikx-permission-request');
      assert.ok(perm, 'should contain kikx-permission-request child');
    });
  });

  // -------------------------------------------------------------------------
  // session-link
  // -------------------------------------------------------------------------

  describe('session-link frames', () => {
    it('should return a kikx-interaction element for type "session-link"', () => {
      let frame = makeFrame({
        type:    'session-link',
        content: { targetSessionID: 'session-abc', title: 'Sub-session' },
      });
      let el = createFrameElement(frame);

      assert.ok(el, 'should return an element');
      assert.equal(el.tagName.toLowerCase(), 'kikx-interaction');
    });

    it('should set alignment="system" for session-link frames', () => {
      let frame = makeFrame({
        type:    'session-link',
        content: { targetSessionID: 'session-abc', title: 'Sub-session' },
      });
      let el = createFrameElement(frame);

      assert.equal(el.getAttribute('alignment'), 'system');
    });

    it('should contain a kikx-session-link child element', () => {
      let frame = makeFrame({
        type:    'session-link',
        content: { targetSessionID: 'session-abc', title: 'Sub-session' },
      });
      let el = createFrameElement(frame);

      let link = el.querySelector('kikx-session-link');
      assert.ok(link, 'should contain kikx-session-link child');
    });
  });

  // -------------------------------------------------------------------------
  // command-result
  // -------------------------------------------------------------------------

  describe('command-result frames', () => {
    it('should return a kikx-interaction element for type "command-result"', () => {
      let frame = makeFrame({ type: 'command-result', content: { html: '<pre>output</pre>' } });
      let el    = createFrameElement(frame);

      assert.ok(el, 'should return an element');
      assert.equal(el.tagName.toLowerCase(), 'kikx-interaction');
    });

    it('should set alignment="agent" for command-result frames', () => {
      let frame = makeFrame({ type: 'command-result', content: { html: '<pre>output</pre>' } });
      let el    = createFrameElement(frame);

      assert.equal(el.getAttribute('alignment'), 'agent');
    });
  });

  // -------------------------------------------------------------------------
  // error
  // -------------------------------------------------------------------------

  describe('error frames', () => {
    it('should return a kikx-interaction element for type "error"', () => {
      let frame = makeFrame({ type: 'error', content: { message: 'Something broke' } });
      let el    = createFrameElement(frame);

      assert.ok(el, 'should return an element');
      assert.equal(el.tagName.toLowerCase(), 'kikx-interaction');
    });

    it('should set bubble-type="error"', () => {
      let frame = makeFrame({ type: 'error', content: { message: 'Something broke' } });
      let el    = createFrameElement(frame);

      assert.equal(el.getAttribute('bubble-type'), 'error');
    });

    it('should set alignment="agent" for error frames', () => {
      let frame = makeFrame({ type: 'error', content: { message: 'Something broke' } });
      let el    = createFrameElement(frame);

      assert.equal(el.getAttribute('alignment'), 'agent');
    });
  });

  // -------------------------------------------------------------------------
  // reflection
  // -------------------------------------------------------------------------

  describe('reflection frames', () => {
    it('should return a kikx-interaction element for type "reflection"', () => {
      let frame = makeFrame({ type: 'reflection', content: { text: 'Thinking...' } });
      let el    = createFrameElement(frame);

      assert.ok(el, 'should return an element');
      assert.equal(el.tagName.toLowerCase(), 'kikx-interaction');
    });

    it('should contain a kikx-reflection-block child element', () => {
      let frame = makeFrame({ type: 'reflection', content: { text: 'Thinking...' } });
      let el    = createFrameElement(frame);

      let block = el.querySelector('kikx-reflection-block');
      assert.ok(block, 'should contain kikx-reflection-block child');
    });

    it('should set alignment="agent" for reflection frames', () => {
      let frame = makeFrame({ type: 'reflection', content: { text: 'Thinking...' } });
      let el    = createFrameElement(frame);

      assert.equal(el.getAttribute('alignment'), 'agent');
    });
  });
});

// =============================================================================
// Common attributes across all renderable types
// =============================================================================

describe('_createFrameElement — common attributes', { timeout: 5000 }, () => {

  it('should set data-frame-id to the frame ID', () => {
    let frame = makeFrame({ id: 'frame-xyz-123', type: 'message' });
    let el    = createFrameElement(frame);

    assert.equal(el.getAttribute('data-frame-id'), 'frame-xyz-123');
  });

  it('should set data-interaction-id from frame.interactionID', () => {
    let frame = makeFrame({ interactionID: 'int-456', type: 'message' });
    let el    = createFrameElement(frame);

    assert.equal(el.getAttribute('data-interaction-id'), 'int-456');
  });

  it('should fall back to frame.id for data-interaction-id when interactionID is missing', () => {
    let frame = makeFrame({ id: 'frame-fallback', interactionID: undefined, type: 'message' });
    let el    = createFrameElement(frame);

    assert.equal(el.getAttribute('data-interaction-id'), 'frame-fallback');
  });

  it('should set participant-name from frame.authorName', () => {
    let frame = makeFrame({ type: 'message', authorName: 'Claude' });
    let el    = createFrameElement(frame);

    assert.equal(el.getAttribute('participant-name'), 'Claude');
  });

  it('should set participant-initials derived from the author name', () => {
    let frame = makeFrame({ type: 'message', authorName: 'Test Bot' });
    let el    = createFrameElement(frame);

    // "Test Bot" → "TB"
    assert.equal(el.getAttribute('participant-initials'), 'TB');
  });

  it('should set a timestamp attribute', () => {
    let frame = makeFrame({ type: 'message', createdAt: Date.now() });
    let el    = createFrameElement(frame);

    let ts = el.getAttribute('timestamp');
    assert.ok(ts && ts.length > 0, 'timestamp attribute should be set');
  });

  it('should set alignment="user" for user-message type', () => {
    let frame = makeFrame({ type: 'user-message', authorType: 'user' });
    let el    = createFrameElement(frame);

    assert.equal(el.getAttribute('alignment'), 'user');
  });

  it('should set alignment="agent" for agent message type', () => {
    let frame = makeFrame({ type: 'message', authorType: 'agent' });
    let el    = createFrameElement(frame);

    assert.equal(el.getAttribute('alignment'), 'agent');
  });

  it('should set alignment="user" when authorType is "user" regardless of frame type', () => {
    let frame = makeFrame({ type: 'message', authorType: 'user' });
    let el    = createFrameElement(frame);

    assert.equal(el.getAttribute('alignment'), 'user');
  });
});

// =============================================================================
// Hidden / non-renderable frame types
// =============================================================================

describe('_createFrameElement — hidden types return null', { timeout: 5000 }, () => {
  let hiddenTypes = [
    'pending-action',
    'tool-call',
    'tool-result',
    'tool-error',
    'hook-blocked',
    'permission-denied',
    'participant-joined',
    'participant-left',
  ];

  for (let type of hiddenTypes) {
    it(`should return null for type "${type}"`, () => {
      let frame = makeFrame({ type });
      let el    = createFrameElement(frame);

      assert.equal(el, null, `type "${type}" should return null`);
    });
  }
});

// =============================================================================
// Malformed / invalid frames
// =============================================================================

describe('_createFrameElement — malformed frames', { timeout: 5000 }, () => {

  it('should return null for a frame with missing content (undefined)', () => {
    let frame = makeFrame({ type: 'message', content: undefined });
    let el    = createFrameElement(frame);

    assert.equal(el, null);
  });

  it('should return null for a frame with null content', () => {
    let frame = makeFrame({ type: 'message', content: null });
    let el    = createFrameElement(frame);

    assert.equal(el, null);
  });

  it('should return null for a frame with an unknown type', () => {
    let frame = makeFrame({ type: 'banana-frame' });
    let el    = createFrameElement(frame);

    assert.equal(el, null);
  });

  it('should not throw for a frame with missing id', () => {
    let frame = makeFrame({ id: undefined, type: 'message' });

    assert.doesNotThrow(() => {
      createFrameElement(frame);
    });
  });

  it('should return null for a frame with missing type', () => {
    let frame = makeFrame({ type: undefined });
    let el    = createFrameElement(frame);

    assert.equal(el, null);
  });

  it('should not throw for a completely empty object', () => {
    assert.doesNotThrow(() => {
      createFrameElement({});
    });
  });

  it('should return null for a completely empty object', () => {
    let el = createFrameElement({});

    assert.equal(el, null);
  });

  it('should not throw when frame is null', () => {
    assert.doesNotThrow(() => {
      createFrameElement(null);
    });
  });

  it('should return null when frame is null', () => {
    let el = createFrameElement(null);
    assert.equal(el, null);
  });

  it('should not throw when frame is undefined', () => {
    assert.doesNotThrow(() => {
      createFrameElement(undefined);
    });
  });

  it('should return null when frame is undefined', () => {
    let el = createFrameElement(undefined);
    assert.equal(el, null);
  });
});

// =============================================================================
// XSS sanitization
// =============================================================================

describe('_createFrameElement — XSS sanitization', { timeout: 5000 }, () => {

  it('should not contain <script> tags in the output element', () => {
    let frame = makeFrame({
      type:    'message',
      content: { html: '<p>Hello</p><script>alert("xss")</script>' },
    });
    let el = createFrameElement(frame);

    assert.ok(el, 'should return an element');
    // The element tree (including shadow DOM children) should not contain script tags
    let scripts = el.querySelectorAll('script');
    assert.equal(scripts.length, 0, 'no script tags in light DOM');

    // Also check shadow DOM of nested message-content
    let mc = el.querySelector('kikx-message-content');
    if (mc && mc.shadowRoot) {
      let shadowScripts = mc.shadowRoot.querySelectorAll('script');
      assert.equal(shadowScripts.length, 0, 'no script tags in shadow DOM');
    }
  });

  it('should strip event handler attributes from content HTML', () => {
    let frame = makeFrame({
      type:    'message',
      content: { html: '<p onmouseover="alert(1)">hover me</p>' },
    });
    let el = createFrameElement(frame);
    let mc = el.querySelector('kikx-message-content');

    if (mc && mc.shadowRoot) {
      let p = mc.shadowRoot.querySelector('p');
      if (p) {
        assert.equal(p.getAttribute('onmouseover'), null, 'onmouseover should be stripped');
      }
    }
  });

  it('should strip javascript: URIs from href attributes', () => {
    let frame = makeFrame({
      type:    'message',
      content: { html: '<a href="javascript:alert(1)">click</a>' },
    });
    let el = createFrameElement(frame);
    let mc = el.querySelector('kikx-message-content');

    if (mc && mc.shadowRoot) {
      let a = mc.shadowRoot.querySelector('a');
      if (a) {
        let href = a.getAttribute('href') || '';
        assert.ok(!href.includes('javascript:'), 'javascript: URI should be stripped');
      }
    }
  });

  it('should not contain <iframe> tags in the output element', () => {
    let frame = makeFrame({
      type:    'message',
      content: { html: '<p>Hello</p><iframe src="http://evil.com"></iframe>' },
    });
    let el = createFrameElement(frame);

    let mc = el.querySelector('kikx-message-content');
    if (mc && mc.shadowRoot) {
      let iframes = mc.shadowRoot.querySelectorAll('iframe');
      assert.equal(iframes.length, 0, 'no iframes in shadow DOM');
    }
  });

  it('should not contain <form> or <input> tags in the output element', () => {
    let frame = makeFrame({
      type:    'message',
      content: { html: '<form action="http://evil.com"><input type="text" name="password"></form>' },
    });
    let el = createFrameElement(frame);

    let mc = el.querySelector('kikx-message-content');
    if (mc && mc.shadowRoot) {
      let forms  = mc.shadowRoot.querySelectorAll('form');
      let inputs = mc.shadowRoot.querySelectorAll('input');
      assert.equal(forms.length, 0, 'no form tags in shadow DOM');
      assert.equal(inputs.length, 0, 'no input tags in shadow DOM');
    }
  });
});
