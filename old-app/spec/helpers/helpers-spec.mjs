'use strict';

// ============================================================================
// Helper Module Tests
// ============================================================================
// Tests for the test infrastructure helpers: sse-mock, route-helpers, db-helpers.
// At least 3 tests per helper module.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createSSEResponse, parseSSE } from './sse-mock.mjs';
import { createMockRequest, createMockResponse, callRoute } from './route-helpers.mjs';
import { createTestDatabase, seedUser, seedAgent, seedSession, resetCounters } from './db-helpers.mjs';

// ============================================================================
// SSE Mock Tests
// ============================================================================

describe('SSE Mock', () => {
  let response;

  beforeEach(() => {
    response = createSSEResponse();
  });

  // --------------------------------------------------------------------------
  // createSSEResponse
  // --------------------------------------------------------------------------

  describe('createSSEResponse', () => {
    it('should capture headers set via setHeader', () => {
      response.setHeader('Content-Type', 'text/event-stream');
      response.setHeader('Cache-Control', 'no-cache');

      let headers = response.getHeaders();
      assert.equal(headers['Content-Type'], 'text/event-stream');
      assert.equal(headers['Cache-Control'], 'no-cache');
    });

    it('should capture headers set via writeHead', () => {
      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Connection': 'keep-alive',
      });

      assert.equal(response.getStatusCode(), 200);
      assert.equal(response.getHeader('Content-Type'), 'text/event-stream');
      assert.equal(response.getHeader('Connection'), 'keep-alive');
    });

    it('should capture written chunks', () => {
      response.write('event: message_start\n');
      response.write('data: {"type":"start"}\n\n');

      let chunks = response.getWrittenChunks();
      assert.equal(chunks.length, 2);
      assert.equal(chunks[0], 'event: message_start\n');
    });

    it('should parse SSE events from written data', () => {
      response.write('event: message_start\ndata: {"type":"start"}\n\n');
      response.write('event: content_delta\ndata: {"text":"Hello"}\n\n');

      let events = response.getEvents();
      assert.equal(events.length, 2);
      assert.equal(events[0].event, 'message_start');
      assert.equal(events[0].data, '{"type":"start"}');
      assert.equal(events[1].event, 'content_delta');
      assert.equal(events[1].data, '{"text":"Hello"}');
    });

    it('should capture SSE comment lines', () => {
      response.write(':ok\n\n');
      response.write(':heartbeat\n\n');
      response.write('event: done\ndata: {}\n\n');

      let comments = response.getComments();
      assert.equal(comments.length, 2);
      assert.equal(comments[0], 'ok');
      assert.equal(comments[1], 'heartbeat');
    });

    it('should track end() state', () => {
      assert.equal(response.isEnded(), false);
      response.end();
      assert.equal(response.isEnded(), true);
    });

    it('should not allow writes after end', () => {
      response.end();
      let result = response.write('should fail');
      assert.equal(result, false);
    });

    it('should track flush calls', () => {
      assert.equal(response.getFlushCount(), 0);
      response.flush();
      response.flush();
      assert.equal(response.getFlushCount(), 2);
    });

    it('should track flushHeaders', () => {
      assert.equal(response.headersWereFlushed(), false);
      response.flushHeaders();
      assert.equal(response.headersWereFlushed(), true);
    });

    it('should support event listener registration for close', () => {
      let closeCalled = false;
      response.on('close', () => { closeCalled = true; });
      response.emit('close');
      assert.equal(closeCalled, true);
    });

    it('should reset all state', () => {
      response.setHeader('X-Test', '1');
      response.write('data: test\n\n');
      response.flush();
      response.flushHeaders();
      response.end();

      response.reset();

      assert.deepEqual(response.getHeaders(), {});
      assert.equal(response.getWrittenChunks().length, 0);
      assert.equal(response.isEnded(), false);
      assert.equal(response.getFlushCount(), 0);
      assert.equal(response.headersWereFlushed(), false);
      assert.equal(response.getStatusCode(), 200);
    });

    it('should include data from end() argument in output', () => {
      response.write('event: start\ndata: {"a":1}\n\n');
      response.end('event: done\ndata: {"b":2}\n\n');

      let events = response.getEvents();
      assert.equal(events.length, 2);
      assert.equal(events[1].event, 'done');
    });
  });

  // --------------------------------------------------------------------------
  // parseSSE
  // --------------------------------------------------------------------------

  describe('parseSSE', () => {
    it('should parse named events', () => {
      let result = parseSSE('event: greeting\ndata: {"msg":"hi"}\n\n');
      assert.equal(result.events.length, 1);
      assert.equal(result.events[0].event, 'greeting');
      assert.equal(result.events[0].data, '{"msg":"hi"}');
    });

    it('should parse events without event name', () => {
      let result = parseSSE('data: plain\n\n');
      assert.equal(result.events.length, 1);
      assert.equal(result.events[0].event, null);
      assert.equal(result.events[0].data, 'plain');
    });

    it('should parse multiple events from one string', () => {
      let raw = 'event: a\ndata: 1\n\nevent: b\ndata: 2\n\nevent: c\ndata: 3\n\n';
      let result = parseSSE(raw);
      assert.equal(result.events.length, 3);
      assert.equal(result.events[2].event, 'c');
      assert.equal(result.events[2].data, '3');
    });

    it('should separate comments from events', () => {
      let raw = ':heartbeat\n\nevent: msg\ndata: hi\n\n:ping\n\n';
      let result = parseSSE(raw);
      assert.equal(result.events.length, 1);
      assert.equal(result.comments.length, 2);
      assert.equal(result.comments[0], 'heartbeat');
      assert.equal(result.comments[1], 'ping');
    });
  });
});

