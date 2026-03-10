'use strict';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { KikxCore }         from '../../src/core/kikx-core.mjs';
import { Keystore }         from '../../src/core/crypto/keystore.mjs';
import { AuthService }      from '../../src/server/auth/index.mjs';
import { SessionManager }   from '../../src/core/session/index.mjs';
import { FramePersistence } from '../../src/core/frames/index.mjs';
import { InteractionLoop }  from '../../src/core/interaction/index.mjs';

import { AuthController }        from '../../src/server/controllers/auth-controller.mjs';
import { SessionController }     from '../../src/server/controllers/session-controller.mjs';
import { ParticipantController } from '../../src/server/controllers/participant-controller.mjs';
import { AgentController }       from '../../src/server/controllers/agent-controller.mjs';
import { InteractionController } from '../../src/server/controllers/interaction-controller.mjs';
import { FrameController }       from '../../src/server/controllers/frame-controller.mjs';
import { StreamController }      from '../../src/server/controllers/stream-controller.mjs';
import { DmController }          from '../../src/server/controllers/dm-controller.mjs';

import XID from 'xid-js';

// =============================================================================
// Helpers
// =============================================================================

function createMockApp({ core, authService, keystore }) {
  return {
    getCore:        () => core,
    getAuthService: () => authService,
    getKeystore:    () => keystore,
  };
}

function createMockReq(overrides = {}) {
  return {
    body:           {},
    params:         {},
    query:          {},
    userID:         null,
    organizationID: null,
    getUMK:         () => null,
    headers:        {},
    method:         'GET',
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
    header(key, val) { res._headers[key] = val; return res; },
    write(data)  { res._written = (res._written || '') + data; return res; },
    end()        { res._ended = true; },
    send(data)   { res._sent = data; return res; },
  };

  return res;
}

function createController(ControllerClass, { mockApp, req, res }) {
  return new ControllerClass(mockApp, null, req, res);
}

// =============================================================================
// Shared Setup
// =============================================================================

let core, keystore, context, authService, sessionManager, framePersistence, interactionLoop, mockApp;
let testUser, testToken, testOrg, testUMK;

