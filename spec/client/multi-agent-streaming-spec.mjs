'use strict';

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { setupDOM, teardownDOM, getDocument } from './jsdom-helper.mjs';

// =============================================================================
// Multi-Agent Streaming Tests
// =============================================================================
// Tests for per-agent typing indicators, delta routing, and interaction
// lifecycle — all driven by phantom frames through the FrameManager pipeline.
// =============================================================================

let store;
let i18n;
let en;

before(async () => {
  setupDOM();

  i18n  = await import('../../src/client/lib/i18n.mjs');
  en    = (await import('../../src/client/lib/locales/en.mjs')).default;
  store = await import('../../src/client/lib/store.mjs');

  i18n.setLocale(en, 'en');

  await import('../../src/client/components/kikx-top-bar/kikx-top-bar.mjs');
  await import('../../src/client/components/kikx-status-bar/kikx-status-bar.mjs');
  await import('../../src/client/components/kikx-sidebar/kikx-sidebar.mjs');
  await import('../../src/client/components/kikx-message-input/kikx-message-input.mjs');
  await import('../../src/client/components/kikx-message-content/kikx-message-content.mjs');
  await import('../../src/client/components/kikx-interaction/kikx-interaction.mjs');
  await import('../../src/client/components/kikx-chat-view/kikx-chat-view.mjs');
  await import('../../src/client/components/kikx-scroll-anchor/kikx-scroll-anchor.mjs');
  await import('../../src/client/components/kikx-modal/kikx-modal.mjs');
  await import('../../src/client/components/kikx-add-friend-modal/kikx-add-friend-modal.mjs');
  await import('../../src/client/components/kikx-create-session-modal/kikx-create-session-modal.mjs');
  await import('../../src/client/components/kikx-session-page/kikx-session-page.mjs');
});

after(() => {
  teardownDOM();
});

function createSessionPage() {
  let doc  = getDocument();
  let page = doc.createElement('kikx-session-page');

  page.setAttribute('data-id', 'ses_test');

  // Stub network methods before connecting to DOM
  page._loadInitialData     = async () => {};
  page._fetchSessionDetails = async () => {};
  page._loadFrames          = async () => {};
  page._connectStream       = () => {};

  store.agents.addAgent({ id: 'agt_alpha', name: 'Alpha Agent' });
  store.agents.addAgent({ id: 'agt_beta', name: 'Beta Agent' });

  page._currentSession = { id: 'ses_test', name: 'Test Session', dmAgentID: 'agt_alpha' };

  doc.body.appendChild(page);

  return page;
}

