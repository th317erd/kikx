'use strict';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { HeroCore }         from '../../src/core/hero-core.mjs';
import { Keystore }         from '../../src/core/crypto/keystore.mjs';
import { AuthService }      from '../../src/server/auth/index.mjs';
import { SessionManager }   from '../../src/core/session/index.mjs';
import { FramePersistence } from '../../src/core/frames/index.mjs';
import { InteractionLoop }  from '../../src/core/interaction/index.mjs';
import { ServerRoutes }     from '../../src/server/routes/index.mjs';
import XID                  from 'xid-js';

// =============================================================================
// Helpers
// =============================================================================

function createMockReq(overrides = {}) {
  return {
    body:           {},
    params:         {},
    query:          {},
    userId:         null,
    organizationId: null,
    getUMK:         () => null,
    headers:        {},
    on:             () => {},
    ...overrides,
  };
}

function createMockRes() {
  let res = {
    _status:  200,
    _json:    null,
    _headers: {},
    _written: '',
    _ended:   false,
    status(code) { res._status = code; return res; },
    json(data)   { res._json = data; return res; },
    setHeader(key, val) { res._headers[key] = val; return res; },
    write(data)  { res._written = (res._written || '') + data; return res; },
    end()        { res._ended = true; },
  };

  return res;
}

// =============================================================================
// Shared Setup
// =============================================================================

let core, keystore, context, authService, sessionManager, framePersistence, interactionLoop, routes;
let testUser, testToken, testOrg, testUMK;

before(async () => {
  core = new HeroCore({ database: { filename: ':memory:' } });
  await core.start();

  keystore = new Keystore({ devMode: true, devSeed: 'test-routes-seed' });
  keystore.initialize();

  context = core.getContext();
  context.setProperty('keystore', keystore);

  authService = new AuthService({ context, keystore });

  sessionManager = new SessionManager(context);
  context.setProperty('sessionManager', sessionManager);

  framePersistence = new FramePersistence(context);
  context.setProperty('framePersistence', framePersistence);

  interactionLoop = new InteractionLoop(context);
  context.setProperty('interactionLoop', interactionLoop);

  routes = new ServerRoutes({ core, authService, keystore });

  // Create a test user for authenticated routes
  let regResult = await authService.register('test@example.com', 'password123', {
    organizationName: 'Test Org',
    firstName:        'Test',
    lastName:         'User',
  });

  testUser  = regResult.user;
  testToken = regResult.token;
  testOrg   = regResult.organization;

  // Extract UMK from token for later use
  let decoded = authService.verifyToken(testToken);
  testUMK     = authService.getUMK(decoded);
});

after(async () => {
  keystore.destroy();
  await core.stop();
});

// =============================================================================
// Constructor
// =============================================================================

describe('ServerRoutes constructor', () => {
  it('should require core', () => {
    assert.throws(
      () => new ServerRoutes({ authService, keystore }),
      { message: 'ServerRoutes requires core' },
    );
  });

  it('should require authService', () => {
    assert.throws(
      () => new ServerRoutes({ core, keystore }),
      { message: 'ServerRoutes requires authService' },
    );
  });

  it('should require keystore', () => {
    assert.throws(
      () => new ServerRoutes({ core, authService }),
      { message: 'ServerRoutes requires keystore' },
    );
  });
});

// =============================================================================
// Auth Routes
// =============================================================================

describe('Auth: register', () => {
  it('should create user and return token', async () => {
    let handler = routes.handleRegister();
    let req     = createMockReq({ body: { email: 'new@example.com', password: 'password123' } });
    let res     = createMockRes();

    await handler(req, res);

    assert.equal(res._status, 201);
    assert.ok(res._json.token);
    assert.ok(res._json.user);
    assert.ok(res._json.organization);
    assert.equal(res._json.user.email, 'new@example.com');
  });

  it('should return 400 if email is missing', async () => {
    let handler = routes.handleRegister();
    let req     = createMockReq({ body: { password: 'password123' } });
    let res     = createMockRes();

    await handler(req, res);

    assert.equal(res._status, 400);
    assert.equal(res._json.error, 'email is required');
  });

  it('should return 400 if password is missing', async () => {
    let handler = routes.handleRegister();
    let req     = createMockReq({ body: { email: 'another@example.com' } });
    let res     = createMockRes();

    await handler(req, res);

    assert.equal(res._status, 400);
    assert.equal(res._json.error, 'password is required');
  });
});

