'use strict';

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs     from 'node:fs';
import path   from 'node:path';
import os     from 'node:os';

import { KikxCore }              from '../../../src/core/kikx-core.mjs';
import { Keystore }              from '../../../src/core/crypto/keystore.mjs';
import { PermissionEngine }      from '../../../src/core/permissions/permission-engine.mjs';
import { PermissionService }     from '../../../src/core/permissions/permission-service.mjs';
import { setup }                 from '../../../src/core/internal-plugins/permissions/index.mjs';
import { FrameManager }          from '../../../src/shared/frame-manager/frame-manager.mjs';
import { PluginRegistry }        from '../../../src/core/plugin-loader/registry.mjs';

// =============================================================================
// C4 — PermissionPlugin Ed25519 Tests
// =============================================================================
// Verifies that the permission plugin:
//   - Reads frame.signature (not frame.content._signature)
//   - Verifies with author's Ed25519 public key when available
//   - Falls back to HMAC verification when no public key
//   - Logs warnings for invalid signatures
//   - Handles missing signatures gracefully
//   - Always passes routing to next plugin regardless of verification result
// =============================================================================

describe('PermissionPlugin Ed25519 (C4)', () => {
  let core;
  let context;
  let keystore;
  let permissionService;
  let models;
  let organization;
  let tempDir;

  before(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kikx-c4-perm-plugin-'));

    core = new KikxCore({ database: { filename: ':memory:' } });
    await core.start();
    context = core.getContext();
    models  = core.getModels();

    keystore = new Keystore({ devMode: true, devSeed: 'c4-perm-plugin-test' });
    keystore.initialize();
    keystore.loadServerMasterKey(tempDir);
    context.setProperty('keystore', keystore);

    let permissionEngine = new PermissionEngine(context);
    permissionService = new PermissionService({ context, permissionEngine, keystore });
    context.setProperty('permissionService', permissionService);
  });

  after(async () => {
    if (keystore)
      keystore.destroy();

    if (core && core.isStarted())
      await core.stop();

    if (tempDir && fs.existsSync(tempDir))
      fs.rmSync(tempDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    organization = await models.Organization.create({ name: 'C4 Test Org' });
  });

  // ---------------------------------------------------------------------------
  // Helper: capture the PluginClass from setup()
  // ---------------------------------------------------------------------------

  function getPluginClass() {
    let registry = new PluginRegistry();
    setup((cb) => cb({ registry, context }));
    let selectors = registry.getSelectors();
    return selectors.length > 0 ? selectors[0].PluginClass : null;
  }

  // ---------------------------------------------------------------------------
  // Helper: create a user with an Ed25519 key pair
  // ---------------------------------------------------------------------------

  async function createUserWithKeyPair(email) {
    let { publicKey, privateKey } = keystore.generateSigningKeyPair();
    let encryptedPrivateKey       = keystore.encryptActorPrivateKey(privateKey, `user-${email}`);

    let user = await models.User.create({
      organizationID: organization.id,
      email:          email,
      passwordHash:   'test-hash',
      publicKey,
      encryptedPrivateKey,
    });

    return { user, publicKey, privateKey };
  }

  // ---------------------------------------------------------------------------
  // Helper: create an agent with an Ed25519 key pair
  // ---------------------------------------------------------------------------

  async function createAgentWithKeyPair(name) {
    let { publicKey, privateKey } = keystore.generateSigningKeyPair();
    let encryptedPrivateKey       = keystore.encryptActorPrivateKey(privateKey, `agent-${name}`);

    let agent = await models.Agent.create({
      organizationID: organization.id,
      name:           name,
      pluginID:       'mock-agent',
      publicKey,
      encryptedPrivateKey,
    });

    return { agent, publicKey, privateKey };
  }

  // ---------------------------------------------------------------------------
  // frame.signature is used (not frame.content._signature)
  // ---------------------------------------------------------------------------

  describe('reads frame.signature', () => {
    it('should use frame.signature for verification, not frame.content._signature', async () => {
      let PluginClass = getPluginClass();

      let { agent, privateKey } = await createAgentWithKeyPair('test-sig-source');
      let content    = { toolName: 'shell:execute', arguments: { command: 'ls' } };
      let signature  = keystore.signWithPrivateKey(content, privateKey);

      let frameManager = new FrameManager({ history: true });

      // frame.signature has the valid Ed25519 signature
      frameManager.merge([{
        id:         'frm_ed25519_1',
        type:       'ToolCall',
        content,
        signature,
        authorType: 'agent',
        authorID:   agent.id,
      }], { authorType: 'agent', authorID: agent.id });

      let commit = frameManager.getLatestCommit();

      let warnings = [];
      let plugin = new PluginClass({
        commit,
        session:      { id: 'ses_1' },
        frameManager,
        logger: {
          warn:  (msg) => warnings.push(msg),
          error: console.error,
        },
      });

      let nextCalled = false;
      await plugin.process(
        async () => { nextCalled = true; },
        async () => {},
      );

      assert.equal(nextCalled, true);
      assert.equal(warnings.length, 0, 'Valid Ed25519 signature should not produce warnings');
    });

    it('should ignore frame.content._signature entirely', async () => {
      let PluginClass = getPluginClass();

      let frameManager = new FrameManager({ history: true });

      // Only _signature on content, no frame.signature
      frameManager.merge([{
        id:         'frm_legacy_sig',
        type:       'ToolCall',
        content:    { toolName: 'shell:execute', arguments: { command: 'ls' }, _signature: 'a'.repeat(64) },
        authorType: 'agent',
        authorID:   'agt_nonexistent',
      }], { authorType: 'agent', authorID: 'agt_nonexistent' });

      let commit = frameManager.getLatestCommit();

      let warnings = [];
      let plugin = new PluginClass({
        commit,
        session:      { id: 'ses_1' },
        frameManager,
        logger: {
          warn:  (msg) => warnings.push(msg),
          error: console.error,
        },
      });

      let nextCalled = false;
      await plugin.process(
        async () => { nextCalled = true; },
        async () => {},
      );

      assert.equal(nextCalled, true);
      // No warnings because frame.signature is null — the plugin should skip verification entirely
      assert.equal(warnings.length, 0, '_signature on content should be ignored');
    });
  });

  // ---------------------------------------------------------------------------
  // Ed25519 verification with author's public key
  // ---------------------------------------------------------------------------

  describe('Ed25519 verification', () => {
    it('should verify with user author public key', async () => {
      let PluginClass = getPluginClass();

      let { user, privateKey } = await createUserWithKeyPair('c4-user@test.com');
      let content    = { toolName: 'help:search', arguments: { query: 'test' } };
      let signature  = keystore.signWithPrivateKey(content, privateKey);

      let frameManager = new FrameManager({ history: true });

      frameManager.merge([{
        id:         'frm_user_ed25519',
        type:       'ToolCall',
        content,
        signature,
        authorType: 'user',
        authorID:   user.id,
      }], { authorType: 'user', authorID: user.id });

      let commit = frameManager.getLatestCommit();

      let warnings = [];
      let plugin = new PluginClass({
        commit,
        session:      { id: 'ses_2' },
        frameManager,
        logger: {
          warn:  (msg) => warnings.push(msg),
          error: console.error,
        },
      });

      let nextCalled = false;
      await plugin.process(
        async () => { nextCalled = true; },
        async () => {},
      );

      assert.equal(nextCalled, true);
      assert.equal(warnings.length, 0, 'Valid user Ed25519 signature should not produce warnings');
    });

    it('should verify with agent author public key', async () => {
      let PluginClass = getPluginClass();

      let { agent, privateKey } = await createAgentWithKeyPair('test-agent-ed');
      let content    = { toolName: 'websearch:search', arguments: { query: 'hello' } };
      let signature  = keystore.signWithPrivateKey(content, privateKey);

      let frameManager = new FrameManager({ history: true });

      frameManager.merge([{
        id:         'frm_agent_ed25519',
        type:       'ToolCall',
        content,
        signature,
        authorType: 'agent',
        authorID:   agent.id,
      }], { authorType: 'agent', authorID: agent.id });

      let commit = frameManager.getLatestCommit();

      let warnings = [];
      let plugin = new PluginClass({
        commit,
        session:      { id: 'ses_3' },
        frameManager,
        logger: {
          warn:  (msg) => warnings.push(msg),
          error: console.error,
        },
      });

      let nextCalled = false;
      await plugin.process(
        async () => { nextCalled = true; },
        async () => {},
      );

      assert.equal(nextCalled, true);
      assert.equal(warnings.length, 0, 'Valid agent Ed25519 signature should not produce warnings');
    });

    it('should warn on invalid Ed25519 signature', async () => {
      let PluginClass = getPluginClass();

      let { agent } = await createAgentWithKeyPair('test-bad-sig');

      let frameManager = new FrameManager({ history: true });

      frameManager.merge([{
        id:         'frm_bad_ed25519',
        type:       'ToolCall',
        content:    { toolName: 'shell:execute', arguments: { command: 'rm -rf /' } },
        signature:  'deadbeef'.repeat(8),  // invalid signature
        authorType: 'agent',
        authorID:   agent.id,
      }], { authorType: 'agent', authorID: agent.id });

      let commit = frameManager.getLatestCommit();

      let warnings = [];
      let plugin = new PluginClass({
        commit,
        session:      { id: 'ses_4' },
        frameManager,
        logger: {
          warn:  (msg) => warnings.push(msg),
          error: console.error,
        },
      });

      let nextCalled = false;
      await plugin.process(
        async () => { nextCalled = true; },
        async () => {},
      );

      assert.equal(nextCalled, true);
      assert.equal(warnings.length, 1);
      assert.ok(warnings[0].includes('invalid Ed25519 signature'));
      assert.ok(warnings[0].includes('frm_bad_ed25519'));
    });

    it('should detect tampered content (signature mismatch)', async () => {
      let PluginClass = getPluginClass();

      let { agent, privateKey } = await createAgentWithKeyPair('test-tamper');
      let originalContent = { toolName: 'shell:execute', arguments: { command: 'echo hello' } };
      let signature       = keystore.signWithPrivateKey(originalContent, privateKey);

      let frameManager = new FrameManager({ history: true });

      // Frame has different content than what was signed
      frameManager.merge([{
        id:         'frm_tampered',
        type:       'ToolCall',
        content:    { toolName: 'shell:execute', arguments: { command: 'rm -rf /' } },
        signature,
        authorType: 'agent',
        authorID:   agent.id,
      }], { authorType: 'agent', authorID: agent.id });

      let commit = frameManager.getLatestCommit();

      let warnings = [];
      let plugin = new PluginClass({
        commit,
        session:      { id: 'ses_5' },
        frameManager,
        logger: {
          warn:  (msg) => warnings.push(msg),
          error: console.error,
        },
      });

      let nextCalled = false;
      await plugin.process(
        async () => { nextCalled = true; },
        async () => {},
      );

      assert.equal(nextCalled, true);
      assert.equal(warnings.length, 1);
      assert.ok(warnings[0].includes('invalid Ed25519 signature'));
    });
  });

  // ---------------------------------------------------------------------------
  // Missing signature handling
  // ---------------------------------------------------------------------------

  describe('missing signature', () => {
    it('should not crash when frame.signature is null', async () => {
      let PluginClass = getPluginClass();

      let frameManager = new FrameManager({ history: true });

      frameManager.merge([{
        id:         'frm_no_sig',
        type:       'ToolCall',
        content:    { toolName: 'shell:execute', arguments: { command: 'ls' } },
        authorType: 'agent',
        authorID:   'agt_1',
      }], { authorType: 'agent', authorID: 'agt_1' });

      let commit = frameManager.getLatestCommit();

      let warnings = [];
      let plugin = new PluginClass({
        commit,
        session:      { id: 'ses_6' },
        frameManager,
        logger: {
          warn:  (msg) => warnings.push(msg),
          error: console.error,
        },
      });

      let nextCalled = false;
      await plugin.process(
        async () => { nextCalled = true; },
        async () => {},
      );

      assert.equal(nextCalled, true);
      assert.equal(warnings.length, 0, 'Missing signature should not produce warnings');
    });

    it('should not crash when frame.signature is undefined', async () => {
      let PluginClass = getPluginClass();

      let frameManager = new FrameManager({ history: true });

      // Explicitly don't set signature — it'll be undefined which Frame normalizes to null
      frameManager.merge([{
        id:         'frm_undef_sig',
        type:       'ToolCall',
        content:    { toolName: 'shell:execute', arguments: {} },
        authorType: 'agent',
        authorID:   'agt_2',
      }], { authorType: 'agent', authorID: 'agt_2' });

      let commit = frameManager.getLatestCommit();

      let plugin = new PluginClass({
        commit,
        session:      { id: 'ses_7' },
        frameManager,
      });

      let nextCalled = false;
      await plugin.process(
        async () => { nextCalled = true; },
        async () => {},
      );

      assert.equal(nextCalled, true);
    });
  });

  // ---------------------------------------------------------------------------
  // HMAC fallback (no author public key)
  // ---------------------------------------------------------------------------

  describe('HMAC fallback', () => {
    it('should fall back to HMAC when author has no public key', async () => {
      let PluginClass = getPluginClass();

      // Create agent without a public key
      let agent = await models.Agent.create({
        organizationID: organization.id,
        name:           'test-no-pubkey',
        pluginID:       'mock-agent',
      });

      let hmacSignature = permissionService.signApproval('approve', 'frm_hmac_fallback', 'shell:execute', { command: 'ls' }, 'ses_8');
      let frameManager  = new FrameManager({ history: true });

      frameManager.merge([{
        id:         'frm_hmac_fallback',
        type:       'ToolCall',
        content:    { toolName: 'shell:execute', arguments: { command: 'ls' } },
        signature:  hmacSignature,
        authorType: 'agent',
        authorID:   agent.id,
      }], { authorType: 'agent', authorID: agent.id });

      let commit = frameManager.getLatestCommit();

      let warnings = [];
      let plugin = new PluginClass({
        commit,
        session:      { id: 'ses_8' },
        frameManager,
        logger: {
          warn:  (msg) => warnings.push(msg),
          error: console.error,
        },
      });

      let nextCalled = false;
      await plugin.process(
        async () => { nextCalled = true; },
        async () => {},
      );

      assert.equal(nextCalled, true);
      assert.equal(warnings.length, 0, 'Valid HMAC fallback should not produce warnings');
    });

    it('should warn on invalid HMAC signature when no public key', async () => {
      let PluginClass = getPluginClass();

      // Create agent without a public key
      let agent = await models.Agent.create({
        organizationID: organization.id,
        name:           'test-bad-hmac',
        pluginID:       'mock-agent',
      });

      let frameManager = new FrameManager({ history: true });

      frameManager.merge([{
        id:         'frm_bad_hmac',
        type:       'ToolCall',
        content:    { toolName: 'shell:execute', arguments: { command: 'ls' } },
        signature:  'bogus-hmac-signature',
        authorType: 'agent',
        authorID:   agent.id,
      }], { authorType: 'agent', authorID: agent.id });

      let commit = frameManager.getLatestCommit();

      let warnings = [];
      let plugin = new PluginClass({
        commit,
        session:      { id: 'ses_9' },
        frameManager,
        logger: {
          warn:  (msg) => warnings.push(msg),
          error: console.error,
        },
      });

      let nextCalled = false;
      await plugin.process(
        async () => { nextCalled = true; },
        async () => {},
      );

      assert.equal(nextCalled, true);
      assert.equal(warnings.length, 1);
      assert.ok(warnings[0].includes('invalid signature on tool-call frame'));
      assert.ok(warnings[0].includes('frm_bad_hmac'));
    });

    it('should fall back to HMAC when author not found in database', async () => {
      let PluginClass = getPluginClass();

      let hmacSignature = permissionService.signApproval('approve', 'frm_missing_author', 'shell:execute', { command: 'pwd' }, 'ses_10');
      let frameManager  = new FrameManager({ history: true });

      frameManager.merge([{
        id:         'frm_missing_author',
        type:       'ToolCall',
        content:    { toolName: 'shell:execute', arguments: { command: 'pwd' } },
        signature:  hmacSignature,
        authorType: 'agent',
        authorID:   'agt_nonexistent_id',
      }], { authorType: 'agent', authorID: 'agt_nonexistent_id' });

      let commit = frameManager.getLatestCommit();

      let warnings = [];
      let plugin = new PluginClass({
        commit,
        session:      { id: 'ses_10' },
        frameManager,
        logger: {
          warn:  (msg) => warnings.push(msg),
          error: console.error,
        },
      });

      let nextCalled = false;
      await plugin.process(
        async () => { nextCalled = true; },
        async () => {},
      );

      assert.equal(nextCalled, true);
      assert.equal(warnings.length, 0, 'Valid HMAC with missing author should pass');
    });

    it('should fall back to HMAC when authorType is system', async () => {
      let PluginClass = getPluginClass();

      let hmacSignature = permissionService.signApproval('approve', 'frm_system_author', 'shell:execute', { command: 'date' }, 'ses_11');
      let frameManager  = new FrameManager({ history: true });

      frameManager.merge([{
        id:         'frm_system_author',
        type:       'ToolCall',
        content:    { toolName: 'shell:execute', arguments: { command: 'date' } },
        signature:  hmacSignature,
        authorType: 'system',
        authorID:   null,
      }], { authorType: 'system', authorID: null });

      let commit = frameManager.getLatestCommit();

      let warnings = [];
      let plugin = new PluginClass({
        commit,
        session:      { id: 'ses_11' },
        frameManager,
        logger: {
          warn:  (msg) => warnings.push(msg),
          error: console.error,
        },
      });

      let nextCalled = false;
      await plugin.process(
        async () => { nextCalled = true; },
        async () => {},
      );

      assert.equal(nextCalled, true);
      assert.equal(warnings.length, 0, 'System author with valid HMAC should pass');
    });
  });

  // ---------------------------------------------------------------------------
  // Always passes to next plugin
  // ---------------------------------------------------------------------------

  describe('routing continuity', () => {
    it('should call next() even when Ed25519 verification fails', async () => {
      let PluginClass = getPluginClass();

      let { agent } = await createAgentWithKeyPair('test-next-on-fail');

      let frameManager = new FrameManager({ history: true });

      frameManager.merge([{
        id:         'frm_fail_next',
        type:       'ToolCall',
        content:    { toolName: 'shell:execute', arguments: { command: 'ls' } },
        signature:  'invalid-signature-hex',
        authorType: 'agent',
        authorID:   agent.id,
      }], { authorType: 'agent', authorID: agent.id });

      let commit = frameManager.getLatestCommit();

      let warnings = [];
      let plugin = new PluginClass({
        commit,
        session:      { id: 'ses_12' },
        frameManager,
        logger: {
          warn:  (msg) => warnings.push(msg),
          error: console.error,
        },
      });

      let nextCalled = false;
      await plugin.process(
        async () => { nextCalled = true; },
        async () => {},
      );

      assert.equal(nextCalled, true, 'next() must be called even on verification failure');
      assert.ok(warnings.length > 0, 'Should have logged a warning');
    });

    it('should call next() even when HMAC verification fails', async () => {
      let PluginClass = getPluginClass();

      let frameManager = new FrameManager({ history: true });

      frameManager.merge([{
        id:         'frm_hmac_fail_next',
        type:       'ToolCall',
        content:    { toolName: 'shell:execute', arguments: { command: 'ls' } },
        signature:  'not-a-valid-hmac',
        authorType: 'system',
        authorID:   null,
      }], { authorType: 'system', authorID: null });

      let commit = frameManager.getLatestCommit();

      let warnings = [];
      let plugin = new PluginClass({
        commit,
        session:      { id: 'ses_13' },
        frameManager,
        logger: {
          warn:  (msg) => warnings.push(msg),
          error: console.error,
        },
      });

      let nextCalled = false;
      await plugin.process(
        async () => { nextCalled = true; },
        async () => {},
      );

      assert.equal(nextCalled, true, 'next() must be called even on HMAC failure');
      assert.ok(warnings.length > 0, 'Should have logged a warning');
    });

    it('should call next() with no changes in commit', async () => {
      let PluginClass = getPluginClass();

      let plugin = new PluginClass({
        commit:  { changes: [] },
        session: { id: 'ses_14' },
      });

      let nextCalled = false;
      await plugin.process(
        async () => { nextCalled = true; },
        async () => {},
      );

      assert.equal(nextCalled, true);
    });

    it('should call next() with null commit', async () => {
      let PluginClass = getPluginClass();

      let plugin = new PluginClass({
        commit:  null,
        session: { id: 'ses_15' },
      });

      let nextCalled = false;
      await plugin.process(
        async () => { nextCalled = true; },
        async () => {},
      );

      assert.equal(nextCalled, true);
    });

    it('should call next() when commit has no changes property', async () => {
      let PluginClass = getPluginClass();

      let plugin = new PluginClass({
        commit:  {},
        session: { id: 'ses_16' },
      });

      let nextCalled = false;
      await plugin.process(
        async () => { nextCalled = true; },
        async () => {},
      );

      assert.equal(nextCalled, true);
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  describe('edge cases', () => {
    it('should skip non-tool-call frames', async () => {
      let PluginClass = getPluginClass();

      let frameManager = new FrameManager({ history: true });

      frameManager.merge([{
        id:         'frm_text_frame',
        type:       'text',
        content:    { text: 'hello world' },
        signature:  'some-signature',
        authorType: 'user',
        authorID:   'usr_1',
      }], { authorType: 'user', authorID: 'usr_1' });

      let commit = frameManager.getLatestCommit();

      let warnings = [];
      let plugin = new PluginClass({
        commit,
        session:      { id: 'ses_17' },
        frameManager,
        logger: {
          warn:  (msg) => warnings.push(msg),
          error: console.error,
        },
      });

      let nextCalled = false;
      await plugin.process(
        async () => { nextCalled = true; },
        async () => {},
      );

      assert.equal(nextCalled, true);
      assert.equal(warnings.length, 0, 'Non-tool-call frames should be skipped');
    });

    it('should handle multiple tool-call frames in a single commit', async () => {
      let PluginClass = getPluginClass();

      let { agent, privateKey } = await createAgentWithKeyPair('test-multi-frame');

      let content1   = { toolName: 'shell:execute', arguments: { command: 'ls' } };
      let content2   = { toolName: 'help:search', arguments: { query: 'test' } };
      let signature1 = keystore.signWithPrivateKey(content1, privateKey);
      // Second frame has invalid signature
      let signature2 = 'badbad'.repeat(11);

      let frameManager = new FrameManager({ history: true });

      frameManager.merge([
        {
          id:         'frm_multi_1',
          type:       'ToolCall',
          content:    content1,
          signature:  signature1,
          authorType: 'agent',
          authorID:   agent.id,
        },
        {
          id:         'frm_multi_2',
          type:       'ToolCall',
          content:    content2,
          signature:  signature2,
          authorType: 'agent',
          authorID:   agent.id,
        },
      ], { authorType: 'agent', authorID: agent.id });

      let commit = frameManager.getLatestCommit();

      let warnings = [];
      let plugin = new PluginClass({
        commit,
        session:      { id: 'ses_18' },
        frameManager,
        logger: {
          warn:  (msg) => warnings.push(msg),
          error: console.error,
        },
      });

      let nextCalled = false;
      await plugin.process(
        async () => { nextCalled = true; },
        async () => {},
      );

      assert.equal(nextCalled, true);
      // First frame valid, second invalid
      assert.equal(warnings.length, 1);
      assert.ok(warnings[0].includes('frm_multi_2'));
    });

    it('should handle user with no public key (null publicKey field)', async () => {
      let PluginClass = getPluginClass();

      // Create user without public key
      let user = await models.User.create({
        organizationID: organization.id,
        email:          'c4-no-key@test.com',
        passwordHash:   'test-hash',
      });

      let hmacSignature = permissionService.signApproval('approve', 'frm_user_no_key', 'shell:execute', { command: 'ls' }, 'ses_19');
      let frameManager  = new FrameManager({ history: true });

      frameManager.merge([{
        id:         'frm_user_no_key',
        type:       'ToolCall',
        content:    { toolName: 'shell:execute', arguments: { command: 'ls' } },
        signature:  hmacSignature,
        authorType: 'user',
        authorID:   user.id,
      }], { authorType: 'user', authorID: user.id });

      let commit = frameManager.getLatestCommit();

      let warnings = [];
      let plugin = new PluginClass({
        commit,
        session:      { id: 'ses_19' },
        frameManager,
        logger: {
          warn:  (msg) => warnings.push(msg),
          error: console.error,
        },
      });

      let nextCalled = false;
      await plugin.process(
        async () => { nextCalled = true; },
        async () => {},
      );

      assert.equal(nextCalled, true);
      assert.equal(warnings.length, 0, 'User without public key should fall back to HMAC');
    });

    it('should handle frameManager being null', async () => {
      let PluginClass = getPluginClass();

      let plugin = new PluginClass({
        commit:       { changes: [{ frameID: 'frm_x' }] },
        session:      { id: 'ses_20' },
        frameManager: null,
      });

      let nextCalled = false;
      await plugin.process(
        async () => { nextCalled = true; },
        async () => {},
      );

      assert.equal(nextCalled, true);
    });

    it('should handle frame not found in frameManager (getHead returns null)', async () => {
      let PluginClass = getPluginClass();

      let frameManager = new FrameManager({ history: true });
      // frameManager is empty — getHead will return undefined/null

      let plugin = new PluginClass({
        commit:  { changes: [{ frameID: 'frm_phantom' }] },
        session: { id: 'ses_21' },
        frameManager,
      });

      let nextCalled = false;
      await plugin.process(
        async () => { nextCalled = true; },
        async () => {},
      );

      assert.equal(nextCalled, true);
    });
  });
});
