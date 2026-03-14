'use strict';

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs     from 'node:fs';
import os     from 'node:os';
import path   from 'node:path';

import XID from 'xid-js';

import { KikxCore }                                    from '../../../src/core/kikx-core.mjs';
import { Keystore }                                    from '../../../src/core/crypto/keystore.mjs';
import { signFrameContent, decryptAgentPrivateKey }    from '../../../src/core/crypto/frame-signing.mjs';
import { InteractionLoop }                             from '../../../src/core/interaction/index.mjs';
import { SessionManager }                              from '../../../src/core/session/index.mjs';
import { FramePersistence }                            from '../../../src/core/frames/index.mjs';
import { AgentInterface }                              from '../../../src/core/plugins/agent-interface.mjs';

// =============================================================================
// Frame Authorship Signing Tests
// =============================================================================
// Verifies:
//   - signFrameContent signs with the correct key for each author type
//   - decryptAgentPrivateKey decrypts agent keys correctly
//   - InteractionLoop signs frames during interaction
//   - System frames signed with system key
//   - Agent frames signed with agent private key
//   - User frames signed with user private key (when provided)
//   - Missing keys result in null signature (no crash)
//   - Signatures are verifiable with public keys
//   - Tampering is detected
//   - Different authors produce different signatures
// =============================================================================

// ---------------------------------------------------------------------------
// Mock Agent Plugin
// ---------------------------------------------------------------------------

class MockAgent extends AgentInterface {
  static pluginID    = 'mock-agent';
  static featureName = 'mock';
  static displayName = 'Mock Agent';
  static description = 'Mock agent for frame signing tests';
  static agentType   = 'mock';

  constructor(context, blocks) {
    super(context);
    this._blocks = blocks || [];
  }

  async *_createGenerator(_params) {
    for (let block of this._blocks)
      yield block;

    yield { type: 'done', content: {} };
  }
}

// ---------------------------------------------------------------------------
// Unit Tests: signFrameContent
// ---------------------------------------------------------------------------