describe('Auth: login', () => {
  it('should return token on valid credentials', async () => {
    let handler = routes.handleLogin();
    let req     = createMockReq({ body: { email: 'test@example.com', password: 'password123' } });
    let res     = createMockRes();

    await handler(req, res);

    assert.equal(res._status, 200);
    assert.ok(res._json.token);
    assert.ok(res._json.user);
    assert.equal(res._json.user.email, 'test@example.com');
  });

  it('should return 401 on invalid credentials', async () => {
    let handler = routes.handleLogin();
    let req     = createMockReq({ body: { email: 'test@example.com', password: 'wrong' } });
    let res     = createMockRes();

    await handler(req, res);

    assert.equal(res._status, 401);
    assert.ok(res._json.error);
  });
});

describe('Auth: me', () => {
  it('should return current user info', async () => {
    let handler = routes.handleMe();
    let req     = createMockReq({ userId: testUser.id, organizationId: testOrg.id });
    let res     = createMockRes();

    await handler(req, res);

    assert.equal(res._status, 200);
    assert.equal(res._json.id, testUser.id);
    assert.equal(res._json.email, 'test@example.com');
    assert.equal(res._json.firstName, 'Test');
    assert.equal(res._json.lastName, 'User');
  });

  it('should return 404 if user not found', async () => {
    let handler = routes.handleMe();
    let req     = createMockReq({ userId: 'usr_nonexistent' });
    let res     = createMockRes();

    await handler(req, res);

    assert.equal(res._status, 404);
    assert.equal(res._json.error, 'User not found');
  });
});

// =============================================================================
// Session Routes
// =============================================================================

describe('Sessions: list', () => {
  it('should return sessions for org', async () => {
    // Create a session first
    await sessionManager.createSession(testOrg.id, { name: 'List Test Session' });

    let handler = routes.handleListSessions();
    let req     = createMockReq({ organizationId: testOrg.id });
    let res     = createMockRes();

    await handler(req, res);

    assert.equal(res._status, 200);
    assert.ok(Array.isArray(res._json.sessions));
    assert.ok(res._json.sessions.length >= 1);
  });
});

describe('Sessions: create', () => {
  it('should create and return new session', async () => {
    let handler = routes.handleCreateSession();
    let req     = createMockReq({ organizationId: testOrg.id, body: { name: 'New Session' } });
    let res     = createMockRes();

    await handler(req, res);

    assert.equal(res._status, 201);
    assert.ok(res._json.session);
    assert.equal(res._json.session.name, 'New Session');
  });
});

describe('Sessions: get', () => {
  it('should return single session by id', async () => {
    let session = await sessionManager.createSession(testOrg.id, { name: 'Get Test' });
    let handler = routes.handleGetSession();
    let req     = createMockReq({ params: { id: session.id } });
    let res     = createMockRes();

    await handler(req, res);

    assert.equal(res._status, 200);
    assert.ok(res._json.session);
    assert.equal(res._json.session.id, session.id);
  });

  it('should return 404 if session not found', async () => {
    let handler = routes.handleGetSession();
    let req     = createMockReq({ params: { id: 'ses_nonexistent' } });
    let res     = createMockRes();

    await handler(req, res);

    assert.equal(res._status, 404);
    assert.equal(res._json.error, 'Session not found');
  });
});

describe('Sessions: update', () => {
  it('should update session name', async () => {
    let session = await sessionManager.createSession(testOrg.id, { name: 'Before Update' });
    let handler = routes.handleUpdateSession();
    let req     = createMockReq({ params: { id: session.id }, body: { name: 'After Update' } });
    let res     = createMockRes();

    await handler(req, res);

    assert.equal(res._status, 200);
    assert.equal(res._json.session.name, 'After Update');
  });
});

describe('Sessions: delete', () => {
  it('should delete session', async () => {
    let session = await sessionManager.createSession(testOrg.id, { name: 'To Delete' });
    let handler = routes.handleDeleteSession();
    let req     = createMockReq({ params: { id: session.id } });
    let res     = createMockRes();

    await handler(req, res);

    assert.equal(res._status, 200);
    assert.deepEqual(res._json, { deleted: true });

    // Verify it's gone
    let found = await sessionManager.getSession(session.id);
    assert.equal(found, null);
  });
});