// ============================================================================
// Route Helpers Tests
// ============================================================================

describe('Route Helpers', () => {
  // --------------------------------------------------------------------------
  // createMockRequest
  // --------------------------------------------------------------------------

  describe('createMockRequest', () => {
    it('should create request with default empty values', () => {
      let request = createMockRequest();
      assert.deepEqual(request.params, {});
      assert.deepEqual(request.query, {});
      assert.deepEqual(request.body, {});
      assert.equal(request.user, null);
      assert.equal(request.method, 'GET');
    });

    it('should apply overrides for params, query, body, user', () => {
      let request = createMockRequest({
        params: { sessionId: '42' },
        query: { limit: '10' },
        body: { content: 'Hello' },
        user: { id: 1, username: 'alice' },
      });

      assert.equal(request.params.sessionId, '42');
      assert.equal(request.query.limit, '10');
      assert.equal(request.body.content, 'Hello');
      assert.equal(request.user.id, 1);
    });

    it('should support case-insensitive header lookup via get()', () => {
      let request = createMockRequest({
        headers: { 'content-type': 'application/json', 'authorization': 'Bearer abc' },
      });

      assert.equal(request.get('content-type'), 'application/json');
      assert.equal(request.get('Content-Type'), 'application/json');
      assert.equal(request.header('Authorization'), 'Bearer abc');
    });

    it('should pass through custom properties', () => {
      let request = createMockRequest({
        cookies: { sid: 'abc123' },
        session: { data: 'test' },
      });

      assert.equal(request.cookies.sid, 'abc123');
      assert.equal(request.session.data, 'test');
    });
  });

  // --------------------------------------------------------------------------
  // createMockResponse
  // --------------------------------------------------------------------------

  describe('createMockResponse', () => {
    it('should capture status and json response', () => {
      let response = createMockResponse();
      response.status(201).json({ created: true });

      assert.equal(response.getStatus(), 201);
      assert.deepEqual(response.getBody(), { created: true });
      assert.equal(response.wasJsonCalled(), true);
      assert.equal(response.isEnded(), true);
    });

    it('should capture send response', () => {
      let response = createMockResponse();
      response.status(400).send('Bad Request');

      assert.equal(response.getStatus(), 400);
      assert.equal(response.getBody(), 'Bad Request');
      assert.equal(response.wasSendCalled(), true);
    });

    it('should capture headers via setHeader and set', () => {
      let response = createMockResponse();
      response.setHeader('X-Custom', 'value1');
      response.set('X-Other', 'value2');

      assert.equal(response.getHeader('X-Custom'), 'value1');
      assert.equal(response.getHeader('X-Other'), 'value2');
    });

    it('should capture written chunks', () => {
      let response = createMockResponse();
      response.write('chunk1');
      response.write('chunk2');
      response.end('final');

      let chunks = response.getWrittenChunks();
      assert.equal(chunks.length, 3);
      assert.equal(chunks[0], 'chunk1');
      assert.equal(chunks[2], 'final');
      assert.equal(response.isEnded(), true);
    });

    it('should capture redirect', () => {
      let response = createMockResponse();
      response.redirect(301, '/new-location');

      let redirect = response.getRedirect();
      assert.equal(redirect.status, 301);
      assert.equal(redirect.url, '/new-location');
    });

    it('should default redirect status to 302', () => {
      let response = createMockResponse();
      response.redirect('/login');

      let redirect = response.getRedirect();
      assert.equal(redirect.status, 302);
      assert.equal(redirect.url, '/login');
    });

    it('should reset all captured state', () => {
      let response = createMockResponse();
      response.status(404).json({ error: 'not found' });
      response.setHeader('X-Test', '1');

      response.reset();

      assert.equal(response.getStatus(), 200);
      assert.equal(response.getBody(), undefined);
      assert.equal(response.wasJsonCalled(), false);
      assert.equal(response.isEnded(), false);
      assert.deepEqual(response.getHeaders(), {});
    });
  });

  // --------------------------------------------------------------------------
  // callRoute
  // --------------------------------------------------------------------------

  describe('callRoute', () => {
    it('should call a sync handler and return the response', async () => {
      let handler = (req, res) => {
        res.status(200).json({ message: req.body.content });
      };

      let request = createMockRequest({ body: { content: 'test' } });
      let response = createMockResponse();

      let result = await callRoute(handler, request, response);

      assert.equal(result.getStatus(), 200);
      assert.deepEqual(result.getBody(), { message: 'test' });
    });

    it('should call an async handler and await it', async () => {
      let handler = async (req, res) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        res.status(200).json({ delayed: true });
      };

      let request = createMockRequest();
      let response = createMockResponse();

      let result = await callRoute(handler, request, response);

      assert.equal(result.getStatus(), 200);
      assert.deepEqual(result.getBody(), { delayed: true });
    });

    it('should throw when handler calls next with an error', async () => {
      let handler = (req, res, next) => {
        next(new Error('Something went wrong'));
      };

      let request = createMockRequest();
      let response = createMockResponse();

      await assert.rejects(
        () => callRoute(handler, request, response),
        { message: 'Something went wrong' }
      );
    });

    it('should not throw when handler calls next without an error', async () => {
      let handler = (req, res, next) => {
        next();
      };

      let request = createMockRequest();
      let response = createMockResponse();

      await callRoute(handler, request, response);
      // Should not throw
    });
  });
});