describe('signFrameContent (unit)', () => {
  let keystore;
  let tempDir;
  let keyPair;

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kikx-frame-sign-unit-'));

    keystore = new Keystore({ devMode: true, devSeed: 'frame-sign-unit-test' });
    keystore.initialize();
    keystore.loadServerMasterKey(tempDir);
    keystore.loadSystemKeyPair(tempDir);

    keyPair = keystore.generateSigningKeyPair();
  });

  after(() => {
    keystore.destroy();

    if (tempDir && fs.existsSync(tempDir))
      fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns null when keystore is null', () => {
    let result = signFrameContent(null, { text: 'hello' }, 'agent', keyPair.privateKey);
    assert.equal(result, null);
  });

  it('returns null when content is null', () => {
    let result = signFrameContent(keystore, null, 'agent', keyPair.privateKey);
    assert.equal(result, null);
  });

  it('returns null when content is undefined', () => {
    let result = signFrameContent(keystore, undefined, 'agent', keyPair.privateKey);
    assert.equal(result, null);
  });

  it('signs system frames with system key', () => {
    let content   = { text: 'system message' };
    let signature = signFrameContent(keystore, content, 'system', null);

    assert.ok(signature, 'system frame should be signed');
    assert.equal(typeof signature, 'string');
    assert.match(signature, /^[0-9a-f]+$/);

    // Verify with system public key
    let verified = keystore.systemVerify(content, signature);
    assert.equal(verified, true);
  });

  it('signs agent frames with provided private key', () => {
    let content   = { html: '<p>agent response</p>' };
    let signature = signFrameContent(keystore, content, 'agent', keyPair.privateKey);

    assert.ok(signature, 'agent frame should be signed');
    assert.equal(typeof signature, 'string');
    assert.match(signature, /^[0-9a-f]+$/);

    // Verify with public key
    let verified = keystore.verifyWithPublicKey(content, keyPair.publicKey, signature);
    assert.equal(verified, true);
  });

  it('signs user frames with provided private key', () => {
    let content   = { text: 'user message' };
    let signature = signFrameContent(keystore, content, 'user', keyPair.privateKey);

    assert.ok(signature, 'user frame should be signed');

    let verified = keystore.verifyWithPublicKey(content, keyPair.publicKey, signature);
    assert.equal(verified, true);
  });

  it('returns null for agent frames without private key', () => {
    let content   = { html: '<p>agent response</p>' };
    let signature = signFrameContent(keystore, content, 'agent', null);

    assert.equal(signature, null);
  });

  it('returns null for user frames without private key', () => {
    let content   = { text: 'user message' };
    let signature = signFrameContent(keystore, content, 'user', null);

    assert.equal(signature, null);
  });

  it('returns null for unknown author type without private key', () => {
    let content   = { text: 'mystery' };
    let signature = signFrameContent(keystore, content, 'unknown', null);

    assert.equal(signature, null);
  });

  it('detects content tampering', () => {
    let content   = { text: 'original content' };
    let signature = signFrameContent(keystore, content, 'agent', keyPair.privateKey);

    assert.ok(signature);

    let tampered = { text: 'tampered content' };
    let verified = keystore.verifyWithPublicKey(tampered, keyPair.publicKey, signature);

    assert.equal(verified, false);
  });

  it('different authors produce different signatures for same content', () => {
    let content = { text: 'shared content' };

    let keyPair1 = keystore.generateSigningKeyPair();
    let keyPair2 = keystore.generateSigningKeyPair();

    let signature1 = signFrameContent(keystore, content, 'agent', keyPair1.privateKey);
    let signature2 = signFrameContent(keystore, content, 'agent', keyPair2.privateKey);

    assert.ok(signature1);
    assert.ok(signature2);
    assert.notEqual(signature1, signature2);
  });

  it('signature from one author cannot be verified with another author public key', () => {
    let content = { text: 'test' };

    let keyPair1 = keystore.generateSigningKeyPair();
    let keyPair2 = keystore.generateSigningKeyPair();

    let signature = signFrameContent(keystore, content, 'agent', keyPair1.privateKey);

    let verified = keystore.verifyWithPublicKey(content, keyPair2.publicKey, signature);
    assert.equal(verified, false);
  });

  it('handles string content (not just objects)', () => {
    let signature = signFrameContent(keystore, 'plain string content', 'agent', keyPair.privateKey);

    assert.ok(signature);
    assert.equal(typeof signature, 'string');

    let verified = keystore.verifyWithPublicKey('plain string content', keyPair.publicKey, signature);
    assert.equal(verified, true);
  });

  it('does not throw when system key pair is not loaded', () => {
    let bareKeystore = new Keystore({ devMode: true, devSeed: 'bare-keystore' });
    bareKeystore.initialize();

    // No loadSystemKeyPair — should return null, not throw
    let signature = signFrameContent(bareKeystore, { text: 'hello' }, 'system', null);
    assert.equal(signature, null);

    bareKeystore.destroy();
  });
});

// ---------------------------------------------------------------------------
// Unit Tests: decryptAgentPrivateKey
// ---------------------------------------------------------------------------

