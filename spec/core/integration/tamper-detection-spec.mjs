'use strict';

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs     from 'node:fs';
import os     from 'node:os';
import path   from 'node:path';

import { createKikxCore }       from '../../../src/core/index.mjs';
import { Keystore }             from '../../../src/core/crypto/keystore.mjs';
import { signFrameContent }     from '../../../src/core/crypto/frame-signing.mjs';
import { ValueStoreService }    from '../../../src/core/lib/value-store-service.mjs';

// =============================================================================
// Tamper Detection — Integration Tests
// =============================================================================
// End-to-end tests that verify the Ed25519 signing system detects tampering
// across all signed components:
//   1. Frame authorship signatures
//   2. Permission rule fingerprints
//   3. ValueStore signed values
//   4. User settings signatures
//   5. Cross-component integration
//
// Each scenario follows the same pattern:
//   - Create data with a valid Ed25519 signature
//   - Verify the signature passes verification
//   - Tamper with the data after signing
//   - Verify the signature NOW FAILS verification
// =============================================================================

describe('Tamper Detection — Integration', () => {
  let core;
  let models;
  let keystore;
  let tempDir;
  let organization;
  let publicKey;
  let privateKey;

  before(async () => {
    core = createKikxCore();
    await core.start();
    models = core.getModels();

    // Create a unique temp dir for keystore files
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kikx-tamper-detect-'));

    // Set up keystore with SMK and system key pair
    keystore = new Keystore({ devMode: true, devSeed: 'tamper-detection-integration' });
    keystore.initialize();
    keystore.loadServerMasterKey(tempDir);
    keystore.loadSystemKeyPair(tempDir);

    let context = core.getContext();
    context.setProperty('keystore', keystore);

    // Generate a reusable Ed25519 key pair for tests
    let keys  = keystore.generateSigningKeyPair();
    publicKey  = keys.publicKey;
    privateKey = keys.privateKey;
  });

  after(async () => {
    if (keystore)
      keystore.destroy();

    if (core && core.isStarted())
      await core.stop();

    // Clean up temp dir
    if (tempDir)
      fs.rmSync(tempDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    organization = await models.Organization.create({ name: 'Tamper Test Org' });
  });

  // ---------------------------------------------------------------------------
  // 1. Frame Signature Tamper Detection
  // ---------------------------------------------------------------------------

  describe('Frame Signature Tamper Detection', () => {
    it('should verify a valid frame signature with the agent public key', () => {
      let content   = { role: 'assistant', text: 'Hello, I am the agent.' };
      let signature = signFrameContent(keystore, content, 'agent', privateKey);

      assert.ok(signature, 'signFrameContent should return a signature');
      assert.equal(typeof signature, 'string');
      assert.ok(signature.length > 0);

      let valid = keystore.verifyWithPublicKey(content, publicKey, signature);
      assert.equal(valid, true, 'signature should verify against the original content');
    });

    it('should detect tampering when frame content is modified after signing', () => {
      let content   = { role: 'assistant', text: 'Original response from agent.' };
      let signature = signFrameContent(keystore, content, 'agent', privateKey);

      // Verify untampered content passes
      let validBefore = keystore.verifyWithPublicKey(content, publicKey, signature);
      assert.equal(validBefore, true);

      // Tamper: modify the text field
      let tamperedContent = { role: 'assistant', text: 'TAMPERED: Injected malicious response.' };

      // Verify tampered content FAILS
      let validAfter = keystore.verifyWithPublicKey(tamperedContent, publicKey, signature);
      assert.equal(validAfter, false, 'tampered content should fail verification');
    });

    it('should detect tampering when frame role is changed after signing', () => {
      let content   = { role: 'assistant', text: 'Agent message.' };
      let signature = signFrameContent(keystore, content, 'agent', privateKey);

      // Tamper: change the role to impersonate a user
      let tamperedContent = { role: 'user', text: 'Agent message.' };

      let valid = keystore.verifyWithPublicKey(tamperedContent, publicKey, signature);
      assert.equal(valid, false, 'role change should be detected as tampering');
    });

    it('should detect tampering when additional fields are injected after signing', () => {
      let content   = { role: 'assistant', text: 'Safe response.' };
      let signature = signFrameContent(keystore, content, 'agent', privateKey);

      // Tamper: inject an additional field
      let tamperedContent = { role: 'assistant', text: 'Safe response.', toolCalls: [{ name: 'shell:execute' }] };

      let valid = keystore.verifyWithPublicKey(tamperedContent, publicKey, signature);
      assert.equal(valid, false, 'injected fields should be detected as tampering');
    });

    it('should detect tampering when the signature itself is corrupted', () => {
      let content   = { role: 'assistant', text: 'Signed content.' };
      let signature = signFrameContent(keystore, content, 'agent', privateKey);

      // Corrupt the signature by changing a few characters
      let corruptedSig = 'ff' + signature.slice(2);

      let valid = keystore.verifyWithPublicKey(content, publicKey, corruptedSig);
      assert.equal(valid, false, 'corrupted signature should fail verification');
    });

    it('should detect tampering when signature is truncated', () => {
      let content   = { role: 'assistant', text: 'Truncation test.' };
      let signature = signFrameContent(keystore, content, 'agent', privateKey);

      // Truncate the signature to half its length
      let truncated = signature.slice(0, Math.floor(signature.length / 2));

      let valid = keystore.verifyWithPublicKey(content, publicKey, truncated);
      assert.equal(valid, false, 'truncated signature should fail verification');
    });

    it('should detect tampering when a completely bogus signature is provided', () => {
      let content = { role: 'assistant', text: 'Content with bogus sig.' };

      let valid = keystore.verifyWithPublicKey(content, publicKey, 'deadbeef0011223344556677');
      assert.equal(valid, false, 'bogus signature should fail verification');
    });

    it('should not treat an unsigned frame as tampered (it is just unsigned)', () => {
      let content   = { role: 'assistant', text: 'Unsigned message.' };
      let signature = signFrameContent(keystore, content, 'agent', null);

      // signFrameContent returns null when no private key is available
      assert.equal(signature, null, 'no private key means no signature (not an error)');
    });

    it('should fail verification when the wrong public key is used', () => {
      let content   = { role: 'assistant', text: 'Signed with key A.' };
      let signature = signFrameContent(keystore, content, 'agent', privateKey);

      // Generate a different key pair
      let otherKeys = keystore.generateSigningKeyPair();

      let valid = keystore.verifyWithPublicKey(content, otherKeys.publicKey, signature);
      assert.equal(valid, false, 'wrong public key should fail verification');
    });

    it('should verify system-signed frame content with system public key', () => {
      let content   = { role: 'system', text: 'System announcement.' };
      let signature = signFrameContent(keystore, content, 'system', null);

      assert.ok(signature, 'system signing should produce a signature');

      let systemPubKey = keystore.getSystemPublicKey();
      let valid        = keystore.systemVerify(content, signature);
      assert.equal(valid, true, 'system signature should verify with system public key');

      // Tamper with the content
      let tampered = { role: 'system', text: 'TAMPERED system announcement.' };
      let invalid  = keystore.systemVerify(tampered, signature);
      assert.equal(invalid, false, 'tampered system content should fail verification');
    });

    it('should persist and verify frame signatures through database round-trip', async () => {
      let session = await models.Session.create({
        organizationID: organization.id,
        name:           'Frame Sig Test Session',
      });

      let content   = { role: 'assistant', text: 'Database round-trip test.' };
      let signature = signFrameContent(keystore, content, 'agent', privateKey);

      // Store the frame with signature in DB
      let frame = await models.Frame.create({
        sessionID:     session.id,
        interactionID: 'int_tamper_test_001',
        type:          'message',
        content:       JSON.stringify(content),
        order:         1,
        timestamp:     Date.now(),
        signature:     signature,
      });

      // Load it back from DB
      let loaded = await models.Frame.where.id.EQ(frame.id).first();

      // Verify the loaded signature still matches the original content
      let parsedContent = JSON.parse(loaded.content);
      let valid         = keystore.verifyWithPublicKey(parsedContent, publicKey, loaded.signature);
      assert.equal(valid, true, 'signature should survive database round-trip');

      // Now tamper with the loaded content directly in DB
      loaded.content = JSON.stringify({ role: 'assistant', text: 'TAMPERED IN DB.' });
      await loaded.save();

      // Re-load and verify tampering is detected
      let reloaded        = await models.Frame.where.id.EQ(frame.id).first();
      let tamperedContent = JSON.parse(reloaded.content);
      let invalid         = keystore.verifyWithPublicKey(tamperedContent, publicKey, reloaded.signature);
      assert.equal(invalid, false, 'DB-level tampering should be detected');
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Permission Rule Fingerprint Tamper Detection
  // ---------------------------------------------------------------------------

  describe('Permission Rule Fingerprint Tamper Detection', () => {
    let engine;

    beforeEach(() => {
      engine = core.getPermissionEngine();
    });

    it('should create a rule with a valid Ed25519 fingerprint', async () => {
      let rule = await engine.createRule({
        organizationID: organization.id,
        featureName:    'shell:execute',
        effect:         'allow',
        createdBy:      'usr_tamper_test',
        privateKeyPEM:  privateKey,
      });

      assert.ok(rule.fingerprint, 'rule should have a fingerprint');
      assert.equal(rule.fingerprint.length, 128, 'Ed25519 sig should be 128 hex chars');
    });

    it('should accept the rule when fingerprint verification passes', async () => {
      await engine.createRule({
        organizationID: organization.id,
        featureName:    'shell:execute',
        effect:         'allow',
        createdBy:      'usr_tamper_test',
        privateKeyPEM:  privateKey,
      });

      let result = await engine.checkPermission('shell:execute', {}, {
        organizationID:    organization.id,
        verifyFingerprint: true,
        publicKeyPEM:      publicKey,
      });

      assert.equal(result, false, 'valid fingerprint should let allow rule through');
    });

    it('should detect tampering when rule effect is changed in the database', async () => {
      let rule = await engine.createRule({
        organizationID: organization.id,
        featureName:    'shell:execute',
        effect:         'allow',
        createdBy:      'usr_tamper_test',
        privateKeyPEM:  privateKey,
      });

      // Tamper: change effect from 'allow' to 'deny' directly in DB
      let { PermissionRule } = models;
      let loaded             = await PermissionRule.where.id.EQ(rule.id).first();
      loaded.effect          = 'deny';
      await loaded.save();

      // The fingerprint was signed over "allow", so verifying "deny" should fail.
      // The tampered rule is filtered out, leaving no matching rules -> default deny.
      let result = await engine.checkPermission('shell:execute', {}, {
        organizationID:    organization.id,
        verifyFingerprint: true,
        publicKeyPEM:      publicKey,
      });

      assert.equal(result, true, 'tampered rule effect should be detected');
    });

    it('should detect tampering when rule featureName is changed in the database', async () => {
      let rule = await engine.createRule({
        organizationID: organization.id,
        featureName:    'shell:execute',
        effect:         'allow',
        createdBy:      'usr_tamper_test',
        privateKeyPEM:  privateKey,
      });

      // Tamper: change featureName in DB
      let { PermissionRule } = models;
      let loaded             = await PermissionRule.where.id.EQ(rule.id).first();
      loaded.featureName     = 'websearch:fetch';
      await loaded.save();

      // Query the original feature — no rules exist for it now
      let result = await engine.checkPermission('shell:execute', {}, {
        organizationID:    organization.id,
        verifyFingerprint: true,
        publicKeyPEM:      publicKey,
      });

      assert.equal(result, true, 'no rules match the original feature after tampering');

      // Query the tampered feature — fingerprint data won't match
      let resultTampered = await engine.checkPermission('websearch:fetch', {}, {
        organizationID:    organization.id,
        verifyFingerprint: true,
        publicKeyPEM:      publicKey,
      });

      assert.equal(resultTampered, true, 'tampered featureName should fail fingerprint check');
    });

    it('should detect tampering when rule scope is changed in the database', async () => {
      let rule = await engine.createRule({
        organizationID: organization.id,
        featureName:    'shell:execute',
        effect:         'allow',
        scope:          'global',
        createdBy:      'usr_tamper_test',
        privateKeyPEM:  privateKey,
      });

      // Tamper: change scope from 'global' to 'session'
      let { PermissionRule } = models;
      let loaded             = await PermissionRule.where.id.EQ(rule.id).first();
      loaded.scope           = 'session';
      await loaded.save();

      // Fingerprint was computed with "global", but rule now has "session"
      let result = await engine.checkPermission('shell:execute', {}, {
        organizationID:    organization.id,
        scope:             'session',
        scopeID:           null,
        verifyFingerprint: true,
        publicKeyPEM:      publicKey,
      });

      assert.equal(result, true, 'tampered scope should be detected via fingerprint mismatch');
    });

    it('should detect tampering when the fingerprint signature is directly corrupted', async () => {
      let rule = await engine.createRule({
        organizationID: organization.id,
        featureName:    'shell:execute',
        effect:         'allow',
        createdBy:      'usr_tamper_test',
        privateKeyPEM:  privateKey,
      });

      // Tamper: corrupt the fingerprint itself
      let { PermissionRule } = models;
      let loaded             = await PermissionRule.where.id.EQ(rule.id).first();
      loaded.fingerprint     = 'ff'.repeat(64); // Valid hex but wrong signature
      await loaded.save();

      let result = await engine.checkPermission('shell:execute', {}, {
        organizationID:    organization.id,
        verifyFingerprint: true,
        publicKeyPEM:      publicKey,
      });

      assert.equal(result, true, 'corrupted fingerprint should fail verification');
    });

    it('should filter out rule without fingerprint when verification is enabled', async () => {
      // Create rule WITHOUT any signing key
      await engine.createRule({
        organizationID: organization.id,
        featureName:    'shell:execute',
        effect:         'allow',
        createdBy:      'usr_no_fingerprint',
        // No privateKeyPEM, no userKey
      });

      let result = await engine.checkPermission('shell:execute', {}, {
        organizationID:    organization.id,
        verifyFingerprint: true,
        publicKeyPEM:      publicKey,
      });

      assert.equal(result, true, 'unsigned rules should be filtered out when verification is enabled');
    });

    it('should accept unsigned rule when verification is NOT enabled', async () => {
      await engine.createRule({
        organizationID: organization.id,
        featureName:    'shell:execute',
        effect:         'allow',
        createdBy:      'usr_no_verify',
      });

      let result = await engine.checkPermission('shell:execute', {}, {
        organizationID:    organization.id,
        verifyFingerprint: false,
      });

      assert.equal(result, false, 'unsigned rule should pass when verification is disabled');
    });
  });

  // ---------------------------------------------------------------------------
  // 3. ValueStore Signed Value Tamper Detection
  // ---------------------------------------------------------------------------

  describe('ValueStore Signed Value Tamper Detection', () => {
    let service;

    beforeEach(() => {
      service = new ValueStoreService({ context: core.getContext() });
    });

    it('should store and retrieve a signed value successfully', async () => {
      await service.setSigned('Agent', 'agt_vs_tamper_1', 'config', 'secret', 'classified-data', privateKey, publicKey, {
        organizationID: organization.id,
      });

      let result = await service.getVerified('Agent', 'agt_vs_tamper_1', 'config', 'secret', publicKey);
      assert.equal(result.value, 'classified-data', 'verified retrieval of signed value should work');
      assert.equal(result.signed, true);
      assert.equal(result.verified, true);
    });

    it('should detect tampering when the stored value is modified in the database', async () => {
      await service.setSigned('Agent', 'agt_vs_tamper_2', 'config', 'level', 'high', privateKey, publicKey, {
        organizationID: organization.id,
      });

      // Tamper: modify the value directly in DB
      let { ValueStore } = models;
      let entry = await ValueStore
        .where.ownerType.EQ('Agent')
        .ownerID.EQ('agt_vs_tamper_2')
        .namespace.EQ('config')
        .key.EQ('level')
        .first();

      entry.value = JSON.stringify('low');
      await entry.save();

      // Verify: getVerified should detect tampering
      let result = await service.getVerified('Agent', 'agt_vs_tamper_2', 'config', 'level', publicKey);
      assert.equal(result.signed, true);
      assert.equal(result.verified, false, 'tampered value should fail verification');
    });

    it('should detect tampering when the signature is modified in the database', async () => {
      await service.setSigned('Agent', 'agt_vs_tamper_3', 'config', 'mode', 'safe', privateKey, publicKey, {
        organizationID: organization.id,
      });

      // Tamper: modify the signature directly in DB
      let { ValueStore } = models;
      let entry = await ValueStore
        .where.ownerType.EQ('Agent')
        .ownerID.EQ('agt_vs_tamper_3')
        .namespace.EQ('config')
        .key.EQ('mode')
        .first();

      entry.signature = 'deadcafe'.repeat(16);
      await entry.save();

      let result = await service.getVerified('Agent', 'agt_vs_tamper_3', 'config', 'mode', publicKey);
      assert.equal(result.signed, true);
      assert.equal(result.verified, false, 'tampered signature should fail verification');
    });

    it('should detect tampering when both value and signature are changed', async () => {
      await service.setSigned('Agent', 'agt_vs_tamper_4', 'config', 'policy', 'strict', privateKey, publicKey, {
        organizationID: organization.id,
      });

      // Tamper: change both value and signature
      let { ValueStore } = models;
      let entry = await ValueStore
        .where.ownerType.EQ('Agent')
        .ownerID.EQ('agt_vs_tamper_4')
        .namespace.EQ('config')
        .key.EQ('policy')
        .first();

      entry.value     = JSON.stringify('permissive');
      entry.signature = 'abcd1234'.repeat(16);
      await entry.save();

      let result = await service.getVerified('Agent', 'agt_vs_tamper_4', 'config', 'policy', publicKey);
      assert.equal(result.signed, true);
      assert.equal(result.verified, false, 'dual tampering should fail verification');
    });

    it('should return null from getVerified for unsigned values set via set()', async () => {
      // Create an unsigned value with regular set()
      await service.set('Agent', 'agt_vs_unsigned', 'config', 'theme', 'dark', {
        organizationID: organization.id,
      });

      // Regular get() should work
      let valueGet = await service.get('Agent', 'agt_vs_unsigned', 'config', 'theme');
      assert.equal(valueGet, 'dark', 'regular get() should return the value');

      // getVerified() should return signed: false for unsigned entry
      let resultVerified = await service.getVerified('Agent', 'agt_vs_unsigned', 'config', 'theme', publicKey);
      assert.equal(resultVerified.signed, false, 'unsigned entry should have signed: false');
      assert.equal(resultVerified.value, 'dark');
    });

    it('should detect tampering with wrong public key', async () => {
      await service.setSigned('Agent', 'agt_vs_tamper_5', 'config', 'data', 'important', privateKey, publicKey, {
        organizationID: organization.id,
      });

      // Generate a different key pair
      let otherKeys = keystore.generateSigningKeyPair();

      let result = await service.getVerified('Agent', 'agt_vs_tamper_5', 'config', 'data', otherKeys.publicKey);
      assert.equal(result.signed, true);
      assert.equal(result.verified, false, 'wrong public key should cause verification to fail');
    });

    it('should detect re-signing attack (value re-signed with different key)', async () => {
      let otherKeys = keystore.generateSigningKeyPair();

      // Original: signed with the main key pair
      await service.setSigned('Agent', 'agt_vs_tamper_6', 'config', 'access', 'admin', privateKey, publicKey, {
        organizationID: organization.id,
      });

      // Attacker re-signs with their own key
      let { ValueStore } = models;
      let entry = await ValueStore
        .where.ownerType.EQ('Agent')
        .ownerID.EQ('agt_vs_tamper_6')
        .namespace.EQ('config')
        .key.EQ('access')
        .first();

      let attackerSig = keystore.signWithPrivateKey(entry.value, otherKeys.privateKey);
      entry.signature = attackerSig;
      await entry.save();

      // Verification with original public key should fail
      let result = await service.getVerified('Agent', 'agt_vs_tamper_6', 'config', 'access', publicKey);
      assert.equal(result.signed, true);
      assert.equal(result.verified, false, 'value re-signed with attacker key should fail original key verification');

      // Verification with attacker's public key WOULD pass (but legitimate verifier uses original key)
      // Note: attacker re-signed just the raw value, not the full payload. So even with their
      // key it will fail because the signing payload includes composite key components.
      let attackerResult = await service.getVerified('Agent', 'agt_vs_tamper_6', 'config', 'access', otherKeys.publicKey);
      assert.equal(attackerResult.signed, true);
      assert.equal(attackerResult.verified, false, 'attacker raw-value signature fails payload verification');
    });

    it('should handle object values being tampered', async () => {
      let originalObj = { permissions: ['read', 'write'], level: 5 };

      await service.setSigned('Agent', 'agt_vs_tamper_7', 'config', 'perms', originalObj, privateKey, publicKey, {
        organizationID: organization.id,
      });

      // Verify original
      let result = await service.getVerified('Agent', 'agt_vs_tamper_7', 'config', 'perms', publicKey);
      assert.deepEqual(result.value, originalObj, 'original object should verify');
      assert.equal(result.signed, true);
      assert.equal(result.verified, true);

      // Tamper: escalate permissions
      let { ValueStore } = models;
      let entry = await ValueStore
        .where.ownerType.EQ('Agent')
        .ownerID.EQ('agt_vs_tamper_7')
        .namespace.EQ('config')
        .key.EQ('perms')
        .first();

      entry.value = JSON.stringify({ permissions: ['read', 'write', 'admin'], level: 10 });
      await entry.save();

      let tampered = await service.getVerified('Agent', 'agt_vs_tamper_7', 'config', 'perms', publicKey);
      assert.equal(tampered.signed, true);
      assert.equal(tampered.verified, false, 'escalated permission object should fail verification');
    });
  });

  // ---------------------------------------------------------------------------
  // 4. User Settings Tamper Detection
  // ---------------------------------------------------------------------------

  describe('User Settings Tamper Detection', () => {
    let user;

    beforeEach(async () => {
      user = await models.User.create({
        organizationID: organization.id,
        email:          `tamper-test-${Date.now()}@example.com`,
        publicKey,
      });
    });

    it('should store and verify riskLevel setting with valid signature', async () => {
      await user.updateSettings({ riskLevel: 'strict' }, keystore, privateKey);

      let settings = await user.getVerifiedSettings(keystore, publicKey);
      assert.ok(settings, 'verified settings should not be null');
      assert.equal(settings.riskLevel, 'strict');
    });

    it('should detect tampering when riskLevel value is changed in the database', async () => {
      await user.updateSettings({ riskLevel: 'strict' }, keystore, privateKey);

      // Tamper: change riskLevel from 'strict' to 'permissive' in DB
      let entry = await models.ValueStore
        .where.ownerType.EQ('User')
        .ownerID.EQ(user.id)
        .namespace.EQ('config')
        .key.EQ('riskLevel')
        .first();

      entry.value = JSON.stringify('permissive');
      await entry.save();

      // getVerifiedSettings should detect the tampering and return null
      let settings = await user.getVerifiedSettings(keystore, publicKey);
      assert.equal(settings, null, 'tampered riskLevel should cause getVerifiedSettings to return null');
    });

    it('should detect tampering when riskLevel signature is corrupted in the database', async () => {
      await user.updateSettings({ riskLevel: 'strict' }, keystore, privateKey);

      // Tamper: corrupt the signature
      let entry = await models.ValueStore
        .where.ownerType.EQ('User')
        .ownerID.EQ(user.id)
        .namespace.EQ('config')
        .key.EQ('riskLevel')
        .first();

      entry.signature = 'badc0ffee'.repeat(14).slice(0, 128);
      await entry.save();

      let settings = await user.getVerifiedSettings(keystore, publicKey);
      assert.equal(settings, null, 'corrupted signature should cause verification failure');
    });

    it('should detect tampering when riskLevel signature is removed from the database', async () => {
      await user.updateSettings({ riskLevel: 'strict' }, keystore, privateKey);

      // Tamper: remove the signature entirely
      let entry = await models.ValueStore
        .where.ownerType.EQ('User')
        .ownerID.EQ(user.id)
        .namespace.EQ('config')
        .key.EQ('riskLevel')
        .first();

      entry.signature = null;
      await entry.save();

      let settings = await user.getVerifiedSettings(keystore, publicKey);
      assert.equal(settings, null, 'missing signature for signed key should cause verification failure');
    });

    it('should detect tampering when verified with the wrong public key', async () => {
      await user.updateSettings({ riskLevel: 'strict' }, keystore, privateKey);

      let otherKeys = keystore.generateSigningKeyPair();

      let settings = await user.getVerifiedSettings(keystore, otherKeys.publicKey);
      assert.equal(settings, null, 'wrong public key should cause verification failure');
    });

    it('should allow unsigned settings to pass through getSettings() without verification', async () => {
      // Store a non-signed setting
      await user.updateSettings({ theme: 'dark' }, keystore, privateKey);

      // getSettings() does not verify signatures — it just reads values
      let settings = await user.getSettings();
      assert.equal(settings.theme, 'dark', 'unsigned setting should be readable via getSettings');
    });

    it('should not fail getVerifiedSettings for non-signed keys even when value is tampered', async () => {
      // Store both a signed key (riskLevel) and a non-signed key (theme)
      await user.updateSettings({
        riskLevel: 'strict',
        theme:     'dark',
      }, keystore, privateKey);

      // Tamper: change the non-signed key (theme) directly in DB
      let entry = await models.ValueStore
        .where.ownerType.EQ('User')
        .ownerID.EQ(user.id)
        .namespace.EQ('config')
        .key.EQ('theme')
        .first();

      entry.value = JSON.stringify('light');
      await entry.save();

      // getVerifiedSettings should still pass because 'theme' is not in SIGNED_KEYS
      let settings = await user.getVerifiedSettings(keystore, publicKey);
      assert.ok(settings, 'tampering with non-signed key should not invalidate settings');
      assert.equal(settings.riskLevel, 'strict', 'signed setting should still be correct');
      assert.equal(settings.theme, 'light', 'non-signed setting returns the tampered value');
    });

    it('should detect tampering even when only the signed key is compromised among multiple settings', async () => {
      await user.updateSettings({
        riskLevel: 'strict',
        theme:     'dark',
        language:  'en',
      }, keystore, privateKey);

      // Tamper: change only riskLevel (a signed key)
      let entry = await models.ValueStore
        .where.ownerType.EQ('User')
        .ownerID.EQ(user.id)
        .namespace.EQ('config')
        .key.EQ('riskLevel')
        .first();

      entry.value = JSON.stringify('permissive');
      await entry.save();

      let settings = await user.getVerifiedSettings(keystore, publicKey);
      assert.equal(settings, null, 'tampering with any signed key should invalidate the entire settings result');
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Cross-Component Integration
  // ---------------------------------------------------------------------------

  describe('Cross-Component Integration', () => {
    it('should verify all components in a complete signing chain', async () => {
      let engine  = core.getPermissionEngine();
      let service = new ValueStoreService({ context: core.getContext() });

      let agentKeys = keystore.generateSigningKeyPair();

      // --- Component 1: Frame signed by agent ---
      let frameContent   = { role: 'assistant', text: 'Agent response in integration test.' };
      let frameSig       = signFrameContent(keystore, frameContent, 'agent', agentKeys.privateKey);
      let frameValid     = keystore.verifyWithPublicKey(frameContent, agentKeys.publicKey, frameSig);
      assert.equal(frameValid, true, 'frame signature should be valid');

      // --- Component 2: Permission rule signed by system ---
      let rule = await engine.createRule({
        organizationID: organization.id,
        featureName:    'shell:execute',
        effect:         'allow',
        createdBy:      'usr_cross_test',
        privateKeyPEM:  privateKey,
      });

      let ruleResult = await engine.checkPermission('shell:execute', {}, {
        organizationID:    organization.id,
        verifyFingerprint: true,
        publicKeyPEM:      publicKey,
      });
      assert.equal(ruleResult, false, 'permission rule fingerprint should be valid');

      // --- Component 3: ValueStore signed value ---
      await service.setSigned('Agent', 'agt_cross_test', 'config', 'policy', 'enabled', agentKeys.privateKey, agentKeys.publicKey, {
        organizationID: organization.id,
      });

      let vsResult = await service.getVerified('Agent', 'agt_cross_test', 'config', 'policy', agentKeys.publicKey);
      assert.equal(vsResult.value, 'enabled', 'value store signed value should verify');
      assert.equal(vsResult.signed, true);
      assert.equal(vsResult.verified, true);

      // --- All three components are valid at this point ---

      // --- Now tamper with ONE component (the frame) ---
      let tamperedFrame = { role: 'assistant', text: 'TAMPERED response.' };
      let frameStillValid = keystore.verifyWithPublicKey(tamperedFrame, agentKeys.publicKey, frameSig);
      assert.equal(frameStillValid, false, 'tampered frame should be detected');

      // --- Verify the OTHER components remain valid ---
      let ruleStillValid = await engine.checkPermission('shell:execute', {}, {
        organizationID:    organization.id,
        verifyFingerprint: true,
        publicKeyPEM:      publicKey,
      });
      assert.equal(ruleStillValid, false, 'permission rule should still be valid after frame tampering');

      let vsStillValid = await service.getVerified('Agent', 'agt_cross_test', 'config', 'policy', agentKeys.publicKey);
      assert.equal(vsStillValid.value, 'enabled', 'value store should still be valid after frame tampering');
      assert.equal(vsStillValid.verified, true);
    });

    it('should detect tampering in each component independently', async () => {
      let engine  = core.getPermissionEngine();
      let service = new ValueStoreService({ context: core.getContext() });

      let agentKeys = keystore.generateSigningKeyPair();

      // Set up all three components
      let frameContent = { role: 'assistant', text: 'Original.' };
      let frameSig     = signFrameContent(keystore, frameContent, 'agent', agentKeys.privateKey);

      await engine.createRule({
        organizationID: organization.id,
        featureName:    'websearch:fetch',
        effect:         'allow',
        createdBy:      'usr_cross_indep',
        privateKeyPEM:  privateKey,
      });

      await service.setSigned('Agent', 'agt_cross_indep', 'config', 'flag', true, agentKeys.privateKey, agentKeys.publicKey, {
        organizationID: organization.id,
      });

      // Tamper with permission rule
      let { PermissionRule } = models;
      let rules = await PermissionRule.where
        .organizationID.EQ(organization.id)
        .featureName.EQ('websearch:fetch')
        .all();

      let tamperedRule = rules[0];
      tamperedRule.effect = 'deny';
      await tamperedRule.save();

      // Permission rule should be detected as tampered
      let permResult = await engine.checkPermission('websearch:fetch', {}, {
        organizationID:    organization.id,
        verifyFingerprint: true,
        publicKeyPEM:      publicKey,
      });
      assert.equal(permResult, true, 'tampered permission rule should be filtered out');

      // Frame should still verify (untampered)
      let frameValid = keystore.verifyWithPublicKey(frameContent, agentKeys.publicKey, frameSig);
      assert.equal(frameValid, true, 'untampered frame should still verify');

      // ValueStore should still verify (untampered)
      let vsResult = await service.getVerified('Agent', 'agt_cross_indep', 'config', 'flag', agentKeys.publicKey);
      assert.equal(vsResult.value, true, 'untampered value store should still verify');
      assert.equal(vsResult.verified, true);
    });

    it('should demonstrate agent key encryption and decryption round-trip with signing', async () => {
      // Generate agent keys
      let agentKeys = keystore.generateSigningKeyPair();
      let agentID   = 'agt_encrypt_test';

      // Encrypt the private key using SMK-derived key
      let encryptedPK = keystore.encryptActorPrivateKey(agentKeys.privateKey, agentID);
      assert.ok(encryptedPK.ciphertext, 'encrypted key should have ciphertext');
      assert.ok(encryptedPK.iv, 'encrypted key should have iv');
      assert.ok(encryptedPK.authTag, 'encrypted key should have authTag');

      // Decrypt the private key
      let decryptedPK = keystore.decryptActorPrivateKey(encryptedPK, agentID);
      assert.equal(decryptedPK, agentKeys.privateKey, 'decrypted key should match original');

      // Use the decrypted key to sign frame content
      let content   = { role: 'assistant', text: 'Signed with decrypted agent key.' };
      let signature = signFrameContent(keystore, content, 'agent', decryptedPK);

      // Verify with the agent's public key
      let valid = keystore.verifyWithPublicKey(content, agentKeys.publicKey, signature);
      assert.equal(valid, true, 'content signed with decrypted key should verify with public key');

      // Tamper with the content
      let tampered = { role: 'assistant', text: 'TAMPERED content.' };
      let invalid  = keystore.verifyWithPublicKey(tampered, agentKeys.publicKey, signature);
      assert.equal(invalid, false, 'tampered content should fail verification after decryption round-trip');
    });

    it('should ensure that different agent keys cannot forge each other signatures', async () => {
      let agent1Keys = keystore.generateSigningKeyPair();
      let agent2Keys = keystore.generateSigningKeyPair();

      // Agent 1 signs content
      let content = { role: 'assistant', text: 'I am agent 1.' };
      let sig1    = signFrameContent(keystore, content, 'agent', agent1Keys.privateKey);

      // Agent 2 tries to verify agent 1's signature with their own key
      let crossVerify = keystore.verifyWithPublicKey(content, agent2Keys.publicKey, sig1);
      assert.equal(crossVerify, false, 'agent 2 public key should not verify agent 1 signature');

      // Agent 2 creates their own signature for the same content
      let sig2 = signFrameContent(keystore, content, 'agent', agent2Keys.privateKey);

      // Both signatures are valid with their respective public keys
      assert.equal(keystore.verifyWithPublicKey(content, agent1Keys.publicKey, sig1), true);
      assert.equal(keystore.verifyWithPublicKey(content, agent2Keys.publicKey, sig2), true);

      // But not cross-verified
      assert.equal(keystore.verifyWithPublicKey(content, agent1Keys.publicKey, sig2), false);
      assert.equal(keystore.verifyWithPublicKey(content, agent2Keys.publicKey, sig1), false);

      // Signatures are different for the same content
      assert.notEqual(sig1, sig2, 'different keys should produce different signatures');
    });
  });
});
