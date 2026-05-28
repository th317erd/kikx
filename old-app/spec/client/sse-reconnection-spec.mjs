'use strict';

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { setupDOM, teardownDOM, getDocument } from './jsdom-helper.mjs';

// =============================================================================
// SSE Reconnection Tests
// =============================================================================
// Tests for the auto-reconnection logic in _connectStream/_readSSEStream.
// Verifies exponential backoff, max attempts, intentional disconnect cleanup,
// and backoff reset on successful reconnection.
//
// Strategy: create the session page element WITHOUT appending to DOM (avoiding
// connectedCallback side effects). Directly test the SSE methods on the instance.
// =============================================================================

let api;

before(async () => {
  setupDOM();

  // Polyfill globals that components need during registration
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }

  if (!globalThis.Node)
    globalThis.Node = getDocument().defaultView.Node;

  let i18n = await import('../../src/client/lib/i18n.mjs');
  let en   = (await import('../../src/client/lib/locales/en.mjs')).default;
  api      = await import('../../src/client/lib/api.mjs');

  i18n.setLocale(en, 'en');

  // Register components (but we won't append them to DOM)
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

// Create a session page element without triggering connectedCallback
function createPage() {
  let doc  = getDocument();
  let page = doc.createElement('kikx-session-page');
  // Do NOT append to body — avoids connectedCallback side effects

  return page;
}

// Creates a mock ReadableStream that yields chunks and then closes
function createMockStream(chunks = [], { errorAfter } = {}) {
  let readIndex = 0;

  return {
    getReader() {
      return {
        read() {
          if (errorAfter !== undefined && readIndex === errorAfter)
            return Promise.reject(new Error('Stream error'));

          if (readIndex >= chunks.length)
            return Promise.resolve({ done: true, value: undefined });

          let value = new TextEncoder().encode(chunks[readIndex++]);

          return Promise.resolve({ done: false, value });
        },
        releaseLock() {},
      };
    },
  };
}

describe('SSE Reconnection', () => {
  let page;
  let originalFetch;
  let pendingTimers = [];

  beforeEach(() => {
    api.setAuthToken('test-token-123');
    page = createPage();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    page._disconnectStream();
    page = null;
    globalThis.fetch = originalFetch;

    for (let t of pendingTimers)
      clearTimeout(t);

    pendingTimers = [];
  });

  // ---------------------------------------------------------------------------
  // Initialization
  // ---------------------------------------------------------------------------

  describe('initialization', () => {
    it('has correct initial reconnection state', () => {
      assert.equal(page._sseReconnectAttempts, 0);
      assert.equal(page._sseReconnectTimer, null);
      assert.equal(page._sseSessionID, null);
    });

    it('sets _sseSessionID when _connectStream is called', () => {
      globalThis.fetch = () => new Promise(() => {});
      page._connectStream('ses_abc');

      assert.equal(page._sseSessionID, 'ses_abc');
      assert.equal(page._sseReconnectAttempts, 0);
    });

    it('resets attempt counter when _connectStream is called', () => {
      page._sseReconnectAttempts = 5;
      globalThis.fetch = () => new Promise(() => {});
      page._connectStream('ses_abc');

      assert.equal(page._sseReconnectAttempts, 0);
    });
  });

  // ---------------------------------------------------------------------------
  // Intentional disconnect
  // ---------------------------------------------------------------------------

  describe('intentional disconnect', () => {
    it('clears all reconnection state', () => {
      globalThis.fetch = () => new Promise(() => {});
      page._connectStream('ses_abc');
      page._sseReconnectAttempts = 5;

      page._disconnectStream();

      assert.equal(page._sseSessionID, null);
      assert.equal(page._sseReconnectAttempts, 0);
      assert.equal(page._sseReconnectTimer, null);
      assert.equal(page._streamAbort, null);
    });

    it('clears pending reconnect timer', () => {
      page._sseSessionID = 'ses_abc';
      page._scheduleReconnect();
      assert.ok(page._sseReconnectTimer !== null);

      page._disconnectStream();
      assert.equal(page._sseReconnectTimer, null);
    });
  });

  // ---------------------------------------------------------------------------
  // _scheduleReconnect
  // ---------------------------------------------------------------------------

  describe('_scheduleReconnect', () => {
    it('does nothing when _sseSessionID is null', () => {
      page._sseSessionID = null;
      page._sseReconnectAttempts = 0;

      page._scheduleReconnect();

      assert.equal(page._sseReconnectTimer, null);
      assert.equal(page._sseReconnectAttempts, 0);
    });

    it('does nothing when max attempts (20) reached', () => {
      page._sseSessionID = 'ses_abc';
      page._sseReconnectAttempts = 20;

      page._scheduleReconnect();

      assert.equal(page._sseReconnectTimer, null);
    });

    it('increments attempt counter', () => {
      page._sseSessionID = 'ses_abc';
      page._sseReconnectAttempts = 0;

      page._scheduleReconnect();
      assert.equal(page._sseReconnectAttempts, 1);

      clearTimeout(page._sseReconnectTimer);
      page._sseReconnectTimer = null;

      page._scheduleReconnect();
      assert.equal(page._sseReconnectAttempts, 2);
    });

    it('sets a reconnect timer', () => {
      page._sseSessionID = 'ses_abc';
      page._scheduleReconnect();

      assert.ok(page._sseReconnectTimer !== null);
    });

    it('uses exponential backoff: 2s, 4s, 8s, 16s', () => {
      page._sseSessionID = 'ses_abc';
      let capturedDelays = [];
      let origSetTimeout = globalThis.setTimeout;

      globalThis.setTimeout = (fn, delay) => {
        capturedDelays.push(delay);
        let id = origSetTimeout(() => {}, 999999);
        pendingTimers.push(id);

        return id;
      };

      for (let i = 0; i < 4; i++) {
        if (page._sseReconnectTimer) {
          clearTimeout(page._sseReconnectTimer);
          page._sseReconnectTimer = null;
        }

        page._scheduleReconnect();
      }

      globalThis.setTimeout = origSetTimeout;

      assert.deepEqual(capturedDelays, [2000, 4000, 8000, 16000]);
    });

    it('caps backoff delay at 30 seconds', () => {
      page._sseSessionID = 'ses_abc';
      page._sseReconnectAttempts = 10; // 2000 * 2^10 = 2,048,000ms > 30,000ms

      let capturedDelay = null;
      let origSetTimeout = globalThis.setTimeout;

      globalThis.setTimeout = (fn, delay) => {
        capturedDelay = delay;
        let id = origSetTimeout(() => {}, 999999);
        pendingTimers.push(id);

        return id;
      };

      page._scheduleReconnect();

      globalThis.setTimeout = origSetTimeout;

      assert.equal(capturedDelay, 30000);
    });

    it('stops scheduling at attempt 19 (last allowed)', () => {
      page._sseSessionID = 'ses_abc';
      page._sseReconnectAttempts = 19;

      page._scheduleReconnect();
      assert.ok(page._sseReconnectTimer !== null, 'attempt 19 should schedule');
      assert.equal(page._sseReconnectAttempts, 20);

      clearTimeout(page._sseReconnectTimer);
      page._sseReconnectTimer = null;

      // At 20, should NOT schedule
      page._scheduleReconnect();
      assert.equal(page._sseReconnectTimer, null, 'attempt 20 should NOT schedule');
    });
  });

  // ---------------------------------------------------------------------------
  // _openSSEConnection — reconnect triggers
  // ---------------------------------------------------------------------------

  describe('reconnect triggers', () => {
    it('schedules reconnect after successful stream ends', async () => {
      page._sseSessionID = 'ses_abc';

      let reconnectCalled = false;
      page._scheduleReconnect = () => { reconnectCalled = true; };

      let stream = createMockStream([]); // immediately ends
      globalThis.fetch = () => Promise.resolve({
        ok:      true,
        headers: new Map(),
        body:    stream,
      });

      page._openSSEConnection('ses_abc');
      await new Promise((r) => setTimeout(r, 50));

      assert.ok(reconnectCalled, 'reconnect should be scheduled after stream ends');
    });

    it('schedules reconnect after stream read error', async () => {
      page._sseSessionID = 'ses_abc';

      let reconnectCalled = false;
      page._scheduleReconnect = () => { reconnectCalled = true; };

      let stream = createMockStream([], { errorAfter: 0 });
      globalThis.fetch = () => Promise.resolve({
        ok:      true,
        headers: new Map(),
        body:    stream,
      });

      page._openSSEConnection('ses_abc');
      await new Promise((r) => setTimeout(r, 50));

      assert.ok(reconnectCalled, 'reconnect should be scheduled after stream error');
    });

    it('schedules reconnect after fetch network error', async () => {
      page._sseSessionID = 'ses_abc';

      let reconnectCalled = false;
      page._scheduleReconnect = () => { reconnectCalled = true; };

      globalThis.fetch = () => Promise.reject(new Error('Network error'));

      page._openSSEConnection('ses_abc');
      await new Promise((r) => setTimeout(r, 50));

      assert.ok(reconnectCalled, 'reconnect should be scheduled after network error');
    });

    it('schedules reconnect after HTTP error (503)', async () => {
      page._sseSessionID = 'ses_abc';

      let reconnectCalled = false;
      page._scheduleReconnect = () => { reconnectCalled = true; };

      globalThis.fetch = () => Promise.resolve({
        ok:         false,
        status:     503,
        statusText: 'Service Unavailable',
        headers:    new Map(),
      });

      page._openSSEConnection('ses_abc');
      await new Promise((r) => setTimeout(r, 50));

      assert.ok(reconnectCalled, 'reconnect should be scheduled after HTTP error');
    });

    it('does NOT schedule reconnect after AbortError (intentional disconnect)', async () => {
      page._sseSessionID = 'ses_abc';

      let reconnectCalled = false;
      page._scheduleReconnect = () => { reconnectCalled = true; };

      let abortError = new Error('Aborted');
      abortError.name = 'AbortError';
      globalThis.fetch = () => Promise.reject(abortError);

      page._openSSEConnection('ses_abc');
      await new Promise((r) => setTimeout(r, 50));

      assert.ok(!reconnectCalled, 'reconnect should NOT be scheduled after AbortError');
    });
  });

  // ---------------------------------------------------------------------------
  // Backoff reset
  // ---------------------------------------------------------------------------

  describe('backoff reset', () => {
    it('resets attempt counter on successful connection', async () => {
      page._sseReconnectAttempts = 5;

      let connectedEvent = 'event: connected\ndata: {}\n\n';
      let stream = createMockStream([connectedEvent]);

      // Stub _scheduleReconnect so stream-end doesn't interfere
      page._scheduleReconnect = () => {};

      globalThis.fetch = () => Promise.resolve({
        ok:      true,
        headers: new Map(),
        body:    stream,
      });

      page._openSSEConnection('ses_abc');
      await new Promise((r) => setTimeout(r, 50));

      assert.equal(page._sseReconnectAttempts, 0, 'counter should reset on successful connection');
    });
  });

  // ---------------------------------------------------------------------------
  // SSE event processing during stream
  // ---------------------------------------------------------------------------

  describe('event processing', () => {
    it('processes events before stream ends', async () => {
      page._sseSessionID = 'ses_abc';

      let events = [];
      page._handleSSEEvent = (type, data) => { events.push({ type, data }); };
      page._scheduleReconnect = () => {};

      let chunk = 'event: connected\ndata: {}\n\nevent: frame\ndata: {"id":"frm_1","type":"command-result","content":{"html":"ok"}}\n\n';
      let stream = createMockStream([chunk]);

      globalThis.fetch = () => Promise.resolve({
        ok:      true,
        headers: new Map(),
        body:    stream,
      });

      page._openSSEConnection('ses_abc');
      await new Promise((r) => setTimeout(r, 50));

      assert.equal(events.length, 2);
      assert.equal(events[0].type, 'connected');
      assert.equal(events[1].type, 'frame');
    });

    it('handles multi-chunk streams', async () => {
      page._sseSessionID = 'ses_abc';

      let events = [];
      page._handleSSEEvent = (type, data) => { events.push({ type, data }); };
      page._scheduleReconnect = () => {};

      let chunk1 = 'event: connected\ndata: {}\n\n';
      let chunk2 = 'event: frame\ndata: {"id":"frm_2","type":"message","content":{"html":"hi"}}\n\n';
      let stream = createMockStream([chunk1, chunk2]);

      globalThis.fetch = () => Promise.resolve({
        ok:      true,
        headers: new Map(),
        body:    stream,
      });

      page._openSSEConnection('ses_abc');
      await new Promise((r) => setTimeout(r, 50));

      assert.equal(events.length, 2);
      assert.equal(events[0].type, 'connected');
      assert.equal(events[1].type, 'frame');
    });
  });

  // ---------------------------------------------------------------------------
  // Full reconnection cycle
  // ---------------------------------------------------------------------------

  describe('full reconnection cycle', () => {
    it('reconnects after stream drop when timer fires', async () => {
      page._sseSessionID = 'ses_abc';
      let connectionCount = 0;

      // First call: stream immediately drops
      // Second call: also drops (but proves reconnect happened)
      globalThis.fetch = () => {
        connectionCount++;
        let stream = createMockStream([]);

        return Promise.resolve({
          ok:      true,
          headers: new Map(),
          body:    stream,
        });
      };

      // Use real setTimeout but with short delays
      let origSchedule = page._scheduleReconnect.bind(page);
      page._scheduleReconnect = () => {
        if (!page._sseSessionID || page._sseReconnectAttempts >= 2)
          return;

        page._sseReconnectAttempts++;

        // Schedule with very short delay for testing
        page._sseReconnectTimer = setTimeout(() => {
          page._sseReconnectTimer = null;

          if (page._sseSessionID)
            page._openSSEConnection(page._sseSessionID);
        }, 10);
      };

      page._openSSEConnection('ses_abc');

      // Wait enough time for the reconnect to happen
      await new Promise((r) => setTimeout(r, 200));

      assert.ok(connectionCount >= 2, `should have reconnected at least once (count: ${connectionCount})`);
    });
  });
});
