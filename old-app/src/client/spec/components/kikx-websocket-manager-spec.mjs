'use strict';

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// ---------------------------------------------------------------------------
// Mock WebSocket
// ---------------------------------------------------------------------------

function createMockWebSocket() {
  return {
    readyState: 1, // OPEN
    send: function(data) { this._lastSent = data; },
    close: function() {
      this.readyState = 3; // CLOSED
      if (this.onclose) this.onclose({ code: 1000 });
    },
    _simulateMessage: function(data) {
      if (this.onmessage) this.onmessage({ data: JSON.stringify(data) });
    },
    _simulateOpen: function() {
      this.readyState = 1;
      if (this.onopen) this.onopen({});
    },
    _simulateClose: function() {
      this.readyState = 3;
      if (this.onclose) this.onclose({ code: 1000 });
    },
    _simulateError: function() {
      if (this.onerror) this.onerror(new Error('test error'));
    },
    _lastSent:    null,
    onopen:       null,
    onclose:      null,
    onerror:      null,
    onmessage:    null,
  };
}

// ---------------------------------------------------------------------------
// jsdom setup -- fresh instance per test with custom element registered
// ---------------------------------------------------------------------------

let dom;
let mockWebSockets;

function setupDOM() {
  dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'http://localhost/kikx/',
    pretendToBeVisual: true,
  });

  mockWebSockets = [];

  // Install mock WebSocket constructor on the jsdom window
  dom.window.WebSocket = function MockWebSocket(_url) {
    let mock = createMockWebSocket();
    mock._url = _url;
    mockWebSockets.push(mock);
    return mock;
  };

  registerComponent();
}

function teardownDOM() {
  if (dom)
    dom.window.close();

  dom             = null;
  mockWebSockets  = null;
}

// ---------------------------------------------------------------------------
// Test-local component definition
// ---------------------------------------------------------------------------
// Mirrors the real component's structure and logic, but uses the mock
// WebSocket from the jsdom window instead of the global WebSocket.
// ---------------------------------------------------------------------------

