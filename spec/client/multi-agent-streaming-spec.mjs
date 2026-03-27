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
      assert.equal(indicator.tagName, 'KIKX-TYPING-INDICATOR');
      assert.equal(indicator.getAttribute('data-agent-id'), 'agt_alpha');
    });

    it('typing indicator has agent name', () => {
      let page = createSessionPage();
      page._handleSSEEvent('interaction:start', JSON.stringify({ agentID: 'agt_alpha' }));

      let indicator = page._typingIndicators.get('agt_alpha');
      assert.equal(indicator.agentName, 'Alpha Agent');
      assert.equal(indicator.tagName, 'KIKX-TYPING-INDICATOR');
    });

    it('removes typing indicator on first delta', () => {
      let page = createSessionPage();
      page._handleSSEEvent('interaction:start', JSON.stringify({ agentID: 'agt_alpha' }));
      assert.ok(page._typingIndicators.has('agt_alpha'));

      page._handleSSEEvent('Delta', JSON.stringify({
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
      page._handleSSEEvent('Delta', JSON.stringify({
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
      page._handleSSEEvent('Delta', JSON.stringify({ interactionID: 'int_1', content: { text: 'Hello ' }, authorID: 'agt_alpha' }));
      page._handleSSEEvent('Delta', JSON.stringify({ interactionID: 'int_1', content: { text: 'World' }, authorID: 'agt_alpha' }));

      let sg = page._streamingGroups.get('agt_alpha');
      assert.equal(sg.html, 'Hello World');
    });

    it('merges phantom into FrameManager group frame', () => {
      let page = createSessionPage();
      page._handleSSEEvent('interaction:start', JSON.stringify({ agentID: 'agt_alpha' }));
      page._handleSSEEvent('Delta', JSON.stringify({ interactionID: 'int_1', content: { text: 'Hi' }, authorID: 'agt_alpha' }));

      let groupFrame = page._frameManager.get('int_1');
      assert.ok(groupFrame, 'group frame should exist in FrameManager');
      assert.equal(groupFrame.content.html, 'Hi');
    });

    it('creates DOM element for streaming bubble', () => {
      let page = createSessionPage();
      page._handleSSEEvent('interaction:start', JSON.stringify({ agentID: 'agt_alpha' }));
      page._handleSSEEvent('Delta', JSON.stringify({ interactionID: 'int_1', content: { text: 'Hi' }, authorID: 'agt_alpha' }));

      let el = page._chatView.querySelector('[data-frame-id="int_1"]');
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
      assert.equal(indicator.tagName, 'KIKX-TYPING-INDICATOR');
      assert.equal(indicator.agentName, 'Beta Agent');
      assert.equal(indicator.getAttribute('data-agent-id'), 'agt_beta');
    });

    it('interaction:end clears both typing indicator and streaming group', () => {
      let page = createSessionPage();
      page._handleSSEEvent('interaction:start', JSON.stringify({ agentID: 'agt_alpha' }));
      page._handleSSEEvent('Delta', JSON.stringify({ interactionID: 'int_1', content: { text: 'Test' }, authorID: 'agt_alpha' }));

      page._handleSSEEvent('interaction:end', JSON.stringify({ agentID: 'agt_alpha' }));
      assert.ok(!page._streamingGroups.has('agt_alpha'), 'streaming group should be cleared');
      assert.ok(!page._typingIndicators.has('agt_alpha'), 'typing indicator should be cleared');
    });

    it('full lifecycle: start → delta → end', () => {
      let page = createSessionPage();

      page._handleSSEEvent('interaction:start', JSON.stringify({ agentID: 'agt_alpha' }));
      assert.ok(page._typingIndicators.has('agt_alpha'), 'typing indicator after start');

      page._handleSSEEvent('Delta', JSON.stringify({ interactionID: 'int_1', content: { text: 'Hello' }, authorID: 'agt_alpha' }));
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
      page._handleSSEEvent('Delta', JSON.stringify({ interactionID: 'int_1', content: { text: 'hello' } }));
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
      page._handleSSEEvent('Delta', JSON.stringify({ interactionID: 'int_1', content: { text: 'Hi' }, authorID: 'agt_alpha' }));

      page._handleSSEEvent('ReflectionDelta', JSON.stringify({
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
      page._handleSSEEvent('Delta', JSON.stringify({ interactionID: 'int_1', content: { text: 'msg' }, authorID: 'agt_alpha' }));

      page._handleSSEEvent('ReflectionDelta', JSON.stringify({ interactionID: 'int_1', content: { text: 'think ' }, authorID: 'agt_alpha' }));
      page._handleSSEEvent('ReflectionDelta', JSON.stringify({ interactionID: 'int_1', content: { text: 'more' }, authorID: 'agt_alpha' }));

      let sg = page._streamingGroups.get('agt_alpha');
      assert.equal(sg.reflectionText, 'think more');
    });

    it('marks reflection block as complete on interaction:end', () => {
      let page = createSessionPage();
      page._handleSSEEvent('interaction:start', JSON.stringify({ agentID: 'agt_alpha' }));
      page._handleSSEEvent('Delta', JSON.stringify({ interactionID: 'int_1', content: { text: 'Hi' }, authorID: 'agt_alpha' }));
      page._handleSSEEvent('ReflectionDelta', JSON.stringify({ interactionID: 'int_1', content: { text: 'thinking...' }, authorID: 'agt_alpha' }));

      // Verify reflection block exists and is NOT complete yet
      let sg      = page._streamingGroups.get('agt_alpha');
      let groupEl = page._chatView.querySelector(`[data-frame-id="${sg.groupID}"]`);
      let rb      = groupEl.querySelector('kikx-reflection-block');
      assert.ok(rb, 'reflection block should exist during streaming');
      assert.ok(!rb.hasAttribute('complete'), 'reflection block should not be complete during streaming');

      // End the interaction
      page._handleSSEEvent('interaction:end', JSON.stringify({ agentID: 'agt_alpha' }));

      // Reflection block should now be marked complete
      assert.ok(rb.hasAttribute('complete'), 'reflection block should be marked complete after interaction:end');
    });
  });

  // ---------------------------------------------------------------------------
  // _refreshAgentNames — direct store lookup
  // ---------------------------------------------------------------------------

  describe('_refreshAgentNames', () => {
    it('should update agent name from store, not fall back to session name', () => {
      let page = createSessionPage();

      // Simulate a frame in the FrameManager with authorType=agent
      page._frameManager.merge([{
        id:         'frm_test1',
        type: 'Message',
        content:    { html: '<p>Hello</p>' },
        order:      1,
        timestamp:  Date.now(),
        authorType: 'agent',
        authorID:   'agt_alpha',
      }], { events: false });

      // Create a DOM element with "Agent" as the name (simulating pre-agent-load render)
      let doc         = getDocument();
      let interaction = doc.createElement('kikx-interaction');
      interaction.setAttribute('data-frame-id', 'frm_test1');
      interaction.setAttribute('participant-name', 'Agent');
      interaction.setAttribute('alignment', 'agent');
      page._chatView.appendInteraction(interaction);

      // Ensure the agent is in the store
      store.agents.addAgent({ id: 'agt_alpha', name: 'Alpha Agent' });

      // Call _refreshAgentNames
      page._refreshAgentNames();

      assert.equal(interaction.getAttribute('participant-name'), 'Alpha Agent');
    });

    it('should not update name if agent is not in store', () => {
      let page = createSessionPage();

      page._frameManager.merge([{
        id:         'frm_test2',
        type: 'Message',
        content:    { html: '<p>Hello</p>' },
        order:      1,
        timestamp:  Date.now(),
        authorType: 'agent',
        authorID:   'agt_unknown_xyz',
      }], { events: false });

      let doc         = getDocument();
      let interaction = doc.createElement('kikx-interaction');
      interaction.setAttribute('data-frame-id', 'frm_test2');
      interaction.setAttribute('participant-name', 'Agent');
      interaction.setAttribute('alignment', 'agent');
      page._chatView.appendInteraction(interaction);

      // Agent is NOT in the store — name should remain "Agent", NOT the session name
      page._refreshAgentNames();

      assert.equal(interaction.getAttribute('participant-name'), 'Agent');
    });

    it('should not touch elements that already have a real name', () => {
      let page = createSessionPage();

      page._frameManager.merge([{
        id:         'frm_test3',
        type: 'Message',
        content:    { html: '<p>Hello</p>' },
        order:      1,
        timestamp:  Date.now(),
        authorType: 'agent',
        authorID:   'agt_alpha',
      }], { events: false });

      let doc         = getDocument();
      let interaction = doc.createElement('kikx-interaction');
      interaction.setAttribute('data-frame-id', 'frm_test3');
      interaction.setAttribute('participant-name', 'Already Named');
      interaction.setAttribute('alignment', 'agent');
      page._chatView.appendInteraction(interaction);

      page._refreshAgentNames();

      // Should not be changed since it's not "Agent"
      assert.equal(interaction.getAttribute('participant-name'), 'Already Named');
    });
  });

  // ---------------------------------------------------------------------------
  // _resolveAgentID — resolves agent from session data
  // ---------------------------------------------------------------------------

  describe('_resolveAgentID', () => {
    it('resolves agentID from dmAgentID for DM sessions', async () => {
      let page = createSessionPage();
      page._currentSession = { dmAgentID: 'agt_dm_bot' };

      let agentID = await page._resolveAgentID('ses_test');
      assert.equal(agentID, 'agt_dm_bot');
    });

    it('resolves agentID from participants when dmAgentID is null', async () => {
      let page = createSessionPage();
      page._currentSession = {
        dmAgentID:    null,
        participants: [{ agentID: 'agt_from_participant' }],
      };

      let agentID = await page._resolveAgentID('ses_test');
      assert.equal(agentID, 'agt_from_participant');
    });

    it('returns null when no session and no participants', async () => {
      let page = createSessionPage();
      page._currentSession = null;

      let agentID = await page._resolveAgentID('ses_test');
      assert.equal(agentID, null);
    });

    it('re-fetches session details when agent not found initially', async () => {
      let page = createSessionPage();
      page._currentSession = { dmAgentID: null, participants: [] };

      let fetchCalled = false;
      page._fetchSessionDetails = async () => {
        fetchCalled = true;
        page._currentSession = {
          dmAgentID:    null,
          participants: [{ agentID: 'agt_late_join' }],
        };
      };

      let agentID = await page._resolveAgentID('ses_test');
      assert.ok(fetchCalled, 'should have called _fetchSessionDetails');
      assert.equal(agentID, 'agt_late_join');
    });
  });

  // ---------------------------------------------------------------------------
  // Empty bubble cleanup on interaction:end
  // ---------------------------------------------------------------------------

  describe('empty bubble cleanup', () => {
    it('removes phantom bubble with only reflection and no message on interaction:end', () => {
      let page = createSessionPage();

      // Simulate: agent starts thinking (typing indicator → reflection delta → phantom bubble)
      page._handleSSEEvent('interaction:start', JSON.stringify({ agentID: 'agt_alpha' }));
      page._handleSSEEvent('ReflectionDelta', JSON.stringify({
        interactionID: 'int_empty_1',
        content: { text: 'thinking...' },
        authorID: 'agt_alpha',
      }));

      // The phantom creates a streaming group with a groupID
      let sg = page._streamingGroups.get('agt_alpha');
      assert.ok(sg, 'should have streaming group');
      assert.ok(sg.groupID, 'should have groupID');

      // Simulate the phantom being rendered as a kikx-interaction in DOM
      let doc = getDocument();
      let fakeInteraction = doc.createElement('kikx-interaction');
      fakeInteraction.setAttribute('data-frame-id', sg.groupID);
      fakeInteraction.setAttribute('data-author-id', 'agt_alpha');

      let rb = doc.createElement('kikx-reflection-block');
      fakeInteraction.appendChild(rb);

      page._chatView.appendChild(fakeInteraction);

      // Verify it's in the DOM
      assert.ok(page._chatView.querySelector(`[data-frame-id="${sg.groupID}"]`), 'bubble should be in DOM');

      // Agent produces [NOT RESPONDING] which gets suppressed → no Message frame
      // interaction:end fires
      page._handleSSEEvent('interaction:end', JSON.stringify({
        interactionID: 'int_empty_1',
        agentID: 'agt_alpha',
      }));

      // The empty bubble should be REMOVED
      let remaining = page._chatView.querySelector(`[data-frame-id="${sg.groupID}"]`);
      assert.equal(remaining, null, 'empty bubble MUST be removed on interaction:end');
    });

    it('keeps bubble that HAS message content on interaction:end', () => {
      let page = createSessionPage();

      page._handleSSEEvent('interaction:start', JSON.stringify({ agentID: 'agt_alpha' }));
      page._handleSSEEvent('ReflectionDelta', JSON.stringify({
        interactionID: 'int_keep_1',
        content: { text: 'thinking...' },
        authorID: 'agt_alpha',
      }));

      let sg = page._streamingGroups.get('agt_alpha');
      let doc = getDocument();

      let fakeInteraction = doc.createElement('kikx-interaction');
      fakeInteraction.setAttribute('data-frame-id', sg.groupID);
      fakeInteraction.setAttribute('data-author-id', 'agt_alpha');

      let mc = doc.createElement('kikx-message-content');
      mc.content = '<p>I have something to say</p>';
      fakeInteraction.appendChild(mc);

      page._chatView.appendChild(fakeInteraction);

      page._handleSSEEvent('interaction:end', JSON.stringify({
        interactionID: 'int_keep_1',
        agentID: 'agt_alpha',
      }));

      // Should NOT be removed — it has message content
      let remaining = page._chatView.querySelector(`[data-frame-id="${sg.groupID}"]`);
      assert.ok(remaining, 'bubble with message content MUST be kept');
    });

    it('aggressive cleanup removes orphaned agent bubbles without message content', () => {
      let page = createSessionPage();
      let doc  = getDocument();

      // Create an orphaned bubble (not tracked in streaming groups)
      let orphan = doc.createElement('kikx-interaction');
      orphan.setAttribute('data-author-id', 'agt_alpha');
      orphan.setAttribute('data-frame-id', 'frm_orphan');

      let rb = doc.createElement('kikx-reflection-block');
      orphan.appendChild(rb);

      page._chatView.appendChild(orphan);

      // Start and end an interaction for the same agent
      page._handleSSEEvent('interaction:start', JSON.stringify({ agentID: 'agt_alpha' }));
      page._handleSSEEvent('interaction:end', JSON.stringify({
        interactionID: 'int_cleanup',
        agentID: 'agt_alpha',
      }));

      // The orphan should be removed by aggressive cleanup
      let remaining = page._chatView.querySelector('[data-frame-id="frm_orphan"]');
      assert.equal(remaining, null, 'orphaned empty bubble MUST be removed');
    });

    it('aggressive cleanup preserves bubbles with tool activity', () => {
      let page = createSessionPage();
      let doc  = getDocument();

      let bubble = doc.createElement('kikx-interaction');
      bubble.setAttribute('data-author-id', 'agt_alpha');
      bubble.setAttribute('data-frame-id', 'frm_activity');

      let activity = doc.createElement('div');
      activity.className = 'tool-activity-content';
      activity.textContent = 'Running...';
      bubble.appendChild(activity);

      page._chatView.appendChild(bubble);

      page._handleSSEEvent('interaction:start', JSON.stringify({ agentID: 'agt_alpha' }));
      page._handleSSEEvent('interaction:end', JSON.stringify({
        interactionID: 'int_activity',
        agentID: 'agt_alpha',
      }));

      let remaining = page._chatView.querySelector('[data-frame-id="frm_activity"]');
      assert.ok(remaining, 'bubble with tool activity MUST be kept');
    });
  });
});