describe('Sessions: archive', () => {
  it('should archive session', async () => {
    let session = await sessionManager.createSession(testOrg.id, { name: 'To Archive' });
    let handler = routes.handleArchiveSession();
    let req     = createMockReq({ params: { id: session.id } });
    let res     = createMockRes();

    await handler(req, res);

    assert.equal(res._status, 200);
    assert.equal(res._json.session.archived, true);
  });
});

describe('Sessions: revive', () => {
  it('should revive archived session', async () => {
    let session = await sessionManager.createSession(testOrg.id, { name: 'To Revive', archived: true });
    let handler = routes.handleReviveSession();
    let req     = createMockReq({ params: { id: session.id } });
    let res     = createMockRes();

    await handler(req, res);

    assert.equal(res._status, 200);
    assert.equal(res._json.session.archived, false);
  });
});

// =============================================================================
// Participant Routes
// =============================================================================

describe('Participants: list', () => {
  it('should return participants for session', async () => {
    let session = await sessionManager.createSession(testOrg.id, { name: 'Participants Test' });
    let handler = routes.handleListParticipants();
    let req     = createMockReq({ params: { sessionId: session.id } });
    let res     = createMockRes();

    await handler(req, res);

    assert.equal(res._status, 200);
    assert.ok(Array.isArray(res._json.participants));
  });
});

describe('Participants: add', () => {
  it('should add participant to session', async () => {
    let session = await sessionManager.createSession(testOrg.id, { name: 'Add Participant Test' });

    // Create an agent first
    let { Agent } = core.getModels();
    let agent     = await Agent.create({
      organizationID: testOrg.id,
      name:           'test-participant-agent',
      pluginID:       'claude-agent',
    });

    let handler = routes.handleAddParticipant();
    let req     = createMockReq({
      params: { sessionId: session.id },
      body:   { agentId: agent.id },
    });
    let res = createMockRes();

    await handler(req, res);

    assert.equal(res._status, 201);
    assert.ok(res._json.participant);
  });

  it('should return 400 if agentId is missing', async () => {
    let session = await sessionManager.createSession(testOrg.id, { name: 'Missing Agent Test' });
    let handler = routes.handleAddParticipant();
    let req     = createMockReq({ params: { sessionId: session.id }, body: {} });
    let res     = createMockRes();

    await handler(req, res);

    assert.equal(res._status, 400);
    assert.equal(res._json.error, 'agentId is required');
  });
});

describe('Participants: remove', () => {
  it('should remove participant', async () => {
    let session = await sessionManager.createSession(testOrg.id, { name: 'Remove Participant Test' });
    let { Agent } = core.getModels();
    let agent     = await Agent.create({
      organizationID: testOrg.id,
      name:           'test-remove-agent',
      pluginID:       'claude-agent',
    });

    let participant = await sessionManager.addParticipant(session.id, agent.id);
    let handler     = routes.handleRemoveParticipant();
    let req         = createMockReq({ params: { id: participant.id } });
    let res         = createMockRes();

    await handler(req, res);

    assert.equal(res._status, 200);
    assert.deepEqual(res._json, { deleted: true });
  });
});

// =============================================================================
// Agent Routes
// =============================================================================

describe('Agents: list', () => {
  it('should return agents for org', async () => {
    let { Agent } = core.getModels();
    await Agent.create({
      organizationID: testOrg.id,
      name:           'test-list-agent',
      pluginID:       'claude-agent',
    });

    let handler = routes.handleListAgents();
    let req     = createMockReq({ organizationId: testOrg.id });
    let res     = createMockRes();

    await handler(req, res);

    assert.equal(res._status, 200);
    assert.ok(Array.isArray(res._json.agents));
    assert.ok(res._json.agents.length >= 1);
  });
});