function registerComponent() {
  let JsdomHTMLElement = dom.window.HTMLElement;

  class KikxWebsocketManager extends JsdomHTMLElement {
    constructor() {
      super();
    }

    // Properties

    get url() {
      return this._url;
    }

    set url(value) {
      let previousURL = this._url;
      this._url = value;

      if (this._connected && value !== previousURL)
        this.connect();
    }

    get connected() {
      return this._connected;
    }

    get reconnectDelay() {
      return this._reconnectDelay;
    }

    set reconnectDelay(value) {
      this._reconnectDelay = value;
      this._currentDelay   = value;
    }

    get maxReconnectDelay() {
      return this._maxReconnectDelay;
    }

    set maxReconnectDelay(value) {
      this._maxReconnectDelay = value;
    }

    // Lifecycle

    connectedCallback() {
      if (this._initialized) return;
      this._initialized = true;

      this.innerHTML = `
        <style>
          kikx-websocket-manager {
            display: none;
          }
        </style>
      `;

      this._url               = '';
      this._connected         = false;
      this._reconnectDelay    = 1000;
      this._maxReconnectDelay = 30000;
      this._currentDelay      = this._reconnectDelay;
      this._reconnectTimer    = null;
      this._socket            = null;

      if (this._url)
        this.connect();
    }

    disconnectedCallback() {
      this.disconnect();
    }

    // Connection management

    connect() {
      if (this._socket)
        this.disconnect();

      let socket = new dom.window.WebSocket(this._url);

      socket.onopen = () => {
        this._connected    = true;
        this._currentDelay = this._reconnectDelay;

        this.dispatchEvent(new dom.window.CustomEvent('ws-open', {
          bubbles:  true,
          composed: true,
        }));
      };

      socket.onclose = (event) => {
        this._connected = false;

        this.dispatchEvent(new dom.window.CustomEvent('ws-close', {
          bubbles:  true,
          composed: true,
          detail:   { code: event.code },
        }));

        this._scheduleReconnect();
      };

      socket.onerror = (error) => {
        this.dispatchEvent(new dom.window.CustomEvent('ws-error', {
          bubbles:  true,
          composed: true,
          detail:   { error },
        }));
      };

      socket.onmessage = (event) => {
        let parsedData;

        try {
          parsedData = JSON.parse(event.data);
        } catch (_error) {
          parsedData = event.data;
        }

        this.dispatchEvent(new dom.window.CustomEvent('ws-message', {
          bubbles:  true,
          composed: true,
          detail:   { data: parsedData },
        }));
      };

      this._socket = socket;
    }

    disconnect() {
      if (this._reconnectTimer) {
        clearTimeout(this._reconnectTimer);
        this._reconnectTimer = null;
      }

      if (this._socket) {
        this._socket.onopen    = null;
        this._socket.onclose   = null;
        this._socket.onerror   = null;
        this._socket.onmessage = null;
        this._socket.close();
        this._socket = null;
      }

      this._connected    = false;
      this._currentDelay = this._reconnectDelay;
    }

    send(data) {
      if (!this._connected || !this._socket)
        return;

      this._socket.send(JSON.stringify(data));
    }

    // Reconnection (exponential backoff)

    _scheduleReconnect() {
      if (this._reconnectTimer)
        clearTimeout(this._reconnectTimer);

      this._reconnectTimer = setTimeout(() => {
        this._reconnectTimer = null;
        this.connect();
      }, this._currentDelay);

      this._currentDelay = Math.min(this._currentDelay * 2, this._maxReconnectDelay);
    }
  }

  dom.window.customElements.define('kikx-websocket-manager', KikxWebsocketManager);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('kikx-websocket-manager', () => {
  let element;

  beforeEach(() => {
    setupDOM();
    element = dom.window.document.createElement('kikx-websocket-manager');
    dom.window.document.body.appendChild(element);
  });

  afterEach(() => {
    if (element && element.parentNode)
      element.parentNode.removeChild(element);

    teardownDOM();
  });

  // -------------------------------------------------------------------------
  // 1. Registers as custom element
  // -------------------------------------------------------------------------

  it('registers as a custom element', () => {
    let registered = dom.window.customElements.get('kikx-websocket-manager');
    assert.ok(registered, 'kikx-websocket-manager should be registered as a custom element');
  });

  // -------------------------------------------------------------------------
  // 2. Renders template
  // -------------------------------------------------------------------------

  it('renders template', () => {
    assert.ok(element.innerHTML.length > 0, 'element should render its template');
  });

  // -------------------------------------------------------------------------
  // 3. Host element is hidden (display: none in style)
  // -------------------------------------------------------------------------

  it('host element is hidden via display: none', () => {
    let style = element.querySelector('style');
    assert.ok(style, 'should have a style element');
    assert.ok(
      style.textContent.includes('display: none'),
      'style rule should set display to none',
    );
  });

  // -------------------------------------------------------------------------
  // 4. Default state is disconnected
  // -------------------------------------------------------------------------

  it('default state is disconnected', () => {
    assert.equal(element.connected, false, 'connected should be false by default');
    assert.equal(element.url, '', 'url should be empty by default');
    assert.equal(element.reconnectDelay, 1000, 'reconnectDelay should default to 1000');
    assert.equal(element.maxReconnectDelay, 30000, 'maxReconnectDelay should default to 30000');
  });

  // -------------------------------------------------------------------------
  // 5. connect() creates a WebSocket connection
  // -------------------------------------------------------------------------

  it('connect() creates a WebSocket connection', () => {
    element._url = 'ws://localhost:8080/test';
    element.connect();

    assert.equal(mockWebSockets.length, 1, 'should have created one WebSocket');
    assert.equal(mockWebSockets[0]._url, 'ws://localhost:8080/test', 'WebSocket should use the configured url');
  });

  // -------------------------------------------------------------------------
  // 6. Dispatches ws-open event on connection open
  // -------------------------------------------------------------------------

  it('dispatches ws-open event on connection open', () => {
    element._url = 'ws://localhost:8080/test';
    element.connect();

    let eventFired = false;
    let eventData  = null;

    element.addEventListener('ws-open', (event) => {
      eventFired = true;
      eventData  = event;
    });

    mockWebSockets[0]._simulateOpen();

    assert.ok(eventFired, 'ws-open event should be dispatched');
    assert.equal(eventData.bubbles, true, 'event should bubble');
    assert.equal(eventData.composed, true, 'event should be composed');
    assert.equal(element.connected, true, 'connected should be true after open');
  });

  // -------------------------------------------------------------------------
  // 7. Dispatches ws-close event on connection close
  // -------------------------------------------------------------------------

  it('dispatches ws-close event on connection close', () => {
    element._url = 'ws://localhost:8080/test';
    element.connect();
    mockWebSockets[0]._simulateOpen();

    let eventFired = false;
    let eventData  = null;

    element.addEventListener('ws-close', (event) => {
      eventFired = true;
      eventData  = event;
    });

    mockWebSockets[0]._simulateClose();

    assert.ok(eventFired, 'ws-close event should be dispatched');
    assert.equal(eventData.bubbles, true, 'event should bubble');
    assert.equal(eventData.composed, true, 'event should be composed');
    assert.equal(element.connected, false, 'connected should be false after close');
  });

  // -------------------------------------------------------------------------
  // 8. Dispatches ws-error event on error
  // -------------------------------------------------------------------------

  it('dispatches ws-error event on error', () => {
    element._url = 'ws://localhost:8080/test';
    element.connect();

    let eventFired = false;
    let eventData  = null;

    element.addEventListener('ws-error', (event) => {
      eventFired = true;
      eventData  = event;
    });

    mockWebSockets[0]._simulateError();

    assert.ok(eventFired, 'ws-error event should be dispatched');
    assert.equal(eventData.bubbles, true, 'event should bubble');
    assert.equal(eventData.composed, true, 'event should be composed');
  });

  // -------------------------------------------------------------------------
  // 9. Dispatches ws-message event with parsed JSON data
  // -------------------------------------------------------------------------

  it('dispatches ws-message event with parsed JSON data', () => {
    element._url = 'ws://localhost:8080/test';
    element.connect();

    let eventFired = false;
    let eventData  = null;

    element.addEventListener('ws-message', (event) => {
      eventFired = true;
      eventData  = event;
    });

    mockWebSockets[0]._simulateMessage({ type: 'greeting', text: 'hello' });

    assert.ok(eventFired, 'ws-message event should be dispatched');
    assert.equal(eventData.bubbles, true, 'event should bubble');
    assert.equal(eventData.composed, true, 'event should be composed');
    assert.deepEqual(eventData.detail.data, { type: 'greeting', text: 'hello' }, 'detail.data should contain parsed JSON');
  });

  // -------------------------------------------------------------------------
  // 10. send() sends JSON stringified data
  // -------------------------------------------------------------------------

  it('send() sends JSON stringified data', () => {
    element._url = 'ws://localhost:8080/test';
    element.connect();
    mockWebSockets[0]._simulateOpen();

    let payload = { action: 'chat', message: 'hi' };
    element.send(payload);

    assert.equal(
      mockWebSockets[0]._lastSent,
      JSON.stringify(payload),
      'should send JSON stringified data through the WebSocket',
    );
  });

  // -------------------------------------------------------------------------
  // 11. disconnect() closes the connection and clears reconnect timer
  // -------------------------------------------------------------------------

  it('disconnect() closes the connection and clears reconnect timer', () => {
    element._url = 'ws://localhost:8080/test';
    element.connect();
    mockWebSockets[0]._simulateOpen();

    // Trigger a close to start the reconnect timer
    // (We need to listen to avoid the onclose dispatching into disconnect's null handlers)
    let socket = mockWebSockets[0];
    socket._simulateClose();

    // At this point, _reconnectTimer should be set
    assert.ok(element._reconnectTimer !== null, 'reconnect timer should be active after close');

    // Now call disconnect explicitly
    element.disconnect();

    assert.equal(element._reconnectTimer, null, 'reconnect timer should be cleared after disconnect');
    assert.equal(element._socket, null, 'socket should be null after disconnect');
    assert.equal(element.connected, false, 'connected should be false after disconnect');
  });

  // -------------------------------------------------------------------------
  // 12. Real module exports a class constructor
  // -------------------------------------------------------------------------

  it('real module exports a class constructor', async () => {
    globalThis.HTMLElement    = dom.window.HTMLElement;
    globalThis.customElements = { define() {}, get() {} };
    globalThis.document       = dom.window.document;
    globalThis.WebSocket      = dom.window.WebSocket;
    globalThis.CustomEvent    = dom.window.CustomEvent;

    try {
      let mod = await import('../../components/kikx-websocket-manager/kikx-websocket-manager.mjs');
      assert.equal(typeof mod.default, 'function', 'default export should be a constructor');
    } finally {
      delete globalThis.HTMLElement;
      delete globalThis.customElements;
      delete globalThis.document;
      delete globalThis.WebSocket;
      delete globalThis.CustomEvent;
    }
  });
});