describe('Multi-agent streaming', () => {
  beforeEach(() => {
    let doc = getDocument();
    while (doc.body.firstChild)
      doc.body.removeChild(doc.body.firstChild);

    store.resetStore();
  });

  // ---------------------------------------------------------------------------
  // _getAgentDisplayName with agentID
  // ---------------------------------------------------------------------------

  describe('_getAgentDisplayName', () => {
    it('returns agent name from store when agentID is provided', () => {
      let page = createSessionPage();
      let name = page._getAgentDisplayName('agt_alpha');
      assert.equal(name, 'Alpha Agent');
    });

    it('returns a different agent name for a different agentID', () => {
      let page = createSessionPage();
      let name = page._getAgentDisplayName('agt_beta');
      assert.equal(name, 'Beta Agent');
    });

    it('falls back to DM agent name when agentID is null', () => {
      let page = createSessionPage();
      page._currentSession = { dmAgentName: 'DM Bot' };
      let name = page._getAgentDisplayName(null);
      assert.equal(name, 'DM Bot');
    });

    it('falls back to "Agent" when no match found', () => {
      let page = createSessionPage();
      page._currentSession = {};
      let name = page._getAgentDisplayName('agt_unknown');
      assert.equal(name, 'Agent');
    });
  });

  // ---------------------------------------------------------------------------
  // Typing indicators — via ephemeral phantom frames
  // ---------------------------------------------------------------------------

  describe('typing indicators', () => {
    it('creates typing indicator via phantom frame on interaction:start', () => {
      let page = createSessionPage();
      page._handleSSEEvent('interaction:start', JSON.stringify({ agentID: 'agt_alpha' }));

      let indicator = page._typingIndicators.get('agt_alpha');
      assert.ok(indicator, 'typing indicator should be stored in _typingIndicators');
      assert.equal(indicator.getAttribute('participant-name'), 'Alpha Agent');
      assert.equal(indicator.getAttribute('data-agent-id'), 'agt_alpha');
    });

    it('typing indicator has animated dots', () => {
      let page = createSessionPage();
      page._handleSSEEvent('interaction:start', JSON.stringify({ agentID: 'agt_alpha' }));

      let indicator = page._typingIndicators.get('agt_alpha');
      let dots = indicator.querySelector('.typing-indicator');
      assert.ok(dots, 'should have typing-indicator element');
      assert.equal(dots.querySelectorAll('span').length, 3, 'should have 3 dot spans');
    });

    it('removes typing indicator on first delta', () => {
      let page = createSessionPage();
      page._handleSSEEvent('interaction:start', JSON.stringify({ agentID: 'agt_alpha' }));
      assert.ok(page._typingIndicators.has('agt_alpha'));

      page._handleSSEEvent('delta', JSON.stringify({
        interactionID: 'int_1',
        content:       { text: 'Hello' },
        authorID:      'agt_alpha',
      }));

      assert.ok(!page._typingIndicators.has('agt_alpha'), 'typing indicator removed on delta');
    });

    it('removes typing indicator on interaction:end', () => {
      let page = createSessionPage();
      page._handleSSEEvent('interaction:start', JSON.stringify({ agentID: 'agt_alpha' }));
      assert.ok(page._typingIndicators.has('agt_alpha'));

      page._handleSSEEvent('interaction:end', JSON.stringify({ agentID: 'agt_alpha' }));
      assert.ok(!page._typingIndicators.has('agt_alpha'));
    });
  });

  // ---------------------------------------------------------------------------
  // Delta routing — via phantom frames with groupID
  // ---------------------------------------------------------------------------

  describe('delta routing', () => {
    it('creates streaming group on first delta', () => {
      let page = createSessionPage();
      page._handleSSEEvent('interaction:start', JSON.stringify({ agentID: 'agt_alpha' }));
      page._handleSSEEvent('delta', JSON.stringify({
        interactionID: 'int_1',
        content:       { text: 'Hello' },
        authorID:      'agt_alpha',
      }));

      let sg = page._streamingGroups.get('agt_alpha');
      assert.ok(sg, 'streaming group should exist');
      assert.equal(sg.html, 'Hello');
      assert.equal(sg.groupID, 'int_1');
    });

    it('accumulates deltas for same agent', () => {
      let page = createSessionPage();
      page._handleSSEEvent('interaction:start', JSON.stringify({ agentID: 'agt_alpha' }));
      page._handleSSEEvent('delta', JSON.stringify({ interactionID: 'int_1', content: { text: 'Hello ' }, authorID: 'agt_alpha' }));
      page._handleSSEEvent('delta', JSON.stringify({ interactionID: 'int_1', content: { text: 'World' }, authorID: 'agt_alpha' }));

      let sg = page._streamingGroups.get('agt_alpha');
      assert.equal(sg.html, 'Hello World');
    });

    it('merges phantom into FrameManager group frame', () => {
      let page = createSessionPage();
      page._handleSSEEvent('interaction:start', JSON.stringify({ agentID: 'agt_alpha' }));
      page._handleSSEEvent('delta', JSON.stringify({ interactionID: 'int_1', content: { text: 'Hi' }, authorID: 'agt_alpha' }));

      let groupFrame = page._frameManager.get('int_1');
      assert.ok(groupFrame, 'group frame should exist in FrameManager');
      assert.equal(groupFrame.content.html, 'Hi');
    });

    it('creates DOM element for streaming bubble', () => {
      let page = createSessionPage();
      page._handleSSEEvent('interaction:start', JSON.stringify({ agentID: 'agt_alpha' }));
      page._handleSSEEvent('delta', JSON.stringify({ interactionID: 'int_1', content: { text: 'Hi' }, authorID: 'agt_alpha' }));

      let el = page._chatView.shadowRoot.querySelector('[data-frame-id="int_1"]');
      assert.ok(el, 'streaming bubble should exist in DOM');
    });
  });

  // ---------------------------------------------------------------------------
  // SSE event lifecycle
  // ---------------------------------------------------------------------------

  describe('SSE event handling', () => {
    it('interaction:start creates typing indicator for correct agent', () => {
      let page = createSessionPage();
      page._handleSSEEvent('interaction:start', JSON.stringify({ interactionID: 'int_1', agentID: 'agt_beta' }));

      let indicator = page._typingIndicators.get('agt_beta');
      assert.ok(indicator, 'typing indicator should exist');
      assert.equal(indicator.getAttribute('participant-name'), 'Beta Agent');
      assert.equal(indicator.getAttribute('data-agent-id'), 'agt_beta');
    });

    it('interaction:end clears both typing indicator and streaming group', () => {
      let page = createSessionPage();
      page._handleSSEEvent('interaction:start', JSON.stringify({ agentID: 'agt_alpha' }));
      page._handleSSEEvent('delta', JSON.stringify({ interactionID: 'int_1', content: { text: 'Test' }, authorID: 'agt_alpha' }));

      page._handleSSEEvent('interaction:end', JSON.stringify({ agentID: 'agt_alpha' }));
      assert.ok(!page._streamingGroups.has('agt_alpha'), 'streaming group should be cleared');
      assert.ok(!page._typingIndicators.has('agt_alpha'), 'typing indicator should be cleared');
    });

    it('full lifecycle: start → delta → end', () => {
      let page = createSessionPage();

      page._handleSSEEvent('interaction:start', JSON.stringify({ agentID: 'agt_alpha' }));
      assert.ok(page._typingIndicators.has('agt_alpha'), 'typing indicator after start');

      page._handleSSEEvent('delta', JSON.stringify({ interactionID: 'int_1', content: { text: 'Hello' }, authorID: 'agt_alpha' }));
      assert.ok(!page._typingIndicators.has('agt_alpha'), 'typing indicator removed after delta');
      assert.ok(page._streamingGroups.has('agt_alpha'), 'streaming group created');

      page._handleSSEEvent('interaction:end', JSON.stringify({ agentID: 'agt_alpha' }));
      assert.ok(!page._streamingGroups.has('agt_alpha'), 'streaming group cleared after end');
    });
  });

  // ---------------------------------------------------------------------------
  // Fallback: no agentID (uses 'default')
  // ---------------------------------------------------------------------------

  describe('single-agent fallback', () => {
    it('works without agentID (backward compatible)', () => {
      let page = createSessionPage();

      // interaction:start without agentID → uses 'default'
      page._handleSSEEvent('interaction:start', JSON.stringify({ interactionID: 'int_1' }));
      assert.ok(page._typingIndicators.has('default'), 'typing indicator under "default" key');

      // delta without authorID → uses 'default'
      page._handleSSEEvent('delta', JSON.stringify({ interactionID: 'int_1', content: { text: 'hello' } }));
      let sg = page._streamingGroups.get('default');
      assert.ok(sg, 'streaming group under "default" key');
      assert.equal(sg.html, 'hello');

      // interaction:end without agentID → clears 'default'
      page._handleSSEEvent('interaction:end', JSON.stringify({ interactionID: 'int_1' }));
      assert.ok(!page._streamingGroups.has('default'), 'streaming group cleared');
    });
  });

  // ---------------------------------------------------------------------------
  // Reflection deltas
  // ---------------------------------------------------------------------------

  describe('reflection streaming', () => {
    it('accumulates reflection text in streaming group', () => {
      let page = createSessionPage();
      page._handleSSEEvent('interaction:start', JSON.stringify({ agentID: 'agt_alpha' }));
      page._handleSSEEvent('delta', JSON.stringify({ interactionID: 'int_1', content: { text: 'Hi' }, authorID: 'agt_alpha' }));

      page._handleSSEEvent('reflection-delta', JSON.stringify({
        interactionID: 'int_1',
        content:       { text: 'thinking...' },
        authorID:      'agt_alpha',
      }));

      let sg = page._streamingGroups.get('agt_alpha');
      assert.equal(sg.reflectionText, 'thinking...');
    });

    it('accumulates multiple reflection deltas', () => {
      let page = createSessionPage();
      page._handleSSEEvent('interaction:start', JSON.stringify({ agentID: 'agt_alpha' }));
      page._handleSSEEvent('delta', JSON.stringify({ interactionID: 'int_1', content: { text: 'msg' }, authorID: 'agt_alpha' }));

      page._handleSSEEvent('reflection-delta', JSON.stringify({ interactionID: 'int_1', content: { text: 'think ' }, authorID: 'agt_alpha' }));
      page._handleSSEEvent('reflection-delta', JSON.stringify({ interactionID: 'int_1', content: { text: 'more' }, authorID: 'agt_alpha' }));

      let sg = page._streamingGroups.get('agt_alpha');
      assert.equal(sg.reflectionText, 'think more');
    });
  });
});