describe('decryptAgentPrivateKey (unit)', () => {
  let keystore;
  let tempDir;

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kikx-decrypt-agent-unit-'));

    keystore = new Keystore({ devMode: true, devSeed: 'decrypt-agent-unit-test' });
    keystore.initialize();
    keystore.loadServerMasterKey(tempDir);
  });

  after(() => {
    keystore.destroy();

    if (tempDir && fs.existsSync(tempDir))
      fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('decrypts agent private key from JSON string', () => {
    let { privateKey } = keystore.generateSigningKeyPair();
    let encrypted      = keystore.encryptActorPrivateKey(privateKey, 'agt_test1');
    let jsonString     = JSON.stringify(encrypted);

    let decrypted = decryptAgentPrivateKey(keystore, jsonString, 'agt_test1');
    assert.equal(decrypted, privateKey);
  });

  it('decrypts agent private key from parsed envelope', () => {
    let { privateKey } = keystore.generateSigningKeyPair();
    let encrypted      = keystore.encryptActorPrivateKey(privateKey, 'agt_test2');

    let decrypted = decryptAgentPrivateKey(keystore, encrypted, 'agt_test2');
    assert.equal(decrypted, privateKey);
  });

  it('returns null when keystore is null', () => {
    let result = decryptAgentPrivateKey(null, '{}', 'agt_test3');
    assert.equal(result, null);
  });

  it('returns null when encryptedPrivateKey is null', () => {
    let result = decryptAgentPrivateKey(keystore, null, 'agt_test4');
    assert.equal(result, null);
  });

  it('returns null when agentID is null', () => {
    let result = decryptAgentPrivateKey(keystore, '{}', null);
    assert.equal(result, null);
  });

  it('returns null for invalid JSON string', () => {
    let result = decryptAgentPrivateKey(keystore, 'not-json', 'agt_test5');
    assert.equal(result, null);
  });

  it('returns null when decryption fails (wrong agentID)', () => {
    let { privateKey } = keystore.generateSigningKeyPair();
    let encrypted      = keystore.encryptActorPrivateKey(privateKey, 'agt_correct');
    let jsonString     = JSON.stringify(encrypted);

    let result = decryptAgentPrivateKey(keystore, jsonString, 'agt_wrong');
    assert.equal(result, null);
  });

  it('returns null for empty string', () => {
    let result = decryptAgentPrivateKey(keystore, '', 'agt_test6');
    assert.equal(result, null);
  });
});

// ---------------------------------------------------------------------------
// Integration Tests: InteractionLoop frame signing
// ---------------------------------------------------------------------------