// ============================================================================
// Database Helpers Tests
// ============================================================================

describe('Database Helpers', () => {
  let db;

  beforeEach(() => {
    resetCounters();
    db = createTestDatabase();
  });

  // --------------------------------------------------------------------------
  // createTestDatabase
  // --------------------------------------------------------------------------

  describe('createTestDatabase', () => {
    it('should create a database with all expected tables', () => {
      let tables = db.prepare(`
        SELECT name FROM sqlite_master WHERE type='table' ORDER BY name
      `).all().map((row) => row.name);

      assert.ok(tables.includes('users'), 'should have users table');
      assert.ok(tables.includes('agents'), 'should have agents table');
      assert.ok(tables.includes('sessions'), 'should have sessions table');
      assert.ok(tables.includes('session_participants'), 'should have session_participants table');
      assert.ok(tables.includes('frames'), 'should have frames table');
      assert.ok(tables.includes('abilities'), 'should have abilities table');
      assert.ok(tables.includes('permission_rules'), 'should have permission_rules table');
      assert.ok(tables.includes('uploads'), 'should have uploads table');
    });

    it('should enforce foreign key constraints', () => {
      assert.throws(() => {
        db.prepare(`
          INSERT INTO agents (user_id, name, type) VALUES (999, 'test-orphan', 'claude')
        `).run();
      }, /FOREIGN KEY/);
    });

    it('should start with empty tables', () => {
      let userCount = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
      let agentCount = db.prepare('SELECT COUNT(*) as count FROM agents').get().count;
      let sessionCount = db.prepare('SELECT COUNT(*) as count FROM sessions').get().count;

      assert.equal(userCount, 0);
      assert.equal(agentCount, 0);
      assert.equal(sessionCount, 0);
    });
  });

  // --------------------------------------------------------------------------
  // seedUser
  // --------------------------------------------------------------------------

  describe('seedUser', () => {
    it('should create a user and return id and username', () => {
      let user = seedUser(db);

      assert.ok(typeof user.id === 'number');
      assert.ok(user.username.startsWith('test-user-'));
      assert.equal(user.email, null);
      assert.equal(user.displayName, null);
    });

    it('should accept custom username and email', () => {
      let user = seedUser(db, { username: 'alice', email: 'alice@example.com' });

      assert.equal(user.username, 'alice');
      assert.equal(user.email, 'alice@example.com');

      // Verify in database
      let row = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
      assert.equal(row.username, 'alice');
      assert.equal(row.email, 'alice@example.com');
    });

    it('should create multiple users with unique auto-generated names', () => {
      let user1 = seedUser(db);
      let user2 = seedUser(db);

      assert.notEqual(user1.id, user2.id);
      assert.notEqual(user1.username, user2.username);
    });

    it('should store password_hash and encrypted_secret', () => {
      let user = seedUser(db, { passwordHash: 'custom-hash', encryptedSecret: 'custom-secret' });
      let row = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);

      assert.equal(row.password_hash, 'custom-hash');
      assert.equal(row.encrypted_secret, 'custom-secret');
    });
  });

  // --------------------------------------------------------------------------
  // seedAgent
  // --------------------------------------------------------------------------

  describe('seedAgent', () => {
    it('should create an agent with auto-generated name starting with test-', () => {
      let user = seedUser(db);
      let agent = seedAgent(db, { userId: user.id });

      assert.ok(typeof agent.id === 'number');
      assert.ok(agent.name.startsWith('test-agent-'));
      assert.equal(agent.userId, user.id);
      assert.equal(agent.type, 'claude');
    });

    it('should reject agent names not starting with test-', () => {
      let user = seedUser(db);

      assert.throws(() => {
        seedAgent(db, { userId: user.id, name: 'My Agent' });
      }, /must start with "test-"/);
    });

    it('should require userId', () => {
      assert.throws(() => {
        seedAgent(db, { name: 'test-no-user' });
      }, /requires overrides.userId/);
    });

    it('should accept custom name and type', () => {
      let user = seedUser(db);
      let agent = seedAgent(db, {
        userId: user.id,
        name: 'test-custom-bot',
        type: 'openai',
      });

      assert.equal(agent.name, 'test-custom-bot');
      assert.equal(agent.type, 'openai');
    });

    it('should persist to database', () => {
      let user = seedUser(db);
      let agent = seedAgent(db, { userId: user.id });

      let row = db.prepare('SELECT * FROM agents WHERE id = ?').get(agent.id);
      assert.ok(row);
      assert.equal(row.name, agent.name);
      assert.equal(row.user_id, user.id);
    });
  });

  // --------------------------------------------------------------------------
  // seedSession
  // --------------------------------------------------------------------------

  describe('seedSession', () => {
    it('should create a session with participants', () => {
      let user = seedUser(db);
      let agent = seedAgent(db, { userId: user.id });
      let session = seedSession(db, user.id, agent.id);

      assert.ok(typeof session.id === 'number');
      assert.equal(session.userId, user.id);
      assert.equal(session.agentId, agent.id);
      assert.ok(session.name.startsWith('Test Session'));
    });

    it('should add user as owner and agent as coordinator', () => {
      let user = seedUser(db);
      let agent = seedAgent(db, { userId: user.id });
      let session = seedSession(db, user.id, agent.id);

      let participants = db.prepare(`
        SELECT * FROM session_participants WHERE session_id = ? ORDER BY participant_type
      `).all(session.id);

      assert.equal(participants.length, 2);

      let agentParticipant = participants.find((p) => p.participant_type === 'agent');
      let userParticipant = participants.find((p) => p.participant_type === 'user');

      assert.equal(agentParticipant.role, 'coordinator');
      assert.equal(agentParticipant.participant_id, agent.id);

      assert.equal(userParticipant.role, 'owner');
      assert.equal(userParticipant.participant_id, user.id);
    });

    it('should accept custom session name and system prompt', () => {
      let user = seedUser(db);
      let agent = seedAgent(db, { userId: user.id });
      let session = seedSession(db, user.id, agent.id, {
        name: 'My Custom Session',
        systemPrompt: 'You are a helpful assistant.',
      });

      assert.equal(session.name, 'My Custom Session');

      let row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(session.id);
      assert.equal(row.system_prompt, 'You are a helpful assistant.');
    });

    it('should create multiple sessions with unique auto-generated names', () => {
      let user = seedUser(db);
      let agent = seedAgent(db, { userId: user.id });

      let session1 = seedSession(db, user.id, agent.id);
      let session2 = seedSession(db, user.id, agent.id);

      assert.notEqual(session1.id, session2.id);
      assert.notEqual(session1.name, session2.name);
    });
  });

  // --------------------------------------------------------------------------
  // resetCounters
  // --------------------------------------------------------------------------

  describe('resetCounters', () => {
    it('should reset auto-increment counters for deterministic naming', () => {
      let user1 = seedUser(db);
      resetCounters();
      // Create a new db to avoid unique constraint collision
      let db2 = createTestDatabase();
      let user2 = seedUser(db2);

      assert.equal(user1.username, user2.username);
    });
  });
});
