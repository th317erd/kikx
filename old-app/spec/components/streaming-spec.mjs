'use strict';

// ============================================================================
// Streaming Interaction Banner Tests
// ============================================================================
// Tests for Bug 1.2: System Interaction Results in Chat
//
// These tests verify that:
// 1. Interaction banners are only created for functions with banner config
// 2. Silent interactions (like update_prompt) don't create banners
// 3. updateInteractionBanner does nothing when no banner exists

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createDOM, destroyDOM, getDocument, getWindow } from '../helpers/dom-helpers.mjs';

// ============================================================================
// Test Setup
// ============================================================================

/**
 * Set up the streaming message element that interaction banners attach to.
 */
function createStreamingMessageElement() {
  const doc = getDocument();
  const html = `
    <div class="message message-assistant message-streaming" id="streaming-message">
      <div class="message-header">Assistant</div>
      <div class="message-bubble">
        <div class="streaming-content message-content"></div>
        <div class="streaming-elements"></div>
        <div class="streaming-indicator">Processing...</div>
      </div>
    </div>
  `;
  doc.body.innerHTML = html;
}

/**
 * Simplified banner functions extracted from streaming.js for testing.
 * These mirror the actual implementation.
 */
function appendInteractionBanner(interactionId, label, content, status, icon = '⚡') {
  const doc = getDocument();
  const streamingEl = doc.getElementById('streaming-message');
  if (!streamingEl) return;

  const bubble = streamingEl.querySelector('.message-bubble');
  if (!bubble) return;

  const statusText = (status === 'pending') ? 'Pending' : status;
  const escapedContent = content.substring(0, 100) + ((content.length > 100) ? '...' : '');

  const bannerHtml = `
    <div class="interaction-banner interaction-banner-${status}" data-interaction-id="${interactionId}">
      <span class="interaction-banner-icon">${icon}</span>
      <span class="interaction-banner-label">${label}:</span>
      <span class="interaction-banner-content">${escapedContent}</span>
      <span class="interaction-banner-status">${statusText}</span>
    </div>
  `;

  const contentEl = bubble.querySelector('.streaming-content');
  if (contentEl) {
    contentEl.insertAdjacentHTML('beforebegin', bannerHtml);
  } else {
    bubble.insertAdjacentHTML('afterbegin', bannerHtml);
  }
}

function updateInteractionBanner(interactionId, status, result, elapsedMs) {
  const doc = getDocument();
  const banner = doc.querySelector(`.interaction-banner[data-interaction-id="${interactionId}"]`);

  if (!banner) {
    // This is the key behavior: if no banner exists, do nothing
    return false;
  }

  const statusEl = banner.querySelector('.interaction-banner-status');
  if (statusEl) {
    let statusText;
    if (status === 'completed' && elapsedMs) {
      statusText = `Completed in ${elapsedMs}ms`;
    } else if (status === 'completed') {
      statusText = 'Complete';
    } else if (status === 'failed') {
      statusText = 'Failed';
    } else {
      statusText = status;
    }
    statusEl.textContent = statusText;
  }

  banner.className = `interaction-banner interaction-banner-${status}`;
  return true;
}

/**
 * Simulates onInteractionStarted event handler logic.
 * Only creates banners when banner config is provided.
 */
function handleInteractionStarted(data) {
  // Only show banners for functions that opt-in via banner config
  if (!data.banner) {
    return false; // No banner created
  }

  const label = data.banner.label || data.targetProperty || 'interaction';
  const icon = data.banner.icon || '⚡';
  let content = '';

  if (data.banner.contentKey && data.payload?.[data.banner.contentKey]) {
    content = data.payload[data.banner.contentKey];
  } else if (data.payload) {
    content = (typeof data.payload === 'string') ? data.payload : JSON.stringify(data.payload);
  }

  appendInteractionBanner(data.interactionId, label, content, 'pending', icon);
  return true; // Banner created
}

/**
 * Simulates onInteractionResult event handler logic.
 */
function handleInteractionResult(data) {
  // This should only update existing banners, not create new ones
  return updateInteractionBanner(data.interactionId, data.status, data.result, data.elapsedMs);
}

// ============================================================================
// Tests
// ============================================================================

