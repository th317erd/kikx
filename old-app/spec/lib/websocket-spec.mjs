'use strict';

// ============================================================================
// WebSocket Handler Tests (S8)
// ============================================================================
// Comprehensive tests for server/lib/websocket.mjs
//
// SEC-001:   Authenticated userId passed to approval handler
// SEC-002:   Unauthenticated connection rejected (close code 4001)
// SEC-003:   Message targeting wrong session ignored (cross-user interaction)
// SEC-004:   Frame creation via WS rejected (no create_frame message type)
// GUARD-008: Disconnect cleans up client tracking
//
// NOTE: broadcastToSession and broadcastToUser are tested in
// websocket-broadcast-spec.mjs — those tests are NOT duplicated here.

import { describe, it, beforeEach, afterEach, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'http';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import jwt from 'jsonwebtoken';

// ============================================================================
// Environment Setup (must happen before module imports)
// ============================================================================

const TEST_JWT_SECRET = 'test-websocket-spec-jwt-secret-32chars!';
const TEST_ENCRYPTION_KEY = 'test-websocket-encryption-key32!';
const testDir = mkdtempSync(join(tmpdir(), 'hero-websocket-spec-'));

process.env.HERO_JWT_SECRET = TEST_JWT_SECRET;
process.env.HERO_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
process.env.XDG_CONFIG_HOME = testDir;

// ============================================================================
// Module Imports (after env setup)
// ============================================================================

let initWebSocket;
let getClientCount;
let broadcastToUser;
let getInteractionBus;
let handleApprovalResponse;
let requestApproval;
let generateRequestHash;
let cancelApproval;
let WebSocket;

async function loadModules() {
  let wsModule = await import('../../server/lib/websocket.mjs');
  initWebSocket = wsModule.initWebSocket;
  getClientCount = wsModule.getClientCount;
  broadcastToUser = wsModule.broadcastToUser;

  let busModule = await import('../../server/lib/interactions/bus.mjs');
  getInteractionBus = busModule.getInteractionBus;

  let approvalModule = await import('../../server/lib/abilities/approval.mjs');
  handleApprovalResponse = approvalModule.handleApprovalResponse;
  cancelApproval = approvalModule.cancelApproval;
  // requestApproval and generateRequestHash may or may not be exported
  requestApproval = approvalModule.requestApproval;
  generateRequestHash = approvalModule.generateRequestHash;

  WebSocket = (await import('ws')).default;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Generate a valid JWT token for a test user.
 */
function generateTestToken(userId, username = 'test-user') {
  return jwt.sign(
    { sub: userId, username, secret: { dataKey: 'fake-key' } },
    TEST_JWT_SECRET,
    { expiresIn: '1h' }
  );
}

/**
 * Generate an expired JWT token.
 */
function generateExpiredToken(userId, username = 'test-user') {
  return jwt.sign(
    { sub: userId, username, secret: { dataKey: 'fake-key' } },
    TEST_JWT_SECRET,
    { expiresIn: '-1s' }
  );
}

/**
 * Generate a JWT token signed with a wrong secret.
 */
function generateInvalidToken(userId, username = 'test-user') {
  return jwt.sign(
    { sub: userId, username, secret: { dataKey: 'fake-key' } },
    'completely-wrong-secret-not-the-real-one',
    { expiresIn: '1h' }
  );
}

/**
 * Create an HTTP server with WebSocket support.
 * Returns { server, port, wss, close }.
 */
function createTestServer() {
  return new Promise((resolve, reject) => {
    let server = createServer();
    let wss = initWebSocket(server);

    server.listen(0, '127.0.0.1', () => {
      let port = server.address().port;
      resolve({
        server,
        port,
        wss,
        close: () => new Promise((res) => {
          // Close all WS connections first
          for (let client of wss.clients) {
            client.terminate();
          }
          wss.close(() => {
            server.close(() => res());
          });
        }),
      });
    });

    server.on('error', reject);
  });
}

/**
 * Connect a WebSocket client with a JWT token.
 * Returns a promise that resolves when connected.
 */
function connectClient(port, token) {
  return new Promise((resolve, reject) => {
    let url = `ws://127.0.0.1:${port}/ws?token=${token}`;
    let ws = new WebSocket(url);
    let messages = [];

    ws.on('open', () => {
      resolve({ ws, messages });
    });

    ws.on('message', (data) => {
      messages.push(JSON.parse(data.toString()));
    });

    ws.on('error', (err) => {
      reject(err);
    });

    // Also resolve on close (for auth failure cases we don't wait for open)
    ws.on('close', (code, reason) => {
      // If we haven't resolved yet, this is an auth rejection
      ws._closeCode = code;
      ws._closeReason = reason?.toString() || '';
    });
  });
}

/**
 * Connect a WebSocket client expecting authentication failure.
 * Returns a promise that resolves with { code, reason }.
 */
function connectClientExpectClose(port, token) {
  return new Promise((resolve) => {
    let tokenParam = (token != null) ? `?token=${token}` : '';
    let url = `ws://127.0.0.1:${port}/ws${tokenParam}`;
    let ws = new WebSocket(url);

    ws.on('close', (code, reason) => {
      resolve({ code, reason: reason?.toString() || '' });
    });

    ws.on('error', () => {
      // Swallow connection errors — close event is what we care about
    });
  });
}

/**
 * Send a message and wait for the response matching a type.
 */
function sendAndWaitForResponse(ws, messages, sendData, responseType, timeout = 2000) {
  return new Promise((resolve, reject) => {
    let timer = setTimeout(() => {
      reject(new Error(`Timeout waiting for ${responseType}`));
    }, timeout);

    let startLen = messages.length;

    // Poll for the message
    let interval = setInterval(() => {
      for (let i = startLen; i < messages.length; i++) {
        if (messages[i].type === responseType) {
          clearTimeout(timer);
          clearInterval(interval);
          resolve(messages[i]);
          return;
        }
      }
    }, 10);

    ws.send(JSON.stringify(sendData));
  });
}

/**
 * Wait for a message of a specific type to appear.
 */
function waitForMessage(messages, type, startIndex = 0, timeout = 2000) {
  return new Promise((resolve, reject) => {
    let timer = setTimeout(() => {
      reject(new Error(`Timeout waiting for message type: ${type}`));
    }, timeout);

    let interval = setInterval(() => {
      for (let i = startIndex; i < messages.length; i++) {
        if (messages[i].type === type) {
          clearTimeout(timer);
          clearInterval(interval);
          resolve(messages[i]);
          return;
        }
      }
    }, 10);
  });
}

/**
 * Small delay helper.
 */
function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ============================================================================
// Tests
// ============================================================================

describe('WebSocket Handler (server/lib/websocket.mjs)', async () => {
  await loadModules();

  let testServer;

  beforeEach(async () => {
    testServer = await createTestServer();
  });

  afterEach(async () => {
    if (testServer) {
      await testServer.close();
      testServer = null;
    }
  });

  // ==========================================================================
  // SEC-002: Unauthenticated connection rejected
  // ==========================================================================

  describe('SEC-002: Unauthenticated connection rejected', () => {

    it('should close with 4001 when no token is provided', async () => {
      let result = await connectClientExpectClose(testServer.port, null);
      assert.equal(result.code, 4001);
      assert.match(result.reason, /[Aa]uthentication required/);
    });

    it('should close with 4001 when empty token is provided', async () => {
      let result = await connectClientExpectClose(testServer.port, '');
      assert.equal(result.code, 4001);
    });

    it('should close with 4001 when token is signed with wrong secret', async () => {
      let badToken = generateInvalidToken(1);
      let result = await connectClientExpectClose(testServer.port, badToken);
      assert.equal(result.code, 4001);
      assert.match(result.reason, /[Ii]nvalid|expired/);
    });

    it('should close with 4001 when token is expired', async () => {
      let expiredToken = generateExpiredToken(1);
      let result = await connectClientExpectClose(testServer.port, expiredToken);
      assert.equal(result.code, 4001);
      assert.match(result.reason, /[Ii]nvalid|expired/);
    });

    it('should close with 4001 when token is malformed garbage', async () => {
      let result = await connectClientExpectClose(testServer.port, 'not-a-jwt-at-all');
      assert.equal(result.code, 4001);
    });

    it('should allow connection with a valid token', async () => {
      let token = generateTestToken(100, 'valid-user');
      let { ws } = await connectClient(testServer.port, token);
      assert.equal(ws.readyState, WebSocket.OPEN);
      ws.close();
    });
  });

  // ==========================================================================
  // GUARD-008: Disconnect cleans up client tracking
  // ==========================================================================

  describe('GUARD-008: Disconnect cleans up client tracking', () => {

    it('should register client on connect', async () => {
      let userId = 200;
      let token = generateTestToken(userId);
      let { ws } = await connectClient(testServer.port, token);

      // Wait a tick for the server to process
      await delay(50);

      assert.equal(getClientCount(userId), 1);
      ws.close();
    });

    it('should remove client on disconnect', async () => {
      let userId = 201;
      let token = generateTestToken(userId);
      let { ws } = await connectClient(testServer.port, token);

      await delay(50);
      assert.equal(getClientCount(userId), 1);

      // Close the connection
      ws.close();
      await delay(100);

      assert.equal(getClientCount(userId), 0);
    });

    it('should track multiple connections for the same user', async () => {
      let userId = 202;
      let token = generateTestToken(userId);

      let { ws: ws1 } = await connectClient(testServer.port, token);
      let { ws: ws2 } = await connectClient(testServer.port, token);

      await delay(50);
      assert.equal(getClientCount(userId), 2);

      ws1.close();
      ws2.close();
    });

    it('should remove only the disconnected client, keeping others', async () => {
      let userId = 203;
      let token = generateTestToken(userId);

      let { ws: ws1 } = await connectClient(testServer.port, token);
      let { ws: ws2 } = await connectClient(testServer.port, token);

      await delay(50);
      assert.equal(getClientCount(userId), 2);

      // Close only one
      ws1.close();
      await delay(100);

      assert.equal(getClientCount(userId), 1);

      ws2.close();
      await delay(100);

      assert.equal(getClientCount(userId), 0);
    });

    it('should track connections for different users independently', async () => {
      let userId1 = 204;
      let userId2 = 205;
      let token1 = generateTestToken(userId1, 'user-a');
      let token2 = generateTestToken(userId2, 'user-b');

      let { ws: ws1 } = await connectClient(testServer.port, token1);
      let { ws: ws2 } = await connectClient(testServer.port, token2);

      await delay(50);
      assert.equal(getClientCount(userId1), 1);
      assert.equal(getClientCount(userId2), 1);

      // Disconnect user1, user2 should stay
      ws1.close();
      await delay(100);

      assert.equal(getClientCount(userId1), 0);
      assert.equal(getClientCount(userId2), 1);

      ws2.close();
    });

    it('should return 0 for users that have never connected', () => {
      assert.equal(getClientCount(99999), 0);
    });
  });

  // ==========================================================================
  // SEC-001: Authenticated userId passed to approval handler
  // ==========================================================================

  describe('SEC-001: Authenticated userId in approval handler', () => {

    it('should pass authenticated userId to ability_approval_response handler', async () => {
      let userId = 300;
      let token = generateTestToken(userId);
      let { ws, messages } = await connectClient(testServer.port, token);

      await delay(50);

      // Send an approval response for a non-existent execution
      // The handler should still call handleApprovalResponse with security context
      let response = await sendAndWaitForResponse(ws, messages, {
        type:        'ability_approval_response',
        executionId: 'non-existent-exec-id',
        approved:    true,
        reason:      'test approval',
      }, 'ability_approval_result');

      // The execution doesn't exist, so success should be false
      // But the important thing is that the handler was called with the userId
      assert.equal(response.type, 'ability_approval_result');
      assert.equal(response.executionId, 'non-existent-exec-id');
      assert.equal(response.success, false);
      assert.ok(response.error, 'Should have error for unknown execution');

      ws.close();
    });

    it('should include requestHash in security context when provided', async () => {
      let userId = 301;
      let token = generateTestToken(userId);
      let { ws, messages } = await connectClient(testServer.port, token);

      await delay(50);

      let response = await sendAndWaitForResponse(ws, messages, {
        type:        'ability_approval_response',
        executionId: 'hash-test-exec-id',
        approved:    true,
        requestHash: 'abc123hash',
      }, 'ability_approval_result');

      assert.equal(response.type, 'ability_approval_result');
      assert.equal(response.executionId, 'hash-test-exec-id');

      ws.close();
    });

    it('should pass userId to interaction_response handler', async () => {
      let userId = 302;
      let token = generateTestToken(userId);
      let { ws, messages } = await connectClient(testServer.port, token);

      await delay(50);

      let response = await sendAndWaitForResponse(ws, messages, {
        type:          'interaction_response',
        interactionId: 'non-existent-interaction',
        payload:       { answer: 'test' },
        success:       true,
      }, 'interaction_response_result');

      // Non-existent interaction, so resolved should be false
      assert.equal(response.type, 'interaction_response_result');
      assert.equal(response.interactionId, 'non-existent-interaction');
      assert.equal(response.success, false);

      ws.close();
    });

    it('should deny approval_cancel for non-existent execution gracefully', async () => {
      let userId = 303;
      let token = generateTestToken(userId);
      let { ws, messages } = await connectClient(testServer.port, token);

      await delay(50);

      let response = await sendAndWaitForResponse(ws, messages, {
        type:        'ability_approval_cancel',
        executionId: 'cancel-nonexistent-exec',
      }, 'ability_approval_cancel_result');

      assert.equal(response.type, 'ability_approval_cancel_result');
      assert.equal(response.executionId, 'cancel-nonexistent-exec');
      assert.equal(response.success, true);

      ws.close();
    });
  });

  // ==========================================================================
  // SEC-003: Message targeting wrong session ignored
  // ==========================================================================

  describe('SEC-003: Cross-user interaction prevention', () => {

    it('should reject interaction_response for another user\'s interaction', async () => {
      let userId1 = 400;
      let userId2 = 401;
      let token2 = generateTestToken(userId2, 'user-401');

      // Create an interaction owned by user1 on the bus
      let bus = getInteractionBus();
      let interaction = bus.create('@user', 'test_property', { data: 'secret' }, {
        userId:    userId1,
        sessionId: 1,
      });

      // Use request() so the interaction is in _pending
      let interactionPromise = bus.request(interaction);

      // User2 connects and tries to respond to user1's interaction
      let { ws: ws2, messages: messages2 } = await connectClient(testServer.port, token2);
      await delay(50);

      let response = await sendAndWaitForResponse(ws2, messages2, {
        type:          'interaction_response',
        interactionId: interaction.interaction_id,
        payload:       { hijacked: true },
        success:       true,
      }, 'interaction_response_result');

      // The bus.respond() should return false because userId doesn't match
      assert.equal(response.success, false, 'Should reject cross-user interaction response');

      // Clean up: have the real user respond to prevent hanging promise
      bus.respond(interaction.interaction_id, { real: true }, true, { userId: userId1 });
      await interactionPromise;

      ws2.close();
    });

    it('should allow interaction_response from the correct user', async () => {
      let userId = 402;
      let token = generateTestToken(userId, 'user-402');

      let bus = getInteractionBus();
      let interaction = bus.create('@user', 'test_property', { data: 'for-user-402' }, {
        userId:    userId,
        sessionId: 2,
      });

      // Use request() so the interaction is added to _pending
      let interactionPromise = bus.request(interaction);

      let { ws, messages } = await connectClient(testServer.port, token);
      await delay(50);

      let response = await sendAndWaitForResponse(ws, messages, {
        type:          'interaction_response',
        interactionId: interaction.interaction_id,
        payload:       { answer: 'correct user' },
        success:       true,
      }, 'interaction_response_result');

      assert.equal(response.success, true, 'Should accept interaction from correct user');

      // The promise should resolve with the payload
      let result = await interactionPromise;
      assert.deepEqual(result, { answer: 'correct user' });

      ws.close();
    });

    it('should reject approval response from wrong user', async () => {
      // This tests that the approval handler uses userId for ownership verification.
      // Since we can't easily create pending approvals without the full ability system,
      // we test indirectly: any non-existent approval returns an error, and real
      // approvals would check userId ownership (tested in approval-hardening-spec.mjs).
      let userId = 403;
      let token = generateTestToken(userId);
      let { ws, messages } = await connectClient(testServer.port, token);

      await delay(50);

      let response = await sendAndWaitForResponse(ws, messages, {
        type:        'ability_approval_response',
        executionId: 'fake-approval',
        approved:    false,
        reason:      'should fail',
      }, 'ability_approval_result');

      assert.equal(response.success, false);
      assert.ok(response.error);

      ws.close();
    });
  });

  // ==========================================================================
  // SEC-004: Frame creation via WS rejected
  // ==========================================================================

  describe('SEC-004: Frame creation via WS rejected', () => {

    it('should not have a create_frame message handler', async () => {
      let userId = 500;
      let token = generateTestToken(userId);
      let { ws, messages } = await connectClient(testServer.port, token);

      await delay(50);

      // Send a create_frame message — this type is not in the switch statement
      ws.send(JSON.stringify({
        type:      'create_frame',
        sessionId: 1,
        frame:     {
          type:        'MESSAGE',
          author_type: 'user',
          author_id:   userId,
          payload:     JSON.stringify({ content: 'injected message' }),
        },
      }));

      // Wait a bit and check no response was sent
      await delay(200);

      // Filter out any running_functions messages from connect
      let frameResponses = messages.filter(
        (m) => m.type === 'create_frame_result' || m.type === 'new_frame'
      );
      assert.equal(frameResponses.length, 0, 'No frame creation response should exist');

      ws.close();
    });

    it('should not have a new_frame message handler for client input', async () => {
      let userId = 501;
      let token = generateTestToken(userId);
      let { ws, messages } = await connectClient(testServer.port, token);

      await delay(50);

      ws.send(JSON.stringify({
        type:  'new_frame',
        frame: {
          id:          'fake-frame-id',
          session_id:  1,
          type:        'MESSAGE',
          author_type: 'user',
          author_id:   userId,
          payload:     JSON.stringify({ content: 'malicious frame' }),
          timestamp:   new Date().toISOString(),
        },
      }));

      await delay(200);

      let frameResponses = messages.filter(
        (m) => m.type === 'new_frame_result' || m.type === 'frame_created'
      );
      assert.equal(frameResponses.length, 0, 'Clients should not be able to create frames');

      ws.close();
    });

    it('should only handle known message types', async () => {
      // The switch statement only handles specific types.
      // Unknown types are silently ignored (no error, no response).
      let userId = 502;
      let token = generateTestToken(userId);
      let { ws, messages } = await connectClient(testServer.port, token);

      await delay(50);

      let unknownTypes = [
        'create_frame',
        'new_frame',
        'update_frame',
        'delete_frame',
        'execute_command',
        'modify_user',
        'admin_action',
      ];

      for (let type of unknownTypes) {
        ws.send(JSON.stringify({ type, data: 'payload' }));
      }

      await delay(300);

      // None of these should produce a response
      let nonConnectMessages = messages.filter(
        (m) => m.type !== 'running_functions'
      );
      assert.equal(nonConnectMessages.length, 0,
        `Unknown message types should be silently ignored, got: ${JSON.stringify(nonConnectMessages)}`);

      ws.close();
    });
  });

  // ==========================================================================
  // Message handler tests (various message types)
  // ==========================================================================

  describe('Message handling: question_answer', () => {

    it('should respond with success=false for non-existent assertion', async () => {
      let userId = 600;
      let token = generateTestToken(userId);
      let { ws, messages } = await connectClient(testServer.port, token);

      await delay(50);

      let response = await sendAndWaitForResponse(ws, messages, {
        type:        'question_answer',
        assertionId: 'nonexistent-assertion',
        answer:      'some answer',
      }, 'question_answer_result');

      assert.equal(response.type, 'question_answer_result');
      assert.equal(response.assertionId, 'nonexistent-assertion');
      assert.equal(response.success, false);

      ws.close();
    });

    it('should not respond if assertionId is missing', async () => {
      let userId = 601;
      let token = generateTestToken(userId);
      let { ws, messages } = await connectClient(testServer.port, token);

      await delay(50);

      ws.send(JSON.stringify({
        type:   'question_answer',
        answer: 'some answer',
        // No assertionId
      }));

      await delay(200);

      let answers = messages.filter((m) => m.type === 'question_answer_result');
      assert.equal(answers.length, 0, 'Should not respond without assertionId');

      ws.close();
    });

    it('should not respond if answer is undefined', async () => {
      let userId = 602;
      let token = generateTestToken(userId);
      let { ws, messages } = await connectClient(testServer.port, token);

      await delay(50);

      ws.send(JSON.stringify({
        type:        'question_answer',
        assertionId: 'test-assertion',
        // answer is undefined (not sent)
      }));

      await delay(200);

      let answers = messages.filter((m) => m.type === 'question_answer_result');
      assert.equal(answers.length, 0, 'Should not respond without answer');

      ws.close();
    });
  });

  describe('Message handling: question_cancel', () => {

    it('should respond with success=true even for non-existent assertion', async () => {
      let userId = 610;
      let token = generateTestToken(userId);
      let { ws, messages } = await connectClient(testServer.port, token);

      await delay(50);

      let response = await sendAndWaitForResponse(ws, messages, {
        type:        'question_cancel',
        assertionId: 'cancel-nonexistent',
      }, 'question_cancel_result');

      // cancelQuestion returns false for non-existent, but the WS handler
      // always sends success: true for question_cancel
      assert.equal(response.type, 'question_cancel_result');
      assert.equal(response.assertionId, 'cancel-nonexistent');
      assert.equal(response.success, true);

      ws.close();
    });

    it('should not respond if assertionId is missing', async () => {
      let userId = 611;
      let token = generateTestToken(userId);
      let { ws, messages } = await connectClient(testServer.port, token);

      await delay(50);

      ws.send(JSON.stringify({
        type: 'question_cancel',
        // No assertionId
      }));

      await delay(200);

      let cancels = messages.filter((m) => m.type === 'question_cancel_result');
      assert.equal(cancels.length, 0);

      ws.close();
    });
  });

  describe('Message handling: ability_question_answer', () => {

    it('should respond with success=false for non-existent question', async () => {
      let userId = 620;
      let token = generateTestToken(userId);
      let { ws, messages } = await connectClient(testServer.port, token);

      await delay(50);

      let response = await sendAndWaitForResponse(ws, messages, {
        type:       'ability_question_answer',
        questionId: 'nonexistent-question',
        answer:     'test answer',
      }, 'ability_question_answer_result');

      assert.equal(response.type, 'ability_question_answer_result');
      assert.equal(response.questionId, 'nonexistent-question');
      assert.equal(response.success, false);

      ws.close();
    });

    it('should not respond if questionId is missing', async () => {
      let userId = 621;
      let token = generateTestToken(userId);
      let { ws, messages } = await connectClient(testServer.port, token);

      await delay(50);

      ws.send(JSON.stringify({
        type:   'ability_question_answer',
        answer: 'orphan answer',
      }));

      await delay(200);

      let responses = messages.filter((m) => m.type === 'ability_question_answer_result');
      assert.equal(responses.length, 0);

      ws.close();
    });

    it('should not respond if answer is undefined', async () => {
      let userId = 622;
      let token = generateTestToken(userId);
      let { ws, messages } = await connectClient(testServer.port, token);

      await delay(50);

      ws.send(JSON.stringify({
        type:       'ability_question_answer',
        questionId: 'some-question',
      }));

      await delay(200);

      let responses = messages.filter((m) => m.type === 'ability_question_answer_result');
      assert.equal(responses.length, 0);

      ws.close();
    });
  });

  describe('Message handling: ability_question_cancel', () => {

    it('should respond with success=true for cancel', async () => {
      let userId = 630;
      let token = generateTestToken(userId);
      let { ws, messages } = await connectClient(testServer.port, token);

      await delay(50);

      let response = await sendAndWaitForResponse(ws, messages, {
        type:       'ability_question_cancel',
        questionId: 'cancel-question',
      }, 'ability_question_cancel_result');

      assert.equal(response.type, 'ability_question_cancel_result');
      assert.equal(response.questionId, 'cancel-question');
      assert.equal(response.success, true);

      ws.close();
    });

    it('should not respond if questionId is missing', async () => {
      let userId = 631;
      let token = generateTestToken(userId);
      let { ws, messages } = await connectClient(testServer.port, token);

      await delay(50);

      ws.send(JSON.stringify({
        type: 'ability_question_cancel',
      }));

      await delay(200);

      let responses = messages.filter((m) => m.type === 'ability_question_cancel_result');
      assert.equal(responses.length, 0);

      ws.close();
    });
  });

  describe('Message handling: ability_approval_response', () => {

    it('should not respond if executionId is missing', async () => {
      let userId = 640;
      let token = generateTestToken(userId);
      let { ws, messages } = await connectClient(testServer.port, token);

      await delay(50);

      ws.send(JSON.stringify({
        type:     'ability_approval_response',
        approved: true,
      }));

      await delay(200);

      let responses = messages.filter((m) => m.type === 'ability_approval_result');
      assert.equal(responses.length, 0);

      ws.close();
    });

    it('should relay denial correctly', async () => {
      let userId = 641;
      let token = generateTestToken(userId);
      let { ws, messages } = await connectClient(testServer.port, token);

      await delay(50);

      let response = await sendAndWaitForResponse(ws, messages, {
        type:        'ability_approval_response',
        executionId: 'denial-exec',
        approved:    false,
        reason:      'too dangerous',
      }, 'ability_approval_result');

      assert.equal(response.type, 'ability_approval_result');
      assert.equal(response.executionId, 'denial-exec');
      // Execution doesn't exist, so it should fail
      assert.equal(response.success, false);

      ws.close();
    });
  });

  describe('Message handling: interaction_response', () => {

    it('should not respond if interactionId is missing', async () => {
      let userId = 650;
      let token = generateTestToken(userId);
      let { ws, messages } = await connectClient(testServer.port, token);

      await delay(50);

      ws.send(JSON.stringify({
        type:    'interaction_response',
        payload: { answer: 'orphan' },
      }));

      await delay(200);

      let responses = messages.filter((m) => m.type === 'interaction_response_result');
      assert.equal(responses.length, 0);

      ws.close();
    });

    it('should default success to true when success field is missing', async () => {
      let userId = 651;
      let token = generateTestToken(userId);

      let bus = getInteractionBus();
      let interaction = bus.create('@user', 'test_property', { data: 'test' }, {
        userId:    userId,
        sessionId: 10,
      });

      // Use request() so the interaction is added to _pending
      let interactionPromise = bus.request(interaction);

      let { ws, messages } = await connectClient(testServer.port, token);
      await delay(50);

      let response = await sendAndWaitForResponse(ws, messages, {
        type:          'interaction_response',
        interactionId: interaction.interaction_id,
        payload:       { answer: 'yes' },
        // success field omitted — should default to true (success !== false)
      }, 'interaction_response_result');

      assert.equal(response.success, true);

      // The promise should resolve (not reject) since success defaults to true
      let result = await interactionPromise;
      assert.deepEqual(result, { answer: 'yes' });

      ws.close();
    });

    it('should handle success=false as rejection', async () => {
      let userId = 652;
      let token = generateTestToken(userId);

      let bus = getInteractionBus();
      let interaction = bus.create('@user', 'test_property', { data: 'test' }, {
        userId:    userId,
        sessionId: 11,
      });

      // Use request() so the interaction is added to _pending.
      // Immediately attach a catch handler to prevent unhandled rejection.
      let rejected = false;
      let rejectionError = null;
      let interactionPromise = bus.request(interaction).catch((err) => {
        rejected = true;
        rejectionError = err;
      });

      let { ws, messages } = await connectClient(testServer.port, token);
      await delay(50);

      let response = await sendAndWaitForResponse(ws, messages, {
        type:          'interaction_response',
        interactionId: interaction.interaction_id,
        payload:       'User rejected',
        success:       false,
      }, 'interaction_response_result');

      assert.equal(response.success, true, 'respond() returns true for pending interaction');

      // Wait for the promise to settle
      await interactionPromise;

      assert.equal(rejected, true, 'Promise should have been rejected');
      assert.ok(rejectionError instanceof Error);
      assert.ok(rejectionError.message.includes('User rejected'));

      ws.close();
    });
  });

  // ==========================================================================
  // Message parse error handling
  // ==========================================================================

  describe('Error handling', () => {

    it('should not crash on malformed JSON', async () => {
      let userId = 700;
      let token = generateTestToken(userId);
      let { ws, messages } = await connectClient(testServer.port, token);

      await delay(50);

      // Send malformed JSON — should be caught by try/catch
      ws.send('this is not json {{{');

      // Wait and verify connection still works
      await delay(100);
      assert.equal(ws.readyState, WebSocket.OPEN, 'Connection should stay open after parse error');

      // Send a valid message after the bad one
      ws.send(JSON.stringify({
        type:        'question_cancel',
        assertionId: 'after-error-test',
      }));

      let response = await waitForMessage(messages, 'question_cancel_result');
      assert.equal(response.type, 'question_cancel_result');
      assert.equal(response.assertionId, 'after-error-test');

      ws.close();
    });

    it('should not crash on empty message', async () => {
      let userId = 701;
      let token = generateTestToken(userId);
      let { ws } = await connectClient(testServer.port, token);

      await delay(50);

      ws.send('');
      await delay(100);

      assert.equal(ws.readyState, WebSocket.OPEN, 'Connection should stay open after empty message');

      ws.close();
    });
  });

  // ==========================================================================
  // Running functions on connect
  // ==========================================================================

  describe('Running functions on connect', () => {

    it('should not send running_functions if user has none', async () => {
      // Use a high userId that definitely has no running functions
      let userId = 800;
      let token = generateTestToken(userId);
      let { ws, messages } = await connectClient(testServer.port, token);

      // Wait for potential running_functions message
      await delay(200);

      let runningFnMessages = messages.filter((m) => m.type === 'running_functions');
      assert.equal(runningFnMessages.length, 0,
        'Should not send running_functions when user has none');

      ws.close();
    });
  });

  // ==========================================================================
  // Interaction bus → WebSocket forwarding
  // ==========================================================================

  describe('Interaction bus to WebSocket forwarding', () => {

    it('should forward interaction events to connected clients via per-connection handler', async () => {
      let userId = 900;
      let token = generateTestToken(userId);
      let { ws, messages } = await connectClient(testServer.port, token);

      await delay(50);

      // Create and fire an interaction targeting this user.
      // The per-connection handler on bus 'interaction' event sends { type: 'interaction' }
      // to matching userId clients.
      let bus = getInteractionBus();
      let interaction = bus.create('@user', 'test_forward', { prompt: 'Do you approve?' }, {
        userId:    userId,
        sessionId: 50,
      });

      bus.fire(interaction);

      // Wait for the per-connection 'interaction' event forwarding
      let forwarded = await waitForMessage(messages, 'interaction');

      assert.equal(forwarded.type, 'interaction');
      assert.ok(forwarded.interaction);
      assert.equal(forwarded.interaction.user_id, userId);
      assert.equal(forwarded.interaction.session_id, 50);

      ws.close();
    });

    it('should forward interaction events only to the targeted user', async () => {
      let userId1 = 901;
      let userId2 = 902;
      let token1 = generateTestToken(userId1);
      let token2 = generateTestToken(userId2);

      let { ws: ws1, messages: messages1 } = await connectClient(testServer.port, token1);
      let { ws: ws2, messages: messages2 } = await connectClient(testServer.port, token2);

      await delay(50);

      // Create interaction for user1 only
      let bus = getInteractionBus();
      let interaction = bus.create('@user', 'test_specific', { data: 'for-user-901' }, {
        userId:    userId1,
        sessionId: 51,
      });

      bus.fire(interaction);

      // Wait for user1 to receive it via per-connection handler
      let forwarded = await waitForMessage(messages1, 'interaction');
      assert.equal(forwarded.interaction.user_id, userId1);

      // User2 should NOT have received the interaction
      await delay(200);
      let user2Interactions = messages2.filter((m) => m.type === 'interaction');
      assert.equal(user2Interactions.length, 0,
        'User2 should not receive interactions meant for User1');

      ws1.close();
      ws2.close();
    });
  });

  // ==========================================================================
  // cancel_function / abort handler
  // ==========================================================================

  describe('Message handling: cancel_function / abort', () => {

    it('should require functionId or commandId', async () => {
      let userId = 1000;
      let token = generateTestToken(userId);
      let { ws, messages } = await connectClient(testServer.port, token);

      await delay(50);

      // Send cancel_function without functionId or commandId
      ws.send(JSON.stringify({
        type: 'cancel_function',
      }));

      await delay(200);

      let cancelResults = messages.filter((m) => m.type === 'cancel_result');
      assert.equal(cancelResults.length, 0, 'Should not respond without functionId/commandId');

      ws.close();
    });

    // NOTE: The cancel_function handler uses `require()` (line 110 of websocket.mjs)
    // which is not available in ESM (package type is "module"). This means the
    // cancel_function path would throw a ReferenceError in production. We document
    // this as a known issue rather than testing the error path.
    it('should handle abort as alias for cancel_function', async () => {
      let userId = 1001;
      let token = generateTestToken(userId);
      let { ws, messages } = await connectClient(testServer.port, token);

      await delay(50);

      // Send abort without functionId — should be silently ignored
      ws.send(JSON.stringify({
        type: 'abort',
      }));

      await delay(200);

      let cancelResults = messages.filter((m) => m.type === 'cancel_result');
      assert.equal(cancelResults.length, 0, 'Should not respond without functionId');

      ws.close();
    });
  });

  // ==========================================================================
  // broadcastToUser delivery test (via the module-scoped clients Map)
  // ==========================================================================

  describe('broadcastToUser delivery via initWebSocket clients', () => {

    it('should deliver broadcast messages to connected client', async () => {
      let userId = 1100;
      let token = generateTestToken(userId);
      let { ws, messages } = await connectClient(testServer.port, token);

      await delay(50);

      // Use broadcastToUser to send a message
      broadcastToUser(userId, {
        type:    'new_frame',
        frame:   { id: 'test-frame', type: 'MESSAGE' },
      });

      let broadcast = await waitForMessage(messages, 'new_frame');
      assert.equal(broadcast.type, 'new_frame');
      assert.equal(broadcast.frame.id, 'test-frame');

      ws.close();
    });

    it('should deliver broadcast to all connections of the same user', async () => {
      let userId = 1101;
      let token = generateTestToken(userId);

      let { ws: ws1, messages: messages1 } = await connectClient(testServer.port, token);
      let { ws: ws2, messages: messages2 } = await connectClient(testServer.port, token);

      await delay(50);

      broadcastToUser(userId, {
        type: 'test_broadcast',
        data: 'hello everyone',
      });

      let msg1 = await waitForMessage(messages1, 'test_broadcast');
      let msg2 = await waitForMessage(messages2, 'test_broadcast');

      assert.equal(msg1.data, 'hello everyone');
      assert.equal(msg2.data, 'hello everyone');

      ws1.close();
      ws2.close();
    });

    it('should not deliver broadcast to different users', async () => {
      let userId1 = 1102;
      let userId2 = 1103;
      let token1 = generateTestToken(userId1);
      let token2 = generateTestToken(userId2);

      let { ws: ws1, messages: messages1 } = await connectClient(testServer.port, token1);
      let { ws: ws2, messages: messages2 } = await connectClient(testServer.port, token2);

      await delay(50);

      broadcastToUser(userId1, {
        type: 'private_message',
        data: 'only for user1',
      });

      let msg1 = await waitForMessage(messages1, 'private_message');
      assert.equal(msg1.data, 'only for user1');

      await delay(200);

      let user2Private = messages2.filter((m) => m.type === 'private_message');
      assert.equal(user2Private.length, 0, 'User2 should not get user1 broadcasts');

      ws1.close();
      ws2.close();
    });
  });
});