before(async () => {
  core = new KikxCore({ database: { filename: ':memory:' } });
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

  mockApp = createMockApp({ core, authService, keystore });

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
// Auth Controller
// =============================================================================

describe('AuthController: register', () => {
  it('should create user and return token', async () => {
    let req        = createMockReq({ body: { email: 'new@example.com', password: 'password123' } });
    let res        = createMockRes();
    let controller = createController(AuthController, { mockApp, req, res });
    let result     = await controller.register({ body: req.body });

    assert.equal(controller.responseStatusCode, 201);
    assert.ok(result.data.token);
    assert.ok(result.data.user);
    assert.ok(result.data.organization);
    assert.equal(result.data.user.email, 'new@example.com');
  });

  it('should throw 400 if email is missing', async () => {
    let req        = createMockReq({ body: { password: 'password123' } });
    let res        = createMockRes();
    let controller = createController(AuthController, { mockApp, req, res });

    await assert.rejects(
      () => controller.register({ body: req.body }),
      (error) => error.message.includes('email is required'),
    );
  });

  it('should throw 400 if password is missing', async () => {
    let req        = createMockReq({ body: { email: 'another@example.com' } });
    let res        = createMockRes();
    let controller = createController(AuthController, { mockApp, req, res });

    await assert.rejects(
      () => controller.register({ body: req.body }),
      (error) => error.message.includes('password is required'),
    );
  });
});

describe('AuthController: login', () => {
  it('should return token on valid credentials', async () => {
    let req        = createMockReq({ body: { email: 'test@example.com', password: 'password123' } });
    let res        = createMockRes();
    let controller = createController(AuthController, { mockApp, req, res });
    let result     = await controller.login({ body: req.body });

    assert.ok(result.data.token);
    assert.ok(result.data.user);
    assert.equal(result.data.user.email, 'test@example.com');
  });

  it('should throw on invalid credentials', async () => {
    let req        = createMockReq({ body: { email: 'test@example.com', password: 'wrong' } });
    let res        = createMockRes();
    let controller = createController(AuthController, { mockApp, req, res });

    await assert.rejects(
      () => controller.login({ body: req.body }),
    );
  });
});

describe('AuthController: me', () => {
  it('should return current user info', async () => {
    let req        = createMockReq({ userID: testUser.id, organizationID: testOrg.id });
    let res        = createMockRes();
    let controller = createController(AuthController, { mockApp, req, res });
    let result     = await controller.me();

    assert.equal(result.data.id, testUser.id);
    assert.equal(result.data.email, 'test@example.com');
    assert.equal(result.data.firstName, 'Test');
    assert.equal(result.data.lastName, 'User');
  });

  it('should throw 404 if user not found', async () => {
    let req        = createMockReq({ userID: 'usr_nonexistent' });
    let res        = createMockRes();
    let controller = createController(AuthController, { mockApp, req, res });

    await assert.rejects(
      () => controller.me(),
      (error) => error.message.includes('User not found'),
    );
  });
});

// =============================================================================
// Session Controller
// =============================================================================

describe('SessionController: list', () => {
  it('should return sessions for org', async () => {
    await sessionManager.createSession(testOrg.id, { name: 'List Test Session' });

    let req        = createMockReq({ organizationID: testOrg.id });
    let res        = createMockRes();
    let controller = createController(SessionController, { mockApp, req, res });
    let result     = await controller.list({ query: {} });

    assert.ok(Array.isArray(result.data.sessions));
    assert.ok(result.data.sessions.length >= 1);
  });
});

describe('SessionController: create', () => {
  it('should create and return new session', async () => {
    let req        = createMockReq({ organizationID: testOrg.id });
    let res        = createMockRes();
    let controller = createController(SessionController, { mockApp, req, res });
    let result     = await controller.create({ body: { name: 'New Session' } });

    assert.equal(controller.responseStatusCode, 201);
    assert.ok(result.data.session);
    assert.equal(result.data.session.name, 'New Session');
  });
});

describe('SessionController: show', () => {
  it('should return single session by id', async () => {
    let session    = await sessionManager.createSession(testOrg.id, { name: 'Get Test' });
    let req        = createMockReq();
    let res        = createMockRes();
    let controller = createController(SessionController, { mockApp, req, res });
    let result     = await controller.show({ params: { sessionID: session.id } });

    assert.ok(result.data.session);
    assert.equal(result.data.session.id, session.id);
  });

  it('should throw 404 if session not found', async () => {
    let req        = createMockReq();
    let res        = createMockRes();
    let controller = createController(SessionController, { mockApp, req, res });

    await assert.rejects(
      () => controller.show({ params: { sessionID: 'ses_nonexistent' } }),
      (error) => error.message.includes('Session not found'),
    );
  });
});

describe('SessionController: update', () => {
  it('should update session name', async () => {
    let session    = await sessionManager.createSession(testOrg.id, { name: 'Before Update' });
    let req        = createMockReq();
    let res        = createMockRes();
    let controller = createController(SessionController, { mockApp, req, res });
    let result     = await controller.update({ params: { sessionID: session.id }, body: { name: 'After Update' } });

    assert.equal(result.data.session.name, 'After Update');
  });
});

describe('SessionController: destroy', () => {
  it('should delete session', async () => {
    let session    = await sessionManager.createSession(testOrg.id, { name: 'To Delete' });
    let req        = createMockReq();
    let res        = createMockRes();
    let controller = createController(SessionController, { mockApp, req, res });
    let result     = await controller.destroy({ params: { sessionID: session.id } });

    assert.deepEqual(result.data, { deleted: true });

    let found = await sessionManager.getSession(session.id);
    assert.equal(found, null);
  });
});

describe('SessionController: archive', () => {
  it('should archive session', async () => {
    let session    = await sessionManager.createSession(testOrg.id, { name: 'To Archive' });
    let req        = createMockReq();
    let res        = createMockRes();
    let controller = createController(SessionController, { mockApp, req, res });
    let result     = await controller.archive({ params: { sessionID: session.id } });

    assert.equal(result.data.session.archived, true);
  });
});

describe('SessionController: revive', () => {
  it('should revive archived session', async () => {
    let session    = await sessionManager.createSession(testOrg.id, { name: 'To Revive', archived: true });
    let req        = createMockReq();
    let res        = createMockRes();
    let controller = createController(SessionController, { mockApp, req, res });
    let result     = await controller.revive({ params: { sessionID: session.id } });

    assert.equal(result.data.session.archived, false);
  });
});

// =============================================================================
// Participant Controller
// =============================================================================

describe('ParticipantController: list', () => {
  it('should return participants for session', async () => {
    let session    = await sessionManager.createSession(testOrg.id, { name: 'Participants Test' });
    let req        = createMockReq();
    let res        = createMockRes();
    let controller = createController(ParticipantController, { mockApp, req, res });
    let result     = await controller.list({ params: { sessionID: session.id } });

    assert.ok(Array.isArray(result.data.participants));
  });
});

describe('ParticipantController: create', () => {
  it('should add participant to session', async () => {
    let session   = await sessionManager.createSession(testOrg.id, { name: 'Add Participant Test' });
    let { Agent } = core.getModels();
    let agent     = await Agent.create({
      organizationID: testOrg.id,
      name:           'test-participant-agent',
      pluginID:       'claude-agent',
    });

    let req        = createMockReq();
    let res        = createMockRes();
    let controller = createController(ParticipantController, { mockApp, req, res });
    let result     = await controller.create({
      params: { sessionID: session.id },
      body:   { agentID: agent.id },
    });

    assert.equal(controller.responseStatusCode, 201);
    assert.ok(result.data.participant);
  });

  it('should throw 400 if agentID is missing', async () => {
    let session    = await sessionManager.createSession(testOrg.id, { name: 'Missing Agent Test' });
    let req        = createMockReq();
    let res        = createMockRes();
    let controller = createController(ParticipantController, { mockApp, req, res });

    await assert.rejects(
      () => controller.create({ params: { sessionID: session.id }, body: {} }),
      (error) => error.message.includes('agentID is required'),
    );
  });
});

describe('ParticipantController: destroy', () => {
  it('should remove participant', async () => {
    let session   = await sessionManager.createSession(testOrg.id, { name: 'Remove Participant Test' });
    let { Agent } = core.getModels();
    let agent     = await Agent.create({
      organizationID: testOrg.id,
      name:           'test-remove-agent',
      pluginID:       'claude-agent',
    });

    let participant = await sessionManager.addParticipant(session.id, agent.id);
    let req         = createMockReq();
    let res         = createMockRes();
    let controller  = createController(ParticipantController, { mockApp, req, res });
    let result      = await controller.destroy({ params: { participantID: participant.id } });

    assert.deepEqual(result.data, { deleted: true });
  });
});

// =============================================================================
// Agent Controller
// =============================================================================

describe('AgentController: list', () => {
  it('should return agents for org', async () => {
    let { Agent } = core.getModels();
    await Agent.create({
      organizationID: testOrg.id,
      name:           'test-list-agent',
      pluginID:       'claude-agent',
    });

    let req        = createMockReq({ organizationID: testOrg.id });
    let res        = createMockRes();
    let controller = createController(AgentController, { mockApp, req, res });
    let result     = await controller.list();

    assert.ok(Array.isArray(result.data.agents));
    assert.ok(result.data.agents.length >= 1);
  });
});

describe('AgentController: create', () => {
  it('should create agent', async () => {
    let req = createMockReq({
      organizationID: testOrg.id,
      userID:         testUser.id,
      getUMK:         () => testUMK,
    });
    let res        = createMockRes();
    let controller = createController(AgentController, { mockApp, req, res });
    let result     = await controller.create({
      body: { name: 'test-create-agent', pluginID: 'claude-agent' },
    });

    assert.equal(controller.responseStatusCode, 201);
    assert.ok(result.data.agent);
    assert.equal(result.data.agent.name, 'test-create-agent');
  });

  it('should encrypt API key when provided', async () => {
    let req = createMockReq({
      organizationID: testOrg.id,
      userID:         testUser.id,
      getUMK:         () => testUMK,
    });
    let res        = createMockRes();
    let controller = createController(AgentController, { mockApp, req, res });
    let result     = await controller.create({
      body: { name: 'test-api-key-agent', pluginID: 'claude-agent', apiKey: 'sk-test-12345' },
    });

    assert.equal(controller.responseStatusCode, 201);
    assert.ok(result.data.agent);
    assert.ok(result.data.agent.encryptedAPIKey);

    // Verify it's actually encrypted
    let encrypted = JSON.parse(result.data.agent.encryptedAPIKey);
    assert.ok(encrypted.ciphertext);
    assert.ok(encrypted.iv);
    assert.ok(encrypted.authTag);

    // Verify we can decrypt it
    let userKey   = keystore.deriveUserKey(testUMK, testUser.id);
    let decrypted = keystore.decrypt(encrypted, userKey).toString('utf8');
    assert.equal(decrypted, 'sk-test-12345');
  });

  it('should throw 400 if name is missing', async () => {
    let req        = createMockReq({ organizationID: testOrg.id });
    let res        = createMockRes();
    let controller = createController(AgentController, { mockApp, req, res });

    await assert.rejects(
      () => controller.create({ body: { pluginID: 'claude-agent' } }),
      (error) => error.message.includes('name is required'),
    );
  });

  it('should throw 400 if pluginID is missing', async () => {
    let req        = createMockReq({ organizationID: testOrg.id });
    let res        = createMockRes();
    let controller = createController(AgentController, { mockApp, req, res });

    await assert.rejects(
      () => controller.create({ body: { name: 'test-no-plugin' } }),
      (error) => error.message.includes('pluginID is required'),
    );
  });
});

describe('AgentController: show', () => {
  it('should return single agent', async () => {
    let { Agent } = core.getModels();
    let agent     = await Agent.create({
      organizationID: testOrg.id,
      name:           'test-get-agent',
      pluginID:       'claude-agent',
    });

    let req        = createMockReq();
    let res        = createMockRes();
    let controller = createController(AgentController, { mockApp, req, res });
    let result     = await controller.show({ params: { agentID: agent.id } });

    assert.ok(result.data.agent);
    assert.equal(result.data.agent.id, agent.id);
  });

  it('should throw 404 if agent not found', async () => {
    let req        = createMockReq();
    let res        = createMockRes();
    let controller = createController(AgentController, { mockApp, req, res });

    await assert.rejects(
      () => controller.show({ params: { agentID: 'agt_nonexistent' } }),
      (error) => error.message.includes('Agent not found'),
    );
  });
});

describe('AgentController: update', () => {
  it('should update agent fields', async () => {
    let { Agent } = core.getModels();
    let agent     = await Agent.create({
      organizationID: testOrg.id,
      name:           'test-update-agent',
      pluginID:       'claude-agent',
    });

    let req        = createMockReq();
    let res        = createMockRes();
    let controller = createController(AgentController, { mockApp, req, res });
    let result     = await controller.update({
      params: { agentID: agent.id },
      body:   { name: 'test-updated-name', instructions: 'Be helpful' },
    });

    assert.equal(result.data.agent.name, 'test-updated-name');
    assert.equal(result.data.agent.instructions, 'Be helpful');
  });
});

describe('AgentController: destroy', () => {
  it('should delete agent', async () => {
    let { Agent } = core.getModels();
    let agent     = await Agent.create({
      organizationID: testOrg.id,
      name:           'test-delete-agent',
      pluginID:       'claude-agent',
    });

    let req        = createMockReq();
    let res        = createMockRes();
    let controller = createController(AgentController, { mockApp, req, res });
    let result     = await controller.destroy({ params: { agentID: agent.id } });

    assert.deepEqual(result.data, { deleted: true });

    let found = await Agent.where.id.EQ(agent.id).first();
    assert.ok(!found, 'Agent should be deleted');
  });
});

// =============================================================================
// Interaction Controller
// =============================================================================

describe('InteractionController: sendMessage', () => {
  it('should throw 400 if message is missing', async () => {
    let req        = createMockReq();
    let res        = createMockRes();
    let controller = createController(InteractionController, { mockApp, req, res });

    await assert.rejects(
      () => controller.sendMessage({
        params: { sessionID: 'ses_test' },
        body:   { agentID: 'agt_test' },
      }),
      (error) => error.message.includes('message is required'),
    );
  });

  it('should post message without agent when agentID is missing', async () => {
    // Create a real session so postMessage can persist the frame
    let session = await sessionManager.createSession(testOrg.id, { name: 'No Agent Session' });

    let req        = createMockReq({ userID: testUser.id });
    let res        = createMockRes();
    let controller = createController(InteractionController, { mockApp, req, res });

    let result = await controller.sendMessage({
      params: { sessionID: session.id },
      body:   { message: 'hello without agent' },
    });

    assert.ok(result);
    assert.ok(result.data);
    assert.ok(result.data.interactionID);
    assert.ok(result.data.frameID);
    assert.equal(controller.responseStatusCode, 201);
  });

  it('should throw 404 if agent not found', async () => {
    let req = createMockReq({ userID: testUser.id });
    let res        = createMockRes();
    let controller = createController(InteractionController, { mockApp, req, res });

    await assert.rejects(
      () => controller.sendMessage({
        params: { sessionID: 'ses_test' },
        body:   { message: 'hello', agentID: 'agt_nonexistent' },
      }),
      (error) => error.message.includes('Agent not found'),
    );
  });

  it('should throw 400 if plugin not registered', async () => {
    let { Agent } = core.getModels();
    let agent     = await Agent.create({
      organizationID: testOrg.id,
      name:           'test-no-plugin-registered',
      pluginID:       'nonexistent-plugin',
    });

    let req = createMockReq({ userID: testUser.id });
    let res        = createMockRes();
    let controller = createController(InteractionController, { mockApp, req, res });

    await assert.rejects(
      () => controller.sendMessage({
        params: { sessionID: 'ses_test' },
        body:   { message: 'hello', agentID: agent.id },
      }),
      (error) => error.message.includes('No agent plugin registered'),
    );
  });
});

describe('InteractionController: cancel', () => {
  it('should cancel interaction', async () => {
    let req        = createMockReq();
    let res        = createMockRes();
    let controller = createController(InteractionController, { mockApp, req, res });
    let result     = await controller.cancel({ params: { sessionID: 'ses_test' } });

    assert.equal(result.data.cancelled, true);
  });
});

// =============================================================================
// Frame Controller
// =============================================================================

describe('FrameController: list', () => {
  it('should return frames for session', async () => {
    let session = await sessionManager.createSession(testOrg.id, { name: 'Frames Test' });

    let frmID1 = `frm_${XID.next()}`;
    let frmID2 = `frm_${XID.next()}`;
    let intID  = `int_${XID.next()}`;

    await framePersistence.saveFrames(session.id, [
      {
        id:            frmID1,
        type:          'user-message',
        content:       { text: 'Hello' },
        order:         1,
        timestamp:     Date.now(),
        interactionID: intID,
        authorType:    'user',
        hidden:        false,
        deleted:       false,
        processed:     false,
      },
      {
        id:            frmID2,
        type:          'message',
        content:       { html: '<p>Hi there!</p>' },
        order:         2,
        timestamp:     Date.now(),
        interactionID: intID,
        authorType:    'agent',
        hidden:        false,
        deleted:       false,
        processed:     false,
      },
    ]);

    let req        = createMockReq();
    let res        = createMockRes();
    let controller = createController(FrameController, { mockApp, req, res });
    let result     = await controller.list({ params: { sessionID: session.id } });

    assert.ok(Array.isArray(result.data.frames));
    assert.equal(result.data.frames.length, 2);
  });
});

// =============================================================================
// Stream Controller
// =============================================================================

describe('StreamController: connect', () => {
  // Helper: create an SSE mock request that stores the 'close' callback
  // so we can trigger it to resolve the connect() promise.
  function createSSEReq(overrides = {}) {
    let closeCallback = null;
    let req = createMockReq({
      ...overrides,
      on(event, cb) {
        if (event === 'close')
          closeCallback = cb;
      },
    });

    req._triggerClose = () => {
      if (closeCallback)
        closeCallback();
    };

    return req;
  }

  it('should set correct SSE headers', async () => {
    let req        = createSSEReq({ params: { sessionID: 'ses_sse_test' } });
    let res        = createMockRes();
    let controller = createController(StreamController, { mockApp, req, res });

    // Don't await — connect() blocks until client disconnects
    let connectPromise = controller.connect({ params: { sessionID: 'ses_sse_test' } });

    // Headers are set synchronously before the promise blocks
    assert.equal(res._headers['Content-Type'], 'text/event-stream');
    assert.equal(res._headers['Cache-Control'], 'no-cache');
    assert.equal(res._headers['Connection'], 'keep-alive');

    req._triggerClose();
    await connectPromise;
  });

  it('should send connected event on open', async () => {
    let req        = createSSEReq({ params: { sessionID: 'ses_sse_ping' } });
    let res        = createMockRes();
    let controller = createController(StreamController, { mockApp, req, res });

    let connectPromise = controller.connect({ params: { sessionID: 'ses_sse_ping' } });

    assert.ok(res._written.includes('event: connected'));
    assert.ok(res._written.includes('data: {}'));

    req._triggerClose();
    await connectPromise;
  });

  it('should emit frame events for matching session', async () => {
    let sessionID  = 'ses_sse_frames';
    let req        = createSSEReq({ params: { sessionID } });
    let res        = createMockRes();
    let controller = createController(StreamController, { mockApp, req, res });

    let connectPromise = controller.connect({ params: { sessionID } });

    let testFrame = { id: 'frm_sse_1', type: 'message', content: { html: '<p>Test</p>' } };
    interactionLoop.emit('frame', { sessionID: sessionID, frame: testFrame });

    assert.ok(res._written.includes('event: frame'));
    assert.ok(res._written.includes('"frm_sse_1"'));

    req._triggerClose();
    await connectPromise;
  });

  it('should NOT emit frame events for non-matching session', async () => {
    let sessionID  = 'ses_sse_no_match';
    let req        = createSSEReq({ params: { sessionID } });
    let res        = createMockRes();
    let controller = createController(StreamController, { mockApp, req, res });

    let connectPromise = controller.connect({ params: { sessionID } });

    let initialWritten = res._written;

    interactionLoop.emit('frame', { sessionID: 'ses_other_session', frame: { id: 'frm_other' } });

    assert.equal(res._written, initialWritten);

    req._triggerClose();
    await connectPromise;
  });

  it('should emit usage events for matching session', async () => {
    let sessionID  = 'ses_sse_usage';
    let req        = createSSEReq({ params: { sessionID } });
    let res        = createMockRes();
    let controller = createController(StreamController, { mockApp, req, res });

    let connectPromise = controller.connect({ params: { sessionID } });

    let usage = { inputTokens: 500, outputTokens: 200, cacheReadInputTokens: 400 };
    interactionLoop.emit('interaction:usage', { sessionID: sessionID, interactionID: 'int_usage_1', usage });

    assert.ok(res._written.includes('event: usage'));
    assert.ok(res._written.includes('"inputTokens":500'));
    assert.ok(res._written.includes('"int_usage_1"'));

    req._triggerClose();
    await connectPromise;
  });

  it('should NOT emit usage events for non-matching session', async () => {
    let sessionID  = 'ses_sse_usage_no';
    let req        = createSSEReq({ params: { sessionID } });
    let res        = createMockRes();
    let controller = createController(StreamController, { mockApp, req, res });

    let connectPromise = controller.connect({ params: { sessionID } });

    let initialWritten = res._written;

    interactionLoop.emit('interaction:usage', { sessionID: 'ses_other', interactionID: 'int_x', usage: { inputTokens: 1 } });

    assert.equal(res._written, initialWritten);

    req._triggerClose();
    await connectPromise;
  });
});

// =============================================================================
// Route DSL
// =============================================================================

describe('Route DSL', () => {
  it('should export getRoutes function', async () => {
    let { getRoutes } = await import('../../src/server/routes/index.mjs');
    assert.equal(typeof getRoutes, 'function');
  });
});

// =============================================================================
// Error Handling
// =============================================================================

describe('Error handling', () => {
  it('should throw for non-existent session delete', async () => {
    let req        = createMockReq();
    let res        = createMockRes();
    let controller = createController(SessionController, { mockApp, req, res });

    await assert.rejects(
      () => controller.destroy({ params: { sessionID: 'ses_nonexistent_for_delete' } }),
    );
  });

  it('should throw 400 for missing required fields', async () => {
    let req        = createMockReq();
    let res        = createMockRes();
    let controller = createController(ParticipantController, { mockApp, req, res });

    await assert.rejects(
      () => controller.create({ params: { sessionID: 'ses_test' }, body: {} }),
      (error) => error.message.includes('agentID is required'),
    );
  });
});

// =============================================================================
// Application Class
// =============================================================================

describe('Application class', () => {
  it('should export Application', async () => {
    let { Application } = await import('../../src/server/application.mjs');
    assert.equal(typeof Application, 'function');
    assert.equal(Application.getName(), 'kikx-v2');
  });
});

// =============================================================================
// Failure & adversarial tests
// =============================================================================

describe('AuthController: register — adversarial', () => {
  it('should throw 400 if email AND password are both missing', async () => {
    let req        = createMockReq({ body: {} });
    let res        = createMockRes();
    let controller = createController(AuthController, { mockApp, req, res });

    await assert.rejects(
      () => controller.register({ body: req.body }),
    );
  });

  it('should throw on duplicate email registration', async () => {
    let req        = createMockReq({ body: { email: 'test@example.com', password: 'password123' } });
    let res        = createMockRes();
    let controller = createController(AuthController, { mockApp, req, res });

    await assert.rejects(
      () => controller.register({ body: req.body }),
    );
  });
});

describe('AuthController: login — adversarial', () => {
  it('should throw on non-existent email', async () => {
    let req        = createMockReq({ body: { email: 'ghost@nowhere.com', password: 'pass' } });
    let res        = createMockRes();
    let controller = createController(AuthController, { mockApp, req, res });

    await assert.rejects(
      () => controller.login({ body: req.body }),
    );
  });

  it('should throw when email is missing', async () => {
    let req        = createMockReq({ body: { password: 'pass' } });
    let res        = createMockRes();
    let controller = createController(AuthController, { mockApp, req, res });

    await assert.rejects(
      () => controller.login({ body: req.body }),
    );
  });

  it('should throw when password is missing', async () => {
    let req        = createMockReq({ body: { email: 'test@example.com' } });
    let res        = createMockRes();
    let controller = createController(AuthController, { mockApp, req, res });

    await assert.rejects(
      () => controller.login({ body: req.body }),
    );
  });
});

describe('SessionController: update — non-existent session', () => {
  it('should throw 404 when updating non-existent session', async () => {
    let req        = createMockReq();
    let res        = createMockRes();
    let controller = createController(SessionController, { mockApp, req, res });

    await assert.rejects(
      () => controller.update({ params: { sessionID: 'ses_ghost' }, body: { name: 'Updated' } }),
    );
  });
});

describe('SessionController: archive — non-existent session', () => {
  it('should throw 404 when archiving non-existent session', async () => {
    let req        = createMockReq();
    let res        = createMockRes();
    let controller = createController(SessionController, { mockApp, req, res });

    await assert.rejects(
      () => controller.archive({ params: { sessionID: 'ses_gone' } }),
    );
  });
});

describe('SessionController: revive — non-existent session', () => {
  it('should throw 404 when reviving non-existent session', async () => {
    let req        = createMockReq();
    let res        = createMockRes();
    let controller = createController(SessionController, { mockApp, req, res });

    await assert.rejects(
      () => controller.revive({ params: { sessionID: 'ses_gone' } }),
    );
  });
});

describe('AgentController: update — non-existent agent', () => {
  it('should throw 404 when updating non-existent agent', async () => {
    let req        = createMockReq();
    let res        = createMockRes();
    let controller = createController(AgentController, { mockApp, req, res });

    await assert.rejects(
      () => controller.update({ params: { agentID: 'agt_ghost' }, body: { name: 'test-ghost-update' } }),
    );
  });
});

describe('AgentController: destroy — non-existent agent', () => {
  it('should throw 404 when deleting non-existent agent', async () => {
    let req        = createMockReq();
    let res        = createMockRes();
    let controller = createController(AgentController, { mockApp, req, res });

    await assert.rejects(
      () => controller.destroy({ params: { agentID: 'agt_ghost' } }),
    );
  });
});

describe('ParticipantController: destroy — non-existent participant', () => {
  it('should throw 404 when removing non-existent participant', async () => {
    let req        = createMockReq();
    let res        = createMockRes();
    let controller = createController(ParticipantController, { mockApp, req, res });

    await assert.rejects(
      () => controller.destroy({ params: { participantID: 'prt_ghost' } }),
    );
  });
});

describe('ParticipantController: create — non-existent session', () => {
  it('should throw when adding participant to non-existent session', async () => {
    let { Agent } = core.getModels();
    let agent     = await Agent.create({
      organizationID: testOrg.id,
      name:           'test-prt-fail-agent',
      pluginID:       'claude-agent',
    });

    let req        = createMockReq();
    let res        = createMockRes();
    let controller = createController(ParticipantController, { mockApp, req, res });

    await assert.rejects(
      () => controller.create({
        params: { sessionID: 'ses_nonexistent' },
        body:   { agentID: agent.id },
      }),
    );
  });
});

describe('DmController: updateSummary — non-existent agent', () => {
  it('should throw 404 when updating summary for non-existent agent', async () => {
    let req = createMockReq({ params: { agentID: 'agt_nowhere' } });
    let res = createMockRes();
    let controller = createController(DmController, { mockApp, req, res });

    await assert.rejects(
      () => controller.updateSummary({
        params: { agentID: 'agt_nowhere' },
        body:   { summary: 'Should fail' },
      }),
    );
  });
});

describe('FrameController: list — empty session', () => {
  it('should return empty array for session with no frames', async () => {
    let session    = await sessionManager.createSession(testOrg.id, { name: 'Empty Frames' });
    let req        = createMockReq();
    let res        = createMockRes();
    let controller = createController(FrameController, { mockApp, req, res });
    let result     = await controller.list({ params: { sessionID: session.id } });

    assert.ok(Array.isArray(result.data.frames));
    assert.equal(result.data.frames.length, 0);
  });
});

describe('FrameController: update', () => {
  it('should update frame content', async () => {
    let session = await sessionManager.createSession(testOrg.id, { name: 'Update Frame Test' });
    let frameID = `frm_${XID.next()}`;
    let intID   = `int_${XID.next()}`;

    await framePersistence.saveFrames(session.id, [
      {
        id:            frameID,
        type:          'message',
        content:       { html: '<p>Original</p><kikx-hml-prompt name="color" type="text" label="Color"></kikx-hml-prompt>' },
        order:         1,
        timestamp:     Date.now(),
        interactionID: intID,
        authorType:    'agent',
        hidden:        false,
        deleted:       false,
        processed:     false,
      },
    ]);

    let req        = createMockReq();
    let res        = createMockRes();
    let controller = createController(FrameController, { mockApp, req, res });

    let updatedHTML = '<p>Original</p><kikx-hml-prompt name="color" type="text" label="Color" value="blue" readonly></kikx-hml-prompt>';
    let result = await controller.update({
      params: { sessionID: session.id, frameID },
      body:   { content: { html: updatedHTML } },
    });

    assert.ok(result.data.frame);
    assert.equal(result.data.frame.id, frameID);

    // Verify persisted by reloading
    let reloaded    = await framePersistence.loadFrames(session.id);
    let frames      = reloaded.toArray();
    let updatedFrame = frames.find((f) => f.id === frameID);

    assert.ok(updatedFrame);
    assert.ok(updatedFrame.content.html.includes('value="blue"'));
    assert.ok(updatedFrame.content.html.includes('readonly'));
  });

  it('should reject update with missing content', async () => {
    let req        = createMockReq();
    let res        = createMockRes();
    let controller = createController(FrameController, { mockApp, req, res });

    await assert.rejects(
      () => controller.update({
        params: { sessionID: 'ses_any', frameID: 'frm_any' },
        body:   {},
      }),
    );
  });

  it('should reject update for non-existent frame', async () => {
    let req        = createMockReq();
    let res        = createMockRes();
    let controller = createController(FrameController, { mockApp, req, res });

    await assert.rejects(
      () => controller.update({
        params: { sessionID: 'ses_any', frameID: 'frm_nonexistent' },
        body:   { content: { html: '<p>Updated</p>' } },
      }),
    );
  });

  it('should reject update when frame belongs to different session', async () => {
    let session1 = await sessionManager.createSession(testOrg.id, { name: 'Session 1' });
    let session2 = await sessionManager.createSession(testOrg.id, { name: 'Session 2' });
    let frameID  = `frm_${XID.next()}`;

    await framePersistence.saveFrames(session1.id, [
      {
        id:            frameID,
        type:          'message',
        content:       { html: '<p>Mine</p>' },
        order:         1,
        timestamp:     Date.now(),
        interactionID: `int_${XID.next()}`,
        authorType:    'agent',
        hidden:        false,
        deleted:       false,
        processed:     false,
      },
    ]);

    let req        = createMockReq();
    let res        = createMockRes();
    let controller = createController(FrameController, { mockApp, req, res });

    await assert.rejects(
      () => controller.update({
        params: { sessionID: session2.id, frameID },
        body:   { content: { html: '<p>Hacked</p>' } },
      }),
    );
  });
});

describe('InteractionController: sendMessage — empty message', () => {
  it('should throw 400 when message is empty string', async () => {
    let req        = createMockReq();
    let res        = createMockRes();
    let controller = createController(InteractionController, { mockApp, req, res });

    await assert.rejects(
      () => controller.sendMessage({
        params: { sessionID: 'ses_test' },
        body:   { message: '', agentID: 'agt_test' },
      }),
      (error) => error.message.includes('message is required'),
    );
  });
});

// =============================================================================
// skipAuthorization
// =============================================================================

describe('AuthController: skipAuthorization', () => {
  it('should skip auth for register and login', () => {
    let req        = createMockReq();
    let res        = createMockRes();
    let controller = createController(AuthController, { mockApp, req, res });

    assert.equal(controller.skipAuthorization({ methodName: 'register' }), true);
    assert.equal(controller.skipAuthorization({ methodName: 'login' }), true);
    assert.equal(controller.skipAuthorization({ methodName: 'me' }), false);
  });
});

// =============================================================================
// Phase 3: DmController
// =============================================================================

describe('DmController', () => {
  it('should create a DM session via getOrCreate', async () => {
    let { Agent, Organization } = core.getModels();

    // Create test org and agent
    let org   = await Organization.create({ name: 'DM Test Org' });
    let agent = await Agent.create({
      organizationID: org.id,
      name:           'test-dm-ctrl-agent',
      pluginID:       'test-agent',
    });

    let req = createMockReq({ params: { agentID: agent.id } });
    let res = createMockRes();
    let controller = createController(DmController, { mockApp, req, res });

    let result = await controller.getOrCreate({ params: { agentID: agent.id } });
    assert.ok(result.data.session);
    assert.equal(result.data.session.type, 'dm');
    assert.equal(result.data.session.dmAgentID, agent.id);
  });

  it('should reuse existing DM session', async () => {
    let { Agent, Organization } = core.getModels();

    let org   = await Organization.create({ name: 'DM Reuse Org' });
    let agent = await Agent.create({
      organizationID: org.id,
      name:           'test-dm-reuse-agent',
      pluginID:       'test-agent',
    });

    let req = createMockReq({ params: { agentID: agent.id } });
    let res = createMockRes();

    let controller1 = createController(DmController, { mockApp, req, res });
    let result1     = await controller1.getOrCreate({ params: { agentID: agent.id } });
    let sessionID1  = result1.data.session.id;

    let controller2 = createController(DmController, { mockApp, req, res: createMockRes() });
    let result2     = await controller2.getOrCreate({ params: { agentID: agent.id } });
    let sessionID2  = result2.data.session.id;

    assert.equal(sessionID1, sessionID2);
  });

  it('should get null summary when none exists', async () => {
    let { Agent, Organization } = core.getModels();

    let org   = await Organization.create({ name: 'DM Summary Org' });
    let agent = await Agent.create({
      organizationID: org.id,
      name:           'test-dm-summary-agent',
      pluginID:       'test-agent',
    });

    let req = createMockReq({ params: { agentID: agent.id } });
    let res = createMockRes();
    let controller = createController(DmController, { mockApp, req, res });

    let result = await controller.getSummary({ params: { agentID: agent.id } });
    assert.equal(result.data.summary, null);
  });

  it('should update DM summary via PUT', async () => {
    let { Agent, Organization } = core.getModels();

    let org   = await Organization.create({ name: 'DM Update Org' });
    let agent = await Agent.create({
      organizationID: org.id,
      name:           'test-dm-update-agent',
      pluginID:       'test-agent',
    });

    let req = createMockReq({ params: { agentID: agent.id } });
    let res = createMockRes();
    let controller = createController(DmController, { mockApp, req, res });

    let result = await controller.updateSummary({
      params: { agentID: agent.id },
      body:   { summary: 'Always respond in bullet points' },
    });

    assert.equal(result.data.summary, 'Always respond in bullet points');

    // Verify persisted
    let found = await Agent.where.id.EQ(agent.id).first();
    assert.equal(found.dmSummary, 'Always respond in bullet points');
  });

  it('should return 404 for non-existent agent on getSummary', async () => {
    let req = createMockReq({ params: { agentID: 'agt_nonexistent' } });
    let res = createMockRes();
    let controller = createController(DmController, { mockApp, req, res });

    await assert.rejects(
      () => controller.getSummary({ params: { agentID: 'agt_nonexistent' } }),
      (error) => error.message.includes('not found') || error.statusCode === 404,
    );
  });

  it('should return 404 for non-existent agent on getOrCreate', async () => {
    let req = createMockReq({ params: { agentID: 'agt_ghost' } });
    let res = createMockRes();
    let controller = createController(DmController, { mockApp, req, res });

    await assert.rejects(
      () => controller.getOrCreate({ params: { agentID: 'agt_ghost' } }),
      (error) => error.message.includes('not found') || error.statusCode === 404,
    );
  });
});