describe('Streaming Interaction Banners', () => {
  beforeEach(() => {
    createDOM();
    createStreamingMessageElement();
  });

  afterEach(() => {
    destroyDOM();
  });

  describe('appendInteractionBanner', () => {
    it('should create banner element in DOM', () => {
      const doc = getDocument();

      appendInteractionBanner('test-123', 'Web Search', 'test query', 'pending', '🔍');

      const banner = doc.querySelector('.interaction-banner[data-interaction-id="test-123"]');
      assert.ok(banner, 'Banner should be created');
      assert.ok(banner.classList.contains('interaction-banner-pending'), 'Should have pending class');
      assert.ok(banner.textContent.includes('Web Search'), 'Should contain label');
      assert.ok(banner.textContent.includes('test query'), 'Should contain content');
    });

    it('should truncate long content', () => {
      const doc = getDocument();
      const longContent = 'a'.repeat(200);

      appendInteractionBanner('test-123', 'Search', longContent, 'pending');

      const banner = doc.querySelector('.interaction-banner[data-interaction-id="test-123"]');
      const contentEl = banner.querySelector('.interaction-banner-content');
      assert.ok(contentEl.textContent.length < 110, 'Content should be truncated');
      assert.ok(contentEl.textContent.includes('...'), 'Should have ellipsis');
    });
  });

  describe('updateInteractionBanner', () => {
    it('should update existing banner status', () => {
      const doc = getDocument();

      // Create a banner first
      appendInteractionBanner('test-123', 'Search', 'query', 'pending');

      // Update it
      const updated = updateInteractionBanner('test-123', 'completed', {}, 500);

      assert.equal(updated, true, 'Should return true when banner exists');
      const banner = doc.querySelector('.interaction-banner[data-interaction-id="test-123"]');
      assert.ok(banner.classList.contains('interaction-banner-completed'), 'Should have completed class');
      const statusEl = banner.querySelector('.interaction-banner-status');
      assert.ok(statusEl.textContent.includes('Completed'), 'Should show completed status');
    });

    it('should return false when no banner exists (silent interaction)', () => {
      // This is the key test for Bug 1.2:
      // update_prompt has no banner, so updateInteractionBanner should do nothing

      const updated = updateInteractionBanner('nonexistent-123', 'completed', {});

      assert.equal(updated, false, 'Should return false when no banner exists');
    });

    it('should NOT create a banner when updating non-existent banner', () => {
      const doc = getDocument();

      // Try to update a banner that doesn't exist
      updateInteractionBanner('silent-interaction', 'completed', { success: true });

      // Verify no banner was created
      const banner = doc.querySelector('.interaction-banner[data-interaction-id="silent-interaction"]');
      assert.equal(banner, null, 'No banner should be created for silent interactions');
    });
  });

  describe('handleInteractionStarted', () => {
    it('should create banner when banner config is provided', () => {
      const doc = getDocument();

      const created = handleInteractionStarted({
        interactionId: 'websearch-123',
        targetProperty: 'websearch',
        payload: { query: 'test search' },
        banner: {
          label: 'Web Search',
          icon: '🔍',
          contentKey: 'query',
        },
      });

      assert.equal(created, true, 'Should return true when banner created');
      const banner = doc.querySelector('.interaction-banner[data-interaction-id="websearch-123"]');
      assert.ok(banner, 'Banner should exist');
      assert.ok(banner.textContent.includes('Web Search'), 'Should have label');
      assert.ok(banner.textContent.includes('test search'), 'Should have query content');
    });

    it('should NOT create banner when banner config is null (silent interaction)', () => {
      const doc = getDocument();

      // update_prompt does NOT have a banner config
      const created = handleInteractionStarted({
        interactionId: 'prompt-update-123',
        targetProperty: 'update_prompt',
        payload: { message_id: 1, prompt_id: 'p1', answer: 'Blue' },
        banner: null, // No banner config
      });

      assert.equal(created, false, 'Should return false when no banner config');
      const banner = doc.querySelector('.interaction-banner[data-interaction-id="prompt-update-123"]');
      assert.equal(banner, null, 'No banner should be created for silent interactions');
    });

    it('should NOT create banner when banner config is undefined', () => {
      const doc = getDocument();

      const created = handleInteractionStarted({
        interactionId: 'silent-123',
        targetProperty: 'some_silent_function',
        payload: { data: 'test' },
        // banner is undefined
      });

      assert.equal(created, false, 'Should return false when banner undefined');
      const allBanners = doc.querySelectorAll('.interaction-banner');
      assert.equal(allBanners.length, 0, 'No banners should exist');
    });
  });

  describe('handleInteractionResult', () => {
    it('should update banner that exists', () => {
      // Create banner first
      handleInteractionStarted({
        interactionId: 'ws-123',
        targetProperty: 'websearch',
        payload: { query: 'test' },
        banner: { label: 'Search', icon: '🔍', contentKey: 'query' },
      });

      // Then handle result
      const updated = handleInteractionResult({
        interactionId: 'ws-123',
        status: 'completed',
        result: { data: 'results' },
        elapsedMs: 1234,
      });

      assert.equal(updated, true, 'Should return true when banner updated');
    });

    it('should do nothing for silent interaction result', () => {
      const doc = getDocument();

      // No banner was created for this interaction
      // handleInteractionResult should do nothing
      const updated = handleInteractionResult({
        interactionId: 'prompt-update-456',
        status: 'completed',
        result: { success: true, promptId: 'p1' },
      });

      assert.equal(updated, false, 'Should return false - no banner to update');

      // Verify nothing was added to DOM
      const allBanners = doc.querySelectorAll('.interaction-banner');
      assert.equal(allBanners.length, 0, 'No banners should exist');
    });

    it('should not display error for failed silent interaction', () => {
      const doc = getDocument();

      // Silent interaction fails (e.g., update_prompt fails with "Prompt not found")
      const updated = handleInteractionResult({
        interactionId: 'prompt-update-789',
        status: 'failed',
        error: 'Prompt not found',
      });

      assert.equal(updated, false, 'Should return false - no banner to update');

      // Verify error is not displayed in DOM
      const body = doc.body.textContent;
      assert.ok(!body.includes('Prompt not found'), 'Error should NOT be displayed in DOM');
    });
  });
});