describe('InteractionLoop frame authorship signing', () => {
  let core;
  let keystore;
  let tempDir;
  let models;
  let context;
  let sessionManager;
  let framePersistence;

  before(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kikx-frame-sign-int-'));

    core = new KikxCore({ database: { filename: ':memory:' } });
    await core.start();

    keystore = new Keystore({ devMode: true, devSeed: 'frame-sign-integration-test' });
    keystore.initialize();
    keystore.loadServerMasterKey(tempDir);
    keystore.loadSystemKeyPair(tempDir);

    models           = core.getModels();
    context          = core.getContext();
    sessionManager   = new SessionManager(context);
    framePersistence = new FramePersistence(context);

    context.setProperty('sessionManager', sessionManager);
    context.setProperty('framePersistence', framePersistence);
    context.setProperty('keystore', keystore);
  });

  after(async () => {
    keystore.destroy();

    if (core && core.isStarted())
      await core.stop();

    if (tempDir && fs.existsSync(tempDir))
      fs.rmSync(tempDir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // Agent frames signed with agent's private key
  // ---------------------------------------------------------------------------

  describe('agent frame signing', () => {
    let organization;
    let agent;
    let agentKeyPair;
    let session;
    let interactionLoop;

    beforeEach(async () => {
      interactionLoop = new InteractionLoop(context);
      organization    = await models.Organization.create({ name: 'Frame Sign Agent Org' });

      // Generate agent key pair and encrypt private key
      agentKeyPair   = keystore.generateSigningKeyPair();
      let encrypted  = keystore.encryptActorPrivateKey(agentKeyPair.privateKey, 'agt_sign_test');

      agent = await models.Agent.create({
        organizationID:     organization.id,
        name:               'test-sign-agent',
        pluginID:           'mock-agent',
        publicKey:          agentKeyPair.publicKey,
        encryptedPrivateKey: JSON.stringify(encrypted),
      });

      // Override the agent ID for consistent encryption key derivation
      // Actually we need to use the real agent ID for encryption to work
      let realEncrypted = keystore.encryptActorPrivateKey(agentKeyPair.privateKey, agent.id);
      agent.encryptedPrivateKey = JSON.stringify(realEncrypted);
      await agent.save();

      session = await sessionManager.createSession(organization.id);
    });

    it('signs agent message frames with agent private key', async () => {
      let capturedFrames = [];
      interactionLoop.on('frame', (event) => capturedFrames.push(event.frame));

      let mockAgent = new MockAgent(context, [
        { type: 'message', content: { html: '<p>hello from agent</p>' }, authorType: 'agent', authorID: agent.id },
      ]);

      await interactionLoop.startInteraction(session.id, {
        agentPlugin: mockAgent,
        agent:       { id: agent.id, name: agent.name, encryptedPrivateKey: agent.encryptedPrivateKey },
        userMessage: 'test message',
      });

      let agentFrames = capturedFrames.filter((f) => f.authorType === 'agent');
      assert.ok(agentFrames.length > 0, 'should have agent frames');

      for (let frame of agentFrames) {
        assert.ok(frame.signature, `agent frame "${frame.type}" should have a signature`);

        let verified = keystore.verifyWithPublicKey(frame.content, agentKeyPair.publicKey, frame.signature);
        assert.equal(verified, true, `agent frame "${frame.type}" signature should verify`);
      }
    });

    it('signs agent tool-call frames', async () => {
      let capturedFrames = [];
      interactionLoop.on('frame', (event) => capturedFrames.push(event.frame));

      let mockAgent = new MockAgent(context, [
        {
          type:       'tool-call',
          content:    { toolName: 'test:tool', arguments: { foo: 'bar' }, toolUseId: 'tu_1' },
          authorType: 'agent',
          authorID:   agent.id,
        },
      ]);

      await interactionLoop.startInteraction(session.id, {
        agentPlugin: mockAgent,
        agent:       { id: agent.id, name: agent.name, encryptedPrivateKey: agent.encryptedPrivateKey },
        userMessage: 'test tool call',
      });

      let toolCallFrames = capturedFrames.filter((f) => f.type === 'tool-call');
      assert.ok(toolCallFrames.length > 0, 'should have tool-call frames');

      for (let frame of toolCallFrames) {
        assert.ok(frame.signature, 'tool-call frame should have a signature');

        let verified = keystore.verifyWithPublicKey(frame.content, agentKeyPair.publicKey, frame.signature);
        assert.equal(verified, true, 'tool-call frame signature should verify');
      }
    });

    it('signs agent reflection frames', async () => {
      let capturedFrames = [];
      interactionLoop.on('frame', (event) => capturedFrames.push(event.frame));

      let mockAgent = new MockAgent(context, [
        { type: 'reflection', content: { thinking: 'deep thoughts' }, authorType: 'agent', authorID: agent.id },
      ]);

      await interactionLoop.startInteraction(session.id, {
        agentPlugin: mockAgent,
        agent:       { id: agent.id, name: agent.name, encryptedPrivateKey: agent.encryptedPrivateKey },
        userMessage: 'think about this',
      });

      let reflectionFrames = capturedFrames.filter((f) => f.type === 'reflection');
      assert.ok(reflectionFrames.length > 0, 'should have reflection frames');

      for (let frame of reflectionFrames) {
        assert.ok(frame.signature, 'reflection frame should have a signature');

        let verified = keystore.verifyWithPublicKey(frame.content, agentKeyPair.publicKey, frame.signature);
        assert.equal(verified, true, 'reflection frame signature should verify');
      }
    });
  });

  // ---------------------------------------------------------------------------
  // System frames signed with system key
  // ---------------------------------------------------------------------------

  describe('system frame signing', () => {
    let organization;
    let session;
    let interactionLoop;

    beforeEach(async () => {
      interactionLoop = new InteractionLoop(context);
      organization    = await models.Organization.create({ name: 'Frame Sign System Org' });
      session         = await sessionManager.createSession(organization.id);
    });

    it('signs system tool-result frames with system key', async () => {
      let capturedFrames = [];
      interactionLoop.on('frame', (event) => capturedFrames.push(event.frame));

      let mockAgent = new MockAgent(context, [
        {
          type:       'tool-call',
          content:    { toolName: 'test:tool', arguments: {}, toolUseId: 'tu_sys' },
          authorType: 'agent',
          authorID:   'agt_sys_test',
        },
      ]);

      await interactionLoop.startInteraction(session.id, {
        agentPlugin: mockAgent,
        agent:       { id: 'agt_sys_test', name: 'test-system-sign' },
        userMessage: 'test system signing',
        executeTool: async () => 'tool output',
      });

      let systemFrames = capturedFrames.filter((f) => f.authorType === 'system');
      assert.ok(systemFrames.length > 0, 'should have system frames');

      for (let frame of systemFrames) {
        assert.ok(frame.signature, `system frame "${frame.type}" should have a signature`);

        let systemPublicKey = keystore.getSystemPublicKey();
        let verified        = keystore.verifyWithPublicKey(frame.content, systemPublicKey, frame.signature);
        assert.equal(verified, true, `system frame "${frame.type}" signature should verify with system public key`);
      }
    });

    it('signs error frames as system', async () => {
      let capturedFrames = [];
      interactionLoop.on('frame', (event) => capturedFrames.push(event.frame));

      // Create a mock agent that throws an error
      let errorAgent = new MockAgent(context, []);
      errorAgent._createGenerator = async function *() {
        throw new Error('test error for signing');
      };

      await interactionLoop.startInteraction(session.id, {
        agentPlugin: errorAgent,
        agent:       { id: 'agt_err_test', name: 'test-error-sign' },
        userMessage: 'trigger error',
      });

      let errorFrames = capturedFrames.filter((f) => f.type === 'error');
      assert.ok(errorFrames.length > 0, 'should have error frames');

      for (let frame of errorFrames) {
        assert.ok(frame.signature, 'error frame should have a signature');

        let systemPublicKey = keystore.getSystemPublicKey();
        let verified        = keystore.verifyWithPublicKey(frame.content, systemPublicKey, frame.signature);
        assert.equal(verified, true, 'error frame signature should verify with system public key');
      }
    });
  });

  // ---------------------------------------------------------------------------
  // User frames signed when user private key is provided
  // ---------------------------------------------------------------------------

  describe('user frame signing', () => {
    let organization;
    let session;
    let interactionLoop;
    let userKeyPair;

    beforeEach(async () => {
      interactionLoop = new InteractionLoop(context);
      organization    = await models.Organization.create({ name: 'Frame Sign User Org' });
      session         = await sessionManager.createSession(organization.id);
      userKeyPair     = keystore.generateSigningKeyPair();
    });

    it('signs user-message frames when userPrivateKey is provided', async () => {
      let capturedFrames = [];
      interactionLoop.on('frame', (event) => capturedFrames.push(event.frame));

      let mockAgent = new MockAgent(context, [
        { type: 'message', content: { html: '<p>reply</p>' }, authorType: 'agent', authorID: 'agt_user_test' },
      ]);

      await interactionLoop.startInteraction(session.id, {
        agentPlugin:    mockAgent,
        agent:          { id: 'agt_user_test', name: 'test-user-sign' },
        userMessage:    'hello from user',
        authorType:     'user',
        authorID:       'usr_test1',
        userPrivateKey: userKeyPair.privateKey,
      });

      let userFrames = capturedFrames.filter((f) => f.authorType === 'user');
      assert.ok(userFrames.length > 0, 'should have user frames');

      for (let frame of userFrames) {
        assert.ok(frame.signature, `user frame "${frame.type}" should have a signature`);

        let verified = keystore.verifyWithPublicKey(frame.content, userKeyPair.publicKey, frame.signature);
        assert.equal(verified, true, `user frame "${frame.type}" signature should verify with user public key`);
      }
    });

    it('does not sign user-message frames when userPrivateKey is not provided', async () => {
      let capturedFrames = [];
      interactionLoop.on('frame', (event) => capturedFrames.push(event.frame));

      let mockAgent = new MockAgent(context, [
        { type: 'message', content: { html: '<p>reply</p>' }, authorType: 'agent', authorID: 'agt_no_user_key' },
      ]);

      await interactionLoop.startInteraction(session.id, {
        agentPlugin: mockAgent,
        agent:       { id: 'agt_no_user_key', name: 'test-no-user-key' },
        userMessage: 'hello without key',
        authorType:  'user',
        authorID:    'usr_test2',
      });

      let userFrames = capturedFrames.filter((f) => f.authorType === 'user');
      assert.ok(userFrames.length > 0, 'should have user frames');

      for (let frame of userFrames) {
        assert.equal(frame.signature, undefined, 'user frame should NOT have a signature without userPrivateKey');
      }
    });

    it('signs user-message frames via postMessage when userPrivateKey is provided', async () => {
      let capturedFrames = [];
      interactionLoop.on('frame', (event) => capturedFrames.push(event.frame));

      await interactionLoop.postMessage(session.id, {
        text:           'posted message',
        authorType:     'user',
        authorID:       'usr_post1',
        userPrivateKey: userKeyPair.privateKey,
      });

      let userFrames = capturedFrames.filter((f) => f.authorType === 'user');
      assert.ok(userFrames.length > 0, 'should have user frames from postMessage');

      for (let frame of userFrames) {
        assert.ok(frame.signature, 'postMessage user frame should have a signature');

        let verified = keystore.verifyWithPublicKey(frame.content, userKeyPair.publicKey, frame.signature);
        assert.equal(verified, true, 'postMessage user frame signature should verify');
      }
    });
  });

  // ---------------------------------------------------------------------------
  // No keystore — signing gracefully skipped
  // ---------------------------------------------------------------------------

  describe('no keystore on context', () => {
    it('does not crash and produces no signatures when keystore is absent', async () => {
      // Create a separate context without keystore
      let bareCore = new KikxCore({ database: { filename: ':memory:' } });
      await bareCore.start();

      let bareContext          = bareCore.getContext();
      let bareSessionManager   = new SessionManager(bareContext);
      let bareFramePersistence = new FramePersistence(bareContext);
      let bareModels           = bareCore.getModels();

      bareContext.setProperty('sessionManager', bareSessionManager);
      bareContext.setProperty('framePersistence', bareFramePersistence);
      // Intentionally NOT setting keystore

      let bareLoop     = new InteractionLoop(bareContext);
      let organization = await bareModels.Organization.create({ name: 'No Keystore Org' });
      let session      = await bareSessionManager.createSession(organization.id);

      let capturedFrames = [];
      bareLoop.on('frame', (event) => capturedFrames.push(event.frame));

      let mockAgent = new MockAgent(bareContext, [
        { type: 'message', content: { html: '<p>reply</p>' }, authorType: 'agent', authorID: 'agt_bare' },
      ]);

      await bareLoop.startInteraction(session.id, {
        agentPlugin: mockAgent,
        agent:       { id: 'agt_bare', name: 'test-bare' },
        userMessage: 'hello',
      });

      assert.ok(capturedFrames.length > 0, 'should have frames');

      for (let frame of capturedFrames) {
        assert.equal(frame.signature, undefined, 'no frame should have a signature without keystore');
      }

      await bareCore.stop();
    });
  });

  // ---------------------------------------------------------------------------
  // Agent without encryptedPrivateKey — signing gracefully skipped for agent
  // ---------------------------------------------------------------------------

  describe('agent without encryptedPrivateKey', () => {
    it('does not sign agent frames when agent has no encryptedPrivateKey', async () => {
      let interactionLoop = new InteractionLoop(context);
      let organization    = await models.Organization.create({ name: 'No Agent Key Org' });
      let session         = await sessionManager.createSession(organization.id);

      let capturedFrames = [];
      interactionLoop.on('frame', (event) => capturedFrames.push(event.frame));

      let mockAgent = new MockAgent(context, [
        { type: 'message', content: { html: '<p>agent without key</p>' }, authorType: 'agent', authorID: 'agt_nokey' },
      ]);

      await interactionLoop.startInteraction(session.id, {
        agentPlugin: mockAgent,
        agent:       { id: 'agt_nokey', name: 'test-no-key' },
        userMessage: 'test no agent key',
      });

      let agentFrames = capturedFrames.filter((f) => f.authorType === 'agent');
      assert.ok(agentFrames.length > 0, 'should have agent frames');

      for (let frame of agentFrames) {
        assert.equal(frame.signature, undefined, 'agent frame should NOT have a signature without encryptedPrivateKey');
      }

      // System frames should still be signed
      let systemFrames = capturedFrames.filter((f) => f.authorType === 'system');
      if (systemFrames.length > 0) {
        for (let frame of systemFrames) {
          assert.ok(frame.signature, 'system frames should still be signed even when agent has no key');
        }
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Signature persists to database
  // ---------------------------------------------------------------------------

  describe('signature persistence', () => {
    it('persists the signature to the database', async () => {
      let interactionLoop = new InteractionLoop(context);
      let organization    = await models.Organization.create({ name: 'Persist Sig Org' });
      let session         = await sessionManager.createSession(organization.id);

      let agentKeyPair    = keystore.generateSigningKeyPair();
      let agent           = await models.Agent.create({
        organizationID: organization.id,
        name:           'test-persist-sig',
        pluginID:       'mock-agent',
        publicKey:      agentKeyPair.publicKey,
      });

      let encrypted = keystore.encryptActorPrivateKey(agentKeyPair.privateKey, agent.id);
      agent.encryptedPrivateKey = JSON.stringify(encrypted);
      await agent.save();

      let mockAgent = new MockAgent(context, [
        { type: 'message', content: { html: '<p>persist test</p>' }, authorType: 'agent', authorID: agent.id },
      ]);

      await interactionLoop.startInteraction(session.id, {
        agentPlugin: mockAgent,
        agent:       { id: agent.id, name: agent.name, encryptedPrivateKey: agent.encryptedPrivateKey },
        userMessage: 'persist test',
      });

      // Load frames from DB
      let { Frame } = models;
      let dbFrames  = await Frame.where.sessionID.EQ(session.id).all();

      let signedFrames = dbFrames.filter((f) => f.signature != null);
      assert.ok(signedFrames.length > 0, 'should have frames with signatures in the database');

      // Verify an agent frame signature from the database
      let agentDbFrame = dbFrames.find((f) => f.authorType === 'agent' && f.signature);
      if (agentDbFrame) {
        let content = agentDbFrame.getContent();
        let verified = keystore.verifyWithPublicKey(content, agentKeyPair.publicKey, agentDbFrame.signature);
        assert.equal(verified, true, 'database agent frame signature should verify');
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Pre-existing signature not overwritten
  // ---------------------------------------------------------------------------

  describe('pre-existing signature', () => {
    it('does not overwrite a signature already set on frame data', async () => {
      let interactionLoop = new InteractionLoop(context);
      let organization    = await models.Organization.create({ name: 'Pre-Sig Org' });
      let session         = await sessionManager.createSession(organization.id);

      // Directly test _createFrame with a pre-existing signature
      let frameManager = sessionManager.getFrameManager(session.id);
      await framePersistence.loadFramesInto(frameManager, session.id);

      let nextDbOrder = await framePersistence.getNextOrder(session.id);
      frameManager.syncOrderCounter(nextDbOrder - 1);

      let preExistingSignature = 'deadbeef1234';
      let frameData = {
        id:            `frm_${XID.next()}`,
        type:          'message',
        content:       { html: '<p>pre-signed</p>' },
        timestamp:     Date.now(),
        interactionID: 'int_pre_sig',
        authorType:    'agent',
        authorID:      'agt_pre_sig',
        signature:     preExistingSignature,
        hidden:        false,
        deleted:       false,
        processed:     false,
      };

      await interactionLoop._createFrame(session.id, frameData, frameManager, { authorType: 'agent' }, { agentPrivateKey: 'some-key' });

      assert.equal(frameData.signature, preExistingSignature, 'pre-existing signature should not be overwritten');
    });
  });
});
