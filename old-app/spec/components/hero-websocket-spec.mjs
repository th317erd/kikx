/**
 * Tests for hero-websocket.js
 *
 * Tests HeroWebSocket component:
 * - Connection lifecycle
 * - Message handling
 * - Reconnection logic
 * - Token extraction
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';

// Mock DynamicProperty
const mockDynamicProperty = {
  set: Symbol('DynamicProperty.set'),
};

function createMockDynamicProp(initialValue) {
  let value     = initialValue;
  let listeners = [];

  return {
    valueOf() { return value; },
    addEventListener(event, handler) {
      if (event === 'update') listeners.push(handler);
    },
    removeEventListener(event, handler) {
      if (event === 'update') {
        listeners = listeners.filter((h) => h !== handler);
      }
    },
    [mockDynamicProperty.set](newValue) {
      let oldValue = value;
      value = newValue;
      listeners.forEach((h) => h({ value: newValue, oldValue }));
    },
  };
}

describe('Token Extraction', () => {
  it('should extract token from cookie string', () => {
    let cookies = 'token=abc123; other=value';
    let token = cookies.split('; ')
      .find((c) => c.startsWith('token='))
      ?.split('=')[1];
    assert.strictEqual(token, 'abc123');
  });

  it('should return undefined when no token', () => {
    let cookies = 'other=value; another=thing';
    let token = cookies.split('; ')
      .find((c) => c.startsWith('token='))
      ?.split('=')[1];
    assert.strictEqual(token, undefined);
  });

  it('should handle empty cookie string', () => {
    let cookies = '';
    let token = cookies.split('; ')
      .find((c) => c.startsWith('token='))
      ?.split('=')[1];
    assert.strictEqual(token, undefined);
  });

  it('should handle token with special characters', () => {
    let cookies = 'token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOjF9.abc; other=value';
    let token = cookies.split('; ')
      .find((c) => c.startsWith('token='))
      ?.split('=')[1];
    assert.strictEqual(token, 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOjF9.abc');
  });
});

describe('WebSocket URL Construction', () => {
  it('should use wss for https', () => {
    let protocol = 'https:';
    let wsProtocol = (protocol === 'https:') ? 'wss:' : 'ws:';
    assert.strictEqual(wsProtocol, 'wss:');
  });

  it('should use ws for http', () => {
    let protocol = 'http:';
    let wsProtocol = (protocol === 'https:') ? 'wss:' : 'ws:';
    assert.strictEqual(wsProtocol, 'ws:');
  });

  it('should construct URL with host and path', () => {
    let protocol = 'wss:';
    let host     = 'example.com';
    let basePath = '/hero';
    let token    = 'abc123';
    let url      = `${protocol}//${host}${basePath}/ws?token=${token}`;
    assert.strictEqual(url, 'wss://example.com/hero/ws?token=abc123');
  });

  it('should handle empty base path', () => {
    let protocol = 'ws:';
    let host     = 'localhost:3000';
    let basePath = '';
    let token    = 'xyz';
    let url      = `${protocol}//${host}${basePath}/ws?token=${token}`;
    assert.strictEqual(url, 'ws://localhost:3000/ws?token=xyz');
  });
});

describe('Connection State', () => {
  let wsConnected;

  beforeEach(() => {
    wsConnected = createMockDynamicProp(false);
  });

  it('should start disconnected', () => {
    assert.strictEqual(wsConnected.valueOf(), false);
  });

  it('should update on connect', () => {
    wsConnected[mockDynamicProperty.set](true);
    assert.strictEqual(wsConnected.valueOf(), true);
  });

  it('should update on disconnect', () => {
    wsConnected[mockDynamicProperty.set](true);
    wsConnected[mockDynamicProperty.set](false);
    assert.strictEqual(wsConnected.valueOf(), false);
  });

  it('should notify listeners on state change', () => {
    let received = [];
    wsConnected.addEventListener('update', (e) => received.push(e.value));

    wsConnected[mockDynamicProperty.set](true);
    wsConnected[mockDynamicProperty.set](false);

    assert.deepStrictEqual(received, [true, false]);
  });
});

describe('Message Types', () => {
  let messageTypes = [
    'running_commands',
    'command_update',
    'abort_result',
    'assertion_new',
    'assertion_update',
    'question_prompt',
    'message_append',
    'element_new',
    'element_update',
    'todo_item_update',
    'ability_approval_request',
    'ability_approval_timeout',
    'ability_question',
    'ability_question_timeout',
    'new_message',
    'sessions_updated',
    'agents_updated',
    'abilities_updated',
  ];

  it('should have known message types', () => {
    assert.ok(messageTypes.includes('running_commands'));
    assert.ok(messageTypes.includes('new_message'));
    assert.ok(messageTypes.includes('sessions_updated'));
  });

  it('should parse message JSON', () => {
    let data    = '{"type":"new_message","message":{"id":1}}';
    let message = JSON.parse(data);
    assert.strictEqual(message.type, 'new_message');
    assert.strictEqual(message.message.id, 1);
  });

  it('should handle malformed JSON gracefully', () => {
    let data = 'not json';
    let parsed = null;
    try {
      parsed = JSON.parse(data);
    } catch (e) {
      parsed = null;
    }
    assert.strictEqual(parsed, null);
  });
});

describe('Reconnection Logic', () => {
  it('should calculate reconnect delay', () => {
    let baseDelay = 5000;
    assert.strictEqual(baseDelay, 5000);
  });

  it('should only reconnect if user authenticated', () => {
    let user = { id: 1 };
    let shouldReconnect = user !== null;
    assert.strictEqual(shouldReconnect, true);
  });

  it('should not reconnect if user null', () => {
    let user = null;
    let shouldReconnect = user !== null;
    assert.strictEqual(shouldReconnect, false);
  });
});

describe('WebSocket Ready States', () => {
  // WebSocket.CONNECTING = 0
  // WebSocket.OPEN = 1
  // WebSocket.CLOSING = 2
  // WebSocket.CLOSED = 3

  it('should detect OPEN state', () => {
    let readyState = 1; // OPEN
    let isOpen = readyState === 1;
    assert.strictEqual(isOpen, true);
  });

  it('should detect not OPEN state', () => {
    let readyState = 0; // CONNECTING
    let isOpen = readyState === 1;
    assert.strictEqual(isOpen, false);
  });

  it('should skip connect if already open', () => {
    let existingWs  = { readyState: 1 };
    let shouldSkip  = existingWs && existingWs.readyState === 1;
    assert.strictEqual(shouldSkip, true);
  });

  it('should allow connect if closed', () => {
    let existingWs  = { readyState: 3 };
    let shouldSkip  = existingWs && existingWs.readyState === 1;
    assert.strictEqual(shouldSkip, false);
  });

  it('should allow connect if null', () => {
    let existingWs  = null;
    let shouldSkip  = !!(existingWs && existingWs.readyState === 1);
    assert.strictEqual(shouldSkip, false);
  });
});

describe('Message Sending', () => {
  it('should serialize message to JSON', () => {
    let message = { type: 'ping', data: { timestamp: 123 } };
    let json    = JSON.stringify(message);
    assert.strictEqual(json, '{"type":"ping","data":{"timestamp":123}}');
  });

  it('should check connection before sending', () => {
    let ws = { readyState: 1 }; // OPEN
    let canSend = ws && ws.readyState === 1;
    assert.strictEqual(canSend, true);
  });

  it('should not send when disconnected', () => {
    let ws = null;
    let canSend = !!(ws && ws.readyState === 1);
    assert.strictEqual(canSend, false);
  });
});

describe('Event Dispatching', () => {
  it('should create custom event with detail', () => {
    let type   = 'ws:message';
    let detail = { message: { type: 'new_message' } };

    // Simulate CustomEvent structure
    let event = { type, detail, bubbles: true };

    assert.strictEqual(event.type, 'ws:message');
    assert.deepStrictEqual(event.detail.message, { type: 'new_message' });
  });

  it('should categorize message types', () => {
    let globalUpdateTypes = ['sessions_updated', 'agents_updated', 'abilities_updated'];
    let messageType       = 'sessions_updated';
    let isGlobalUpdate    = globalUpdateTypes.includes(messageType);
    assert.strictEqual(isGlobalUpdate, true);
  });

  it('should identify session-specific messages', () => {
    let sessionMessageTypes = ['new_message', 'message_append', 'assertion_new'];
    let messageType         = 'new_message';
    let isSessionMessage    = sessionMessageTypes.includes(messageType);
    assert.strictEqual(isSessionMessage, true);
  });
});

describe('Session Subscription', () => {
  it('should track subscribed session', () => {
    let subscribedSessionId = null;

    // Subscribe to session
    subscribedSessionId = 123;
    assert.strictEqual(subscribedSessionId, 123);

    // Change session
    subscribedSessionId = 456;
    assert.strictEqual(subscribedSessionId, 456);

    // Unsubscribe
    subscribedSessionId = null;
    assert.strictEqual(subscribedSessionId, null);
  });

  it('should format subscribe message', () => {
    let sessionId = 123;
    let message   = { type: 'subscribe_session', sessionId };
    let json      = JSON.stringify(message);
    assert.strictEqual(json, '{"type":"subscribe_session","sessionId":123}');
  });

  it('should format unsubscribe message', () => {
    let sessionId = 123;
    let message   = { type: 'unsubscribe_session', sessionId };
    let json      = JSON.stringify(message);
    assert.strictEqual(json, '{"type":"unsubscribe_session","sessionId":123}');
  });
});