describe('Agents: create', () => {
  it('should create agent', async () => {
    let handler = routes.handleCreateAgent();
    let req     = createMockReq({
      organizationId: testOrg.id,
      userId:         testUser.id,
      getUMK:         () => testUMK,
      body:           { name: 'test-create-agent', pluginID: 'claude-agent' },
    });
    let res = createMockRes();

    await handler(req, res);

    assert.equal(res._status, 201);
    assert.ok(res._json.agent);
    assert.equal(res._json.agent.name, 'test-create-agent');
  });

  it('should encrypt API key when provided', async () => {
    let handler = routes.handleCreateAgent();
    let req     = createMockReq({
      organizationId: testOrg.id,
      userId:         testUser.id,
      getUMK:         () => testUMK,
      body:           { name: 'test-api-key-agent', pluginID: 'claude-agent', apiKey: 'sk-test-12345' },
    });
    let res = createMockRes();

    await handler(req, res);

    assert.equal(res._status, 201);
    assert.ok(res._json.agent);
    assert.ok(res._json.agent.encryptedAPIKey);

    // Verify it's actually encrypted (parseable JSON with cipher fields)
    let encrypted = JSON.parse(res._json.agent.encryptedAPIKey);
    assert.ok(encrypted.ciphertext);
    assert.ok(encrypted.iv);
    assert.ok(encrypted.authTag);

    // Verify we can decrypt it
    let userKey   = keystore.deriveUserKey(testUMK, testUser.id);
    let decrypted = keystore.decrypt(encrypted, userKey).toString('utf8');
    assert.equal(decrypted, 'sk-test-12345');
  });

  it('should return 400 if name is missing', async () => {
    let handler = routes.handleCreateAgent();
    let req     = createMockReq({
      organizationId: testOrg.id,
      body:           { pluginID: 'claude-agent' },
    });
    let res = createMockRes();

    await handler(req, res);

    assert.equal(res._status, 400);
    assert.equal(res._json.error, 'name is required');
  });

  it('should return 400 if pluginID is missing', async () => {
    let handler = routes.handleCreateAgent();
    let req     = createMockReq({
      organizationId: testOrg.id,
      body:           { name: 'test-no-plugin' },
    });
    let res = createMockRes();

    await handler(req, res);

    assert.equal(res._status, 400);
    assert.equal(res._json.error, 'pluginID is required');
  });
});

describe('Agents: get', () => {
  it('should return single agent', async () => {
    let { Agent } = core.getModels();
    let agent     = await Agent.create({
      organizationID: testOrg.id,
      name:           'test-get-agent',
      pluginID:       'claude-agent',
    });

    let handler = routes.handleGetAgent();
    let req     = createMockReq({ params: { id: agent.id } });
    let res     = createMockRes();

    await handler(req, res);

    assert.equal(res._status, 200);
    assert.ok(res._json.agent);
    assert.equal(res._json.agent.id, agent.id);
  });

  it('should return 404 if agent not found', async () => {
    let handler = routes.handleGetAgent();
    let req     = createMockReq({ params: { id: 'agt_nonexistent' } });
    let res     = createMockRes();

    await handler(req, res);

    assert.equal(res._status, 404);
    assert.equal(res._json.error, 'Agent not found');
  });
});

describe('Agents: update', () => {
  it('should update agent fields', async () => {
    let { Agent } = core.getModels();
    let agent     = await Agent.create({
      organizationID: testOrg.id,
      name:           'test-update-agent',
      pluginID:       'claude-agent',
    });

    let handler = routes.handleUpdateAgent();
    let req     = createMockReq({
      params: { id: agent.id },
      body:   { name: 'test-updated-name', instructions: 'Be helpful' },
    });
    let res = createMockRes();

    await handler(req, res);

    assert.equal(res._status, 200);
    assert.equal(res._json.agent.name, 'test-updated-name');
    assert.equal(res._json.agent.instructions, 'Be helpful');
  });
});

describe('Agents: delete', () => {
  it('should delete agent', async () => {
    let { Agent } = core.getModels();
    let agent     = await Agent.create({
      organizationID: testOrg.id,
      name:           'test-delete-agent',
      pluginID:       'claude-agent',
    });

    let handler = routes.handleDeleteAgent();
    let req     = createMockReq({ params: { id: agent.id } });
    let res     = createMockRes();

    await handler(req, res);

    assert.equal(res._status, 200);
    assert.deepEqual(res._json, { deleted: true });

    // Verify it's gone
    let found = await Agent.where.id.EQ(agent.id).first();
    assert.ok(!found, 'Agent should be deleted');
  });
});

// =============================================================================
// Interaction Routes
// =============================================================================

