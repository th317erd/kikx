'use strict';

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { setupDOM, teardownDOM, getDocument } from './jsdom-helper.mjs';

// =============================================================================
// Multi-Agent Streaming Tests
// =============================================================================
// Tests for per-agent typing indicators, delta routing to correct agent
// bubbles, and interaction end finalization. Uses a lightweight harness
// that stubs API calls and SSE to exercise the session page's streaming logic.
// =============================================================================

let store;
let api;
let i18n;
let en;

before(async () => {
  setupDOM();

  i18n  = await import('../../src/client/lib/i18n.mjs');
  en    = (await import('../../src/client/lib/locales/en.mjs')).default;
  store = await import('../../src/client/lib/store.mjs');
  api   = await import('../../src/client/lib/api.mjs');

  i18n.setLocale(en, 'en');

  // Import required components
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

// Build a minimal session page with stubbed internals to avoid network calls.
function createSessionPage() {
  let doc  = getDocument();
  let page = doc.createElement('kikx-session-page');

  // Stub the session ID
  page.setAttribute('data-id', 'ses_test');

  // Stub _loadInitialData, _fetchSessionDetails, _loadFrames, _connectStream
  // to avoid real API calls
  page._loadInitialData     = async () => {};
  page._fetchSessionDetails = async () => {};
  page._loadFrames          = async () => {};
  page._connectStream       = () => {};

  // Add agents to the store so _getAgentDisplayName works
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
  // Per-agent typing indicators
  // ---------------------------------------------------------------------------

  describe('typing indicators', () => {
    it('creates typing indicator with agent-specific name', () => {
      let page = createSessionPage();
      page._showTypingIndicator('agt_alpha');

      assert.ok(page._typingIndicator);
      assert.equal(page._typingIndicator.getAttribute('participant-name'), 'Alpha Agent');
      assert.equal(page._typingIndicator.getAttribute('data-agent-id'), 'agt_alpha');
    });

    it('stores per-agent streaming state', () => {
      let page = createSessionPage();
      page._showTypingIndicator('agt_alpha');

      assert.ok(page._agentStreams.has('agt_alpha'));
      let streamState = page._agentStreams.get('agt_alpha');
      assert.ok(streamState.typingIndicator);
      assert.ok(streamState.typingDots);
      assert.equal(streamState.streamingContent, null);
    });

    it('removes agent-specific typing indicator', () => {
      let page = createSessionPage();
      page._showTypingIndicator('agt_alpha');

      let indicator = page._typingIndicator;
      assert.ok(indicator.parentNode); // attached

      page._removeTypingIndicator('agt_alpha');
      assert.ok(!indicator.parentNode); // detached
    });

    it('clears streaming state for specific agent on interaction:end', () => {
      let page = createSessionPage();
      page._showTypingIndicator('agt_alpha');
      assert.ok(page._agentStreams.has('agt_alpha'));

      page._clearStreamingState('agt_alpha');
      assert.ok(!page._agentStreams.has('agt_alpha'));
    });
  });

  // ---------------------------------------------------------------------------
  // Delta routing
  // ---------------------------------------------------------------------------

  describe('delta routing', () => {
    it('promotes typing indicator to streaming bubble on first delta', () => {
      let page = createSessionPage();
      page._showTypingIndicator('agt_alpha');

      page._handleStreamDelta({
        interactionID: 'int_1',
        content:       { text: 'Hello' },
        authorType:    'agent',
        authorID:      'agt_alpha',
      });

      // Typing indicator should be promoted
      assert.equal(page._typingIndicator, null);
      assert.ok(page._streamingContent);
      assert.equal(page._streamingHTML, 'Hello');
    });

    it('accumulates deltas for same agent', () => {
      let page = createSessionPage();
      page._showTypingIndicator('agt_alpha');

      page._handleStreamDelta({ interactionID: 'int_1', content: { text: 'Hello ' }, authorID: 'agt_alpha' });
      page._handleStreamDelta({ interactionID: 'int_1', content: { text: 'World' }, authorID: 'agt_alpha' });

      assert.equal(page._streamingHTML, 'Hello World');
    });

    it('updates per-agent streaming state in _agentStreams', () => {
      let page = createSessionPage();
      page._showTypingIndicator('agt_alpha');

      page._handleStreamDelta({ interactionID: 'int_1', content: { text: 'Hi' }, authorID: 'agt_alpha' });

      let streamState = page._agentStreams.get('agt_alpha');
      assert.ok(streamState);
      assert.equal(streamState.streamingHTML, 'Hi');
      assert.ok(streamState.streamingInteraction);
      assert.ok(streamState.streamingContent);
    });
  });

  // ---------------------------------------------------------------------------
  // SSE event handling with agentID
  // ---------------------------------------------------------------------------

  describe('SSE event handling', () => {
    it('interaction:start parses agentID from event data', () => {
      let page = createSessionPage();

      // Directly call _handleSSEEvent to simulate SSE
      page._handleSSEEvent('interaction:start', JSON.stringify({ interactionID: 'int_1', agentID: 'agt_beta' }));

      // Should have created a typing indicator with Beta Agent name
      assert.ok(page._typingIndicator);
      assert.equal(page._typingIndicator.getAttribute('participant-name'), 'Beta Agent');
      assert.equal(page._typingIndicator.getAttribute('data-agent-id'), 'agt_beta');
    });

    it('interaction:end parses agentID and clears correct state', () => {
      let page = createSessionPage();

      page._handleSSEEvent('interaction:start', JSON.stringify({ interactionID: 'int_1', agentID: 'agt_alpha' }));
      assert.ok(page._agentStreams.has('agt_alpha'));

      page._handleSSEEvent('interaction:end', JSON.stringify({ interactionID: 'int_1', agentID: 'agt_alpha' }));
      assert.ok(!page._agentStreams.has('agt_alpha'));
    });

    it('delta routing works through _handleSSEEvent', () => {
      let page = createSessionPage();

      page._handleSSEEvent('interaction:start', JSON.stringify({ interactionID: 'int_1', agentID: 'agt_alpha' }));
      page._handleSSEEvent('delta', JSON.stringify({ interactionID: 'int_1', content: { text: 'Test' }, authorType: 'agent', authorID: 'agt_alpha' }));

      assert.equal(page._streamingHTML, 'Test');
    });
  });

  // ---------------------------------------------------------------------------
  // Fallback: single-agent mode
  // ---------------------------------------------------------------------------

  describe('single-agent fallback', () => {
    it('works without agentID (backward compatible)', () => {
      let page = createSessionPage();

      // interaction:start without agentID
      page._handleSSEEvent('interaction:start', JSON.stringify({ interactionID: 'int_1' }));
      assert.ok(page._typingIndicator);

      // delta without authorID
      page._handleSSEEvent('delta', JSON.stringify({ interactionID: 'int_1', content: { text: 'hello' } }));
      assert.equal(page._streamingHTML, 'hello');

      // interaction:end without agentID
      page._handleSSEEvent('interaction:end', JSON.stringify({ interactionID: 'int_1' }));
      assert.equal(page._streamingInteraction, null);
    });
  });
});