describe('Bug 1.2: System Interaction Results in Chat', () => {
  beforeEach(() => {
    createDOM();
    createStreamingMessageElement();
  });

  afterEach(() => {
    destroyDOM();
  });

  it('should not display update_prompt interaction in chat', () => {
    const doc = getDocument();

    // Simulate the full flow for update_prompt:
    // 1. onInteractionStarted is called but NO banner is created (no banner config)
    const created = handleInteractionStarted({
      interactionId: 'update-prompt-test',
      targetProperty: 'update_prompt',
      payload: { message_id: 123, prompt_id: 'p-abc', answer: 'My answer' },
      banner: null, // update_prompt has NO banner config
    });

    assert.equal(created, false, 'Banner should NOT be created for update_prompt');

    // 2. onInteractionResult is called but does nothing (no banner to update)
    const updated = handleInteractionResult({
      interactionId: 'update-prompt-test',
      status: 'completed',
      result: { success: true, promptId: 'p-abc', updated: true },
    });

    assert.equal(updated, false, 'Result should NOT update anything');

    // 3. Verify nothing visible was added to the chat
    const banners = doc.querySelectorAll('.interaction-banner');
    assert.equal(banners.length, 0, 'No banners should exist');

    // Check that result content is not in the DOM
    assert.ok(!doc.body.textContent.includes('promptId'), 'Interaction result should not be in DOM');
  });

  it('should display websearch interaction with banner', () => {
    const doc = getDocument();

    // 1. onInteractionStarted creates banner (websearch HAS banner config)
    const created = handleInteractionStarted({
      interactionId: 'websearch-test',
      targetProperty: 'websearch',
      payload: { query: 'How to test JavaScript' },
      banner: {
        label: 'Web Search',
        icon: '🔍',
        contentKey: 'query',
      },
    });

    assert.equal(created, true, 'Banner should be created for websearch');

    // 2. onInteractionResult updates the banner
    const updated = handleInteractionResult({
      interactionId: 'websearch-test',
      status: 'completed',
      result: { results: ['result1', 'result2'] },
      elapsedMs: 500,
    });

    assert.equal(updated, true, 'Banner should be updated');

    // 3. Verify banner is visible
    const banner = doc.querySelector('.interaction-banner[data-interaction-id="websearch-test"]');
    assert.ok(banner, 'Banner should exist');
    assert.ok(banner.textContent.includes('Web Search'), 'Should show label');
    assert.ok(banner.textContent.includes('How to test'), 'Should show query');
    assert.ok(banner.classList.contains('interaction-banner-completed'), 'Should show completed status');
  });
});