describe('Interaction: send message', () => {
  it('should return 400 if message is missing', async () => {
    let handler = routes.handleSendMessage();
    let req     = createMockReq({
      params: { sessionId: 'ses_test' },
      body:   { agentId: 'agt_test' },
    });
    let res = createMockRes();

    await handler(req, res);

    assert.equal(res._status, 400);
    assert.equal(res._json.error, 'message is required');
  });

  it('should return 400 if agentId is missing', async () => {
    let handler = routes.handleSendMessage();
    let req     = createMockReq({
      params: { sessionId: 'ses_test' },
      body:   { message: 'hello' },
    });
    let res = createMockRes();

    await handler(req, res);

    assert.equal(res._status, 400);
    assert.equal(res._json.error, 'agentId is required');
  });

  it('should return 404 if agent not found', async () => {
    let handler = routes.handleSendMessage();
    let req     = createMockReq({
      params: { sessionId: 'ses_test' },
      body:   { message: 'hello', agentId: 'agt_nonexistent' },
      userId: testUser.id,
    });
    let res = createMockRes();

    await handler(req, res);

    assert.equal(res._status, 404);
    assert.equal(res._json.error, 'Agent not found');
  });

  it('should return 400 if plugin not registered', async () => {
    let { Agent } = core.getModels();
    let agent     = await Agent.create({
      organizationID: testOrg.id,
      name:           'test-no-plugin-registered',
      pluginID:       'nonexistent-plugin',
    });

    let handler = routes.handleSendMessage();
    let req     = createMockReq({
      params: { sessionId: 'ses_test' },
      body:   { message: 'hello', agentId: agent.id },
      userId: testUser.id,
    });
    let res = createMockRes();

    await handler(req, res);

    assert.equal(res._status, 400);
    assert.ok(res._json.error.includes('No plugin registered'));
  });
});

describe('Interaction: cancel', () => {
  it('should cancel interaction', async () => {
    let handler = routes.handleCancelInteraction();
    let req     = createMockReq({ params: { sessionId: 'ses_test' } });
    let res     = createMockRes();

    await handler(req, res);

    assert.equal(res._status, 200);
    assert.equal(res._json.cancelled, true);
  });
});

// =============================================================================
// Frame Routes
// =============================================================================

describe('Frames: list', () => {
  it('should return frames for session', async () => {
    let session = await sessionManager.createSession(testOrg.id, { name: 'Frames Test' });

    // Save some test frames (using real XID-generated IDs)
    let frmId1 = `frm_${XID.next()}`;
    let frmId2 = `frm_${XID.next()}`;
    let intId  = `int_${XID.next()}`;

    await framePersistence.saveFrames(session.id, [
      {
        id:            frmId1,
        type:          'user-message',
        content:       { text: 'Hello' },
        order:         1,
        timestamp:     Date.now(),
        interactionID: intId,
        authorType:    'user',
        hidden:        false,
        deleted:       false,
        processed:     false,
      },
      {
        id:            frmId2,
        type:          'message',
        content:       { html: '<p>Hi there!</p>' },
        order:         2,
        timestamp:     Date.now(),
        interactionID: intId,
        authorType:    'agent',
        hidden:        false,
        deleted:       false,
        processed:     false,
      },
    ]);

    let handler = routes.handleListFrames();
    let req     = createMockReq({ params: { sessionId: session.id } });
    let res     = createMockRes();

    await handler(req, res);

    assert.equal(res._status, 200);
    assert.ok(Array.isArray(res._json.frames));
    assert.equal(res._json.frames.length, 2);
  });
});

// =============================================================================
// SSE Stream
// =============================================================================

describe('SSE stream', () => {
  it('should set correct SSE headers', async () => {
    let handler = routes.handleStream();
    let req     = createMockReq({ params: { sessionId: 'ses_sse_test' } });
    let res     = createMockRes();

    await handler(req, res);

    assert.equal(res._headers['Content-Type'], 'text/event-stream');
    assert.equal(res._headers['Cache-Control'], 'no-cache');
    assert.equal(res._headers['Connection'], 'keep-alive');
  });

  it('should send connected event on open', async () => {
    let handler = routes.handleStream();
    let req     = createMockReq({ params: { sessionId: 'ses_sse_ping' } });
    let res     = createMockRes();

    await handler(req, res);

    assert.ok(res._written.includes('event: connected'));
    assert.ok(res._written.includes('data: {}'));
  });

  it('should emit frame events for matching session', async () => {
    let sessionId = 'ses_sse_frames';
    let handler   = routes.handleStream();
    let req       = createMockReq({ params: { sessionId } });
    let res       = createMockRes();

    await handler(req, res);

    // Simulate a frame emission on the interaction loop
    let testFrame = { id: 'frm_sse_1', type: 'message', content: { html: '<p>Test</p>' } };
    interactionLoop.emit('frame', { sessionID: sessionId, frame: testFrame });

    assert.ok(res._written.includes('event: frame'));
    assert.ok(res._written.includes('"frm_sse_1"'));

    // Clean up
    if (res._sseCleanup)
      res._sseCleanup();
  });

  it('should NOT emit frame events for non-matching session', async () => {
    let sessionId = 'ses_sse_no_match';
    let handler   = routes.handleStream();
    let req       = createMockReq({ params: { sessionId } });
    let res       = createMockRes();

    await handler(req, res);

    // Clear initial connected event
    let initialWritten = res._written;

    // Emit for a DIFFERENT session
    interactionLoop.emit('frame', { sessionID: 'ses_other_session', frame: { id: 'frm_other' } });

    // Written should not have changed
    assert.equal(res._written, initialWritten);

    // Clean up
    if (res._sseCleanup)
      res._sseCleanup();
  });
});

// =============================================================================
// Route Table
// =============================================================================

describe('getRouteTable', () => {
  it('should return array of route descriptors', () => {
    let table = routes.getRouteTable();

    assert.ok(Array.isArray(table));
    assert.ok(table.length > 0);
  });

  it('should have method, path, handler, and auth on each route', () => {
    let table = routes.getRouteTable();

    for (let route of table) {
      assert.ok(route.method, `Route missing method: ${JSON.stringify(route)}`);
      assert.ok(route.path, `Route missing path: ${JSON.stringify(route)}`);
      assert.ok(typeof route.handler === 'function', `Route handler not a function: ${route.path}`);
      assert.ok(typeof route.auth === 'boolean', `Route auth not boolean: ${route.path}`);
    }
  });

  it('should have unauthenticated auth routes and authenticated API routes', () => {
    let table = routes.getRouteTable();

    let registerRoute = table.find((r) => r.path.includes('/auth/register'));
    let loginRoute    = table.find((r) => r.path.includes('/auth/login'));
    let meRoute       = table.find((r) => r.path.includes('/auth/me'));

    assert.equal(registerRoute.auth, false);
    assert.equal(loginRoute.auth, false);
    assert.equal(meRoute.auth, true);

    // Session routes should all be authenticated
    let sessionRoutes = table.filter((r) => r.path.includes('/sessions'));
    for (let route of sessionRoutes) {
      assert.equal(route.auth, true, `Session route not auth: ${route.path}`);
    }
  });

  it('should include all expected route categories', () => {
    let table = routes.getRouteTable();
    let paths = table.map((r) => r.path);

    // Auth
    assert.ok(paths.some((p) => p.includes('/auth/register')));
    assert.ok(paths.some((p) => p.includes('/auth/login')));
    assert.ok(paths.some((p) => p.includes('/auth/me')));

    // Sessions
    assert.ok(paths.some((p) => p === '/api/v2/sessions'));
    assert.ok(paths.some((p) => p.includes('/sessions/:id')));

    // Participants
    assert.ok(paths.some((p) => p.includes('/participants')));

    // Agents
    assert.ok(paths.some((p) => p.includes('/agents')));

    // Interactions
    assert.ok(paths.some((p) => p.includes('/interact')));

    // Frames
    assert.ok(paths.some((p) => p.includes('/frames')));

    // SSE
    assert.ok(paths.some((p) => p.includes('/stream')));
  });
});

// =============================================================================
// Error Handling
// =============================================================================

describe('Error handling', () => {
  it('should catch and wrap errors from core methods', async () => {
    let handler = routes.handleDeleteSession();
    let req     = createMockReq({ params: { id: 'ses_nonexistent_for_delete' } });
    let res     = createMockRes();

    await handler(req, res);

    // SessionManager.deleteSession throws "Session not found: ..."
    assert.equal(res._status, 404);
    assert.ok(res._json.error.includes('not found'));
  });

  it('should return 400 for missing required fields', async () => {
    let handler = routes.handleAddParticipant();
    let req     = createMockReq({ params: { sessionId: 'ses_test' }, body: {} });
    let res     = createMockRes();

    await handler(req, res);

    assert.equal(res._status, 400);
    assert.equal(res._json.error, 'agentId is required');
  });
});
