'use strict';

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs     from 'node:fs';
import os     from 'node:os';
import path   from 'node:path';

import { createKikxCore }       from '../../../src/core/index.mjs';
import { Keystore }             from '../../../src/core/crypto/keystore.mjs';
import { ValueStoreService }    from '../../../src/core/lib/value-store-service.mjs';

// =============================================================================
// ValueStoreService Tests
// =============================================================================
// Exercises CRUD, batch operations, search, Ed25519 signing/verification,
// and edge cases for the ValueStoreService.
// =============================================================================

describe('ValueStoreService', () => {
  let core, models, keystore, service, organization, tempDir;

  before(async () => {
    core = createKikxCore();
    await core.start();
    models = core.getModels();

    // Set up keystore with SMK for signing tests
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kikx-vs-test-'));
    keystore = new Keystore();
    keystore.initialize();
    keystore.loadServerMasterKey(tempDir);

    let context = core.getContext();
    context.setProperty('keystore', keystore);

    service = new ValueStoreService({ context });
  });

  after(async () => {
    if (keystore)
      keystore.destroy();

    if (core && core.isStarted())
      await core.stop();

    // Clean up temp dir
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    organization = await models.Organization.create({ name: 'VSS Test Org' });
  });

  // ---------------------------------------------------------------------------
  // Basic CRUD — get / set
  // ---------------------------------------------------------------------------

  describe('get / set', () => {
    it('set() stores a value and get() retrieves it', async () => {
      await service.set('Agent', 'agt_1', 'config', 'theme', 'dark', {
        organizationID: organization.id,
      });

      let value = await service.get('Agent', 'agt_1', 'config', 'theme');
      assert.equal(value, 'dark');
    });

    it('set() with string value stores and retrieves correctly', async () => {
      await service.set('Agent', 'agt_str', 'config', 'greeting', 'hello world', {
        organizationID: organization.id,
      });

      let value = await service.get('Agent', 'agt_str', 'config', 'greeting');
      assert.equal(value, 'hello world');
    });

    it('set() with object value stores as JSON and get() parses it back', async () => {
      let obj = { color: 'blue', size: 42, nested: { a: 1 } };

      await service.set('Agent', 'agt_obj', 'config', 'settings', obj, {
        organizationID: organization.id,
      });

      let value = await service.get('Agent', 'agt_obj', 'config', 'settings');
      assert.deepEqual(value, obj);
    });

    it('set() with null value deletes the entry', async () => {
      await service.set('Agent', 'agt_null', 'config', 'toDelete', 'exists', {
        organizationID: organization.id,
      });

      let before = await service.get('Agent', 'agt_null', 'config', 'toDelete');
      assert.equal(before, 'exists');

      await service.set('Agent', 'agt_null', 'config', 'toDelete', null);

      let after = await service.get('Agent', 'agt_null', 'config', 'toDelete');
      assert.equal(after, null);
    });

    it('set() with undefined value deletes the entry', async () => {
      await service.set('Agent', 'agt_undef', 'config', 'toDelete', 'exists', {
        organizationID: organization.id,
      });

      await service.set('Agent', 'agt_undef', 'config', 'toDelete', undefined);

      let value = await service.get('Agent', 'agt_undef', 'config', 'toDelete');
      assert.equal(value, null);
    });

    it('set() upserts (overwrites existing entry)', async () => {
      await service.set('Agent', 'agt_ups', 'config', 'model', 'claude-3', {
        organizationID: organization.id,
      });

      await service.set('Agent', 'agt_ups', 'config', 'model', 'claude-4', {
        organizationID: organization.id,
      });

      let value = await service.get('Agent', 'agt_ups', 'config', 'model');
      assert.equal(value, 'claude-4');
    });

    it('get() returns null for non-existent key', async () => {
      let value = await service.get('Agent', 'agt_ghost', 'config', 'nonexistent');
      assert.equal(value, null);
    });

    it('get() returns null for corrupted JSON value', async () => {
      // Create entry with valid value, then corrupt it directly in DB
      await service.set('Agent', 'agt_corrupt', 'config', 'bad', 'good', {
        organizationID: organization.id,
      });

      let { ValueStore } = models;
      let entry = await ValueStore
        .where.ownerType.EQ('Agent')
        .ownerID.EQ('agt_corrupt')
        .namespace.EQ('config')
        .key.EQ('bad')
        .first();

      entry.value = '{invalid json!!';
      await entry.save();

      let value = await service.get('Agent', 'agt_corrupt', 'config', 'bad');
      assert.equal(value, null);
    });

    it('get() respects scopeID', async () => {
      await service.set('Agent', 'agt_scope', 'config', 'key1', 'scope_a_value', {
        scopeID: 'scope_a', organizationID: organization.id,
      });

      let value = await service.get('Agent', 'agt_scope', 'config', 'key1', {
        scopeID: 'scope_a',
      });

      assert.equal(value, 'scope_a_value');
    });

    it('get() with different scopeID returns null (does not cross scopes)', async () => {
      await service.set('Agent', 'agt_scope2', 'config', 'key1', 'only_here', {
        scopeID: 'scope_x', organizationID: organization.id,
      });

      let value = await service.get('Agent', 'agt_scope2', 'config', 'key1', {
        scopeID: 'scope_y',
      });

      assert.equal(value, null);
    });
  });

  // ---------------------------------------------------------------------------
  // delete
  // ---------------------------------------------------------------------------

  describe('delete', () => {
    it('delete() removes an entry', async () => {
      await service.set('Agent', 'agt_del', 'config', 'willRemove', 'bye', {
        organizationID: organization.id,
      });

      await service.delete('Agent', 'agt_del', 'config', 'willRemove');

      let value = await service.get('Agent', 'agt_del', 'config', 'willRemove');
      assert.equal(value, null);
    });

    it('delete() is idempotent (missing key does not throw)', async () => {
      // Should not throw
      await service.delete('Agent', 'agt_nope', 'config', 'neverExisted');
    });
  });

  // ---------------------------------------------------------------------------
  // getAll / setAll
  // ---------------------------------------------------------------------------

  describe('getAll / setAll', () => {
    it('getAll() returns empty object when no entries exist', async () => {
      let result = await service.getAll('Agent', 'agt_empty', 'config');
      assert.deepEqual(result, {});
    });

    it('getAll() returns all entries as { key: parsedValue }', async () => {
      await service.set('Agent', 'agt_all', 'config', 'a', 1, { organizationID: organization.id });
      await service.set('Agent', 'agt_all', 'config', 'b', 'two', { organizationID: organization.id });
      await service.set('Agent', 'agt_all', 'config', 'c', { x: 3 }, { organizationID: organization.id });

      let result = await service.getAll('Agent', 'agt_all', 'config');
      assert.deepEqual(result, { a: 1, b: 'two', c: { x: 3 } });
    });

    it('setAll() stores multiple entries', async () => {
      await service.setAll('Agent', 'agt_batch', 'config', {
        alpha: 'first',
        beta:  'second',
        gamma: 'third',
      }, { organizationID: organization.id });

      let result = await service.getAll('Agent', 'agt_batch', 'config');
      assert.deepEqual(result, { alpha: 'first', beta: 'second', gamma: 'third' });
    });

    it('setAll() with null value deletes that entry', async () => {
      await service.setAll('Agent', 'agt_batch_del', 'config', {
        keep:   'yes',
        remove: 'soon',
      }, { organizationID: organization.id });

      await service.setAll('Agent', 'agt_batch_del', 'config', {
        remove: null,
      });

      let result = await service.getAll('Agent', 'agt_batch_del', 'config');
      assert.deepEqual(result, { keep: 'yes' });
    });

    it('setAll() + getAll() round trip', async () => {
      let entries = {
        name:    'Agent X',
        model:   'claude-4',
        enabled: true,
        count:   42,
      };

      await service.setAll('Agent', 'agt_rt', 'config', entries, {
        organizationID: organization.id,
      });

      let result = await service.getAll('Agent', 'agt_rt', 'config');
      assert.deepEqual(result, entries);
    });
  });

  // ---------------------------------------------------------------------------
  // search
  // ---------------------------------------------------------------------------

  describe('search', () => {
    it('search() with empty query returns all entries', async () => {
      await service.setAll('Agent', 'agt_srch', 'config', {
        foo: 'bar',
        baz: 'qux',
      }, { organizationID: organization.id });

      let results = await service.search('Agent', 'agt_srch', 'config', null);
      assert.equal(results.length, 2);
    });

    it('search() matches on key name', async () => {
      await service.setAll('Agent', 'agt_srch_key', 'config', {
        colorTheme:  'dark',
        fontSize:    14,
        colorScheme: 'blue',
      }, { organizationID: organization.id });

      let results = await service.search('Agent', 'agt_srch_key', 'config', 'color');
      assert.equal(results.length, 2);

      let keys = results.map((r) => r.key).sort();
      assert.deepEqual(keys, ['colorScheme', 'colorTheme']);
    });

    it('search() matches on value content', async () => {
      await service.setAll('Agent', 'agt_srch_val', 'config', {
        greeting: 'hello world',
        farewell: 'goodbye',
        note:     'world is round',
      }, { organizationID: organization.id });

      let results = await service.search('Agent', 'agt_srch_val', 'config', 'world');
      assert.equal(results.length, 2);

      let keys = results.map((r) => r.key).sort();
      assert.deepEqual(keys, ['greeting', 'note']);
    });

    it('search() respects namespace', async () => {
      await service.set('Agent', 'agt_srch_ns', 'config', 'key1', 'v1', { organizationID: organization.id });
      await service.set('Agent', 'agt_srch_ns', 'state', 'key1', 'v2', { organizationID: organization.id });

      let results = await service.search('Agent', 'agt_srch_ns', 'config', null);
      assert.equal(results.length, 1);
      assert.equal(results[0].key, 'key1');
      assert.equal(results[0].value, 'v1');
    });

    it('search() across all scopes when scopeID is null/undefined', async () => {
      await service.set('Agent', 'agt_srch_scope', 'config', 'key1', 'a', {
        scopeID: 'scope_1', organizationID: organization.id,
      });

      await service.set('Agent', 'agt_srch_scope', 'config', 'key2', 'b', {
        scopeID: 'scope_2', organizationID: organization.id,
      });

      let results = await service.search('Agent', 'agt_srch_scope', 'config', null, {
        scopeID: null,
      });

      assert.equal(results.length, 2);
    });

    it('search() within specific scope when scopeID is empty string', async () => {
      await service.set('Agent', 'agt_srch_def', 'config', 'defaultKey', 'default', {
        scopeID: '', organizationID: organization.id,
      });

      await service.set('Agent', 'agt_srch_def', 'config', 'scopedKey', 'scoped', {
        scopeID: 'other', organizationID: organization.id,
      });

      let results = await service.search('Agent', 'agt_srch_def', 'config', null, {
        scopeID: '',
      });

      assert.equal(results.length, 1);
      assert.equal(results[0].key, 'defaultKey');
    });

    it('search() respects limit', async () => {
      await service.setAll('Agent', 'agt_srch_lim', 'config', {
        a: 1, b: 2, c: 3, d: 4, e: 5,
      }, { organizationID: organization.id });

      let results = await service.search('Agent', 'agt_srch_lim', 'config', null, {
        limit: 3,
      });

      assert.equal(results.length, 3);
    });

    it('search() respects offset', async () => {
      await service.setAll('Agent', 'agt_srch_off', 'config', {
        a: 1, b: 2, c: 3, d: 4, e: 5,
      }, { organizationID: organization.id });

      let allResults = await service.search('Agent', 'agt_srch_off', 'config', null, {
        limit: 100,
      });

      let offsetResults = await service.search('Agent', 'agt_srch_off', 'config', null, {
        offset: 2, limit: 100,
      });

      assert.equal(offsetResults.length, allResults.length - 2);
    });

    it('search() returns empty array when no matches', async () => {
      await service.set('Agent', 'agt_srch_none', 'config', 'present', 'here', {
        organizationID: organization.id,
      });

      let results = await service.search('Agent', 'agt_srch_none', 'config', 'zzzznowaythismatches');
      assert.deepEqual(results, []);
    });

    it('search() result entries have expected shape', async () => {
      await service.set('Agent', 'agt_srch_shape', 'config', 'mykey', 'myval', {
        organizationID: organization.id,
      });

      let results = await service.search('Agent', 'agt_srch_shape', 'config', null);
      assert.equal(results.length, 1);

      let entry = results[0];
      assert.equal(entry.key, 'mykey');
      assert.equal(entry.value, 'myval');
      assert.equal(typeof entry.scopeID, 'string');
      assert.ok('updatedAt' in entry);
    });
  });

  // ---------------------------------------------------------------------------
  // Signed operations — setSigned / getVerified
  // ---------------------------------------------------------------------------

  describe('setSigned / getVerified', () => {
    it('setSigned() stores value with signature and fingerprint', async () => {
      let { publicKey, privateKey } = keystore.generateSigningKeyPair();

      await service.setSigned('Agent', 'agt_sign1', 'config', 'riskLevel', 'permissive', privateKey, publicKey, {
        organizationID: organization.id,
      });

      // Verify the raw DB entry has a signature and fingerprint
      let { ValueStore } = models;
      let entry = await ValueStore
        .where.ownerType.EQ('Agent')
        .ownerID.EQ('agt_sign1')
        .key.EQ('riskLevel')
        .first();

      assert.ok(entry.signature, 'signature should be set');
      assert.ok(entry.signature.length > 0, 'signature should be non-empty');
      assert.ok(entry.signingKeyFingerprint, 'fingerprint should be set');
      assert.equal(entry.signingKeyFingerprint.length, 32, 'fingerprint should be 32 hex chars');
    });

    it('getVerified() returns { value, signed: true, verified: true } when valid', async () => {
      let { publicKey, privateKey } = keystore.generateSigningKeyPair();

      await service.setSigned('Agent', 'agt_sign2', 'config', 'riskLevel', 'permissive', privateKey, publicKey, {
        organizationID: organization.id,
      });

      let result = await service.getVerified('Agent', 'agt_sign2', 'config', 'riskLevel', publicKey);
      assert.equal(result.value, 'permissive');
      assert.equal(result.signed, true);
      assert.equal(result.verified, true);
    });

    it('getVerified() returns verified: false when value is tampered', async () => {
      let { publicKey, privateKey } = keystore.generateSigningKeyPair();

      await service.setSigned('Agent', 'agt_tamper', 'config', 'riskLevel', 'permissive', privateKey, publicKey, {
        organizationID: organization.id,
      });

      // Tamper with the value directly in DB
      let { ValueStore } = models;
      let entry = await ValueStore
        .where.ownerType.EQ('Agent')
        .ownerID.EQ('agt_tamper')
        .key.EQ('riskLevel')
        .first();

      entry.value = JSON.stringify('strict');
      await entry.save();

      let result = await service.getVerified('Agent', 'agt_tamper', 'config', 'riskLevel', publicKey);
      assert.equal(result.signed, true);
      assert.equal(result.verified, false, 'should be verified: false for tampered value');
    });

    it('getVerified() returns verified: false when signature is tampered', async () => {
      let { publicKey, privateKey } = keystore.generateSigningKeyPair();

      await service.setSigned('Agent', 'agt_sigmod', 'config', 'riskLevel', 'permissive', privateKey, publicKey, {
        organizationID: organization.id,
      });

      // Tamper with the signature directly in DB
      let { ValueStore } = models;
      let entry = await ValueStore
        .where.ownerType.EQ('Agent')
        .ownerID.EQ('agt_sigmod')
        .key.EQ('riskLevel')
        .first();

      entry.signature = 'deadbeef00112233';
      await entry.save();

      let result = await service.getVerified('Agent', 'agt_sigmod', 'config', 'riskLevel', publicKey);
      assert.equal(result.signed, true);
      assert.equal(result.verified, false, 'should be verified: false for tampered signature');
    });

    it('getVerified() returns null for non-existent key', async () => {
      let { publicKey } = keystore.generateSigningKeyPair();

      let result = await service.getVerified('Agent', 'agt_ghost', 'config', 'nope', publicKey);
      assert.equal(result, null);
    });

    it('getVerified() returns verified: false when verified with wrong public key', async () => {
      let keyPair1 = keystore.generateSigningKeyPair();
      let keyPair2 = keystore.generateSigningKeyPair();

      await service.setSigned('Agent', 'agt_wrongkey', 'config', 'riskLevel', 'permissive', keyPair1.privateKey, keyPair1.publicKey, {
        organizationID: organization.id,
      });

      // Try verifying with a different key pair's public key
      let result = await service.getVerified('Agent', 'agt_wrongkey', 'config', 'riskLevel', keyPair2.publicKey);
      assert.equal(result.signed, true);
      assert.equal(result.verified, false, 'should be verified: false when using wrong public key');
    });

    it('setSigned() then getVerified() round trip with Ed25519 key pair', async () => {
      let { publicKey, privateKey } = keystore.generateSigningKeyPair();

      let original = { sensitivity: 'high', tags: ['a', 'b'] };

      await service.setSigned('User', 'usr_rt', 'settings', 'preferences', original, privateKey, publicKey, {
        organizationID: organization.id,
      });

      let result = await service.getVerified('User', 'usr_rt', 'settings', 'preferences', publicKey);
      assert.deepEqual(result.value, original);
      assert.equal(result.signed, true);
      assert.equal(result.verified, true);
    });

    it('setSigned() upserts signed entries', async () => {
      let { publicKey, privateKey } = keystore.generateSigningKeyPair();

      await service.setSigned('Agent', 'agt_sig_ups', 'config', 'level', 'v1', privateKey, publicKey, {
        organizationID: organization.id,
      });

      await service.setSigned('Agent', 'agt_sig_ups', 'config', 'level', 'v2', privateKey, publicKey, {
        organizationID: organization.id,
      });

      let result = await service.getVerified('Agent', 'agt_sig_ups', 'config', 'level', publicKey);
      assert.equal(result.value, 'v2');
      assert.equal(result.signed, true);
      assert.equal(result.verified, true);
    });

    it('getVerified() returns { signed: false } for entry without signature', async () => {
      let { publicKey } = keystore.generateSigningKeyPair();

      // Create an unsigned entry via regular set()
      await service.set('Agent', 'agt_nosig', 'config', 'unsigned', 'data', {
        organizationID: organization.id,
      });

      let result = await service.getVerified('Agent', 'agt_nosig', 'config', 'unsigned', publicKey);
      assert.equal(result.signed, false, 'should be signed: false for unsigned entry');
      assert.equal(result.value, 'data');
      assert.equal(result.verified, undefined, 'verified should not be present for unsigned entries');
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  describe('edge cases', () => {
    it('set() with empty string value stores it (does not delete)', async () => {
      await service.set('Agent', 'agt_edge', 'config', 'emptyStr', '', {
        organizationID: organization.id,
      });

      let value = await service.get('Agent', 'agt_edge', 'config', 'emptyStr');
      assert.equal(value, '');
    });

    it('set() with 0 as value stores it (does not delete)', async () => {
      await service.set('Agent', 'agt_zero', 'config', 'zeroVal', 0, {
        organizationID: organization.id,
      });

      let value = await service.get('Agent', 'agt_zero', 'config', 'zeroVal');
      assert.equal(value, 0);
    });

    it('set() with false as value stores it (does not delete)', async () => {
      await service.set('Agent', 'agt_false', 'config', 'falseVal', false, {
        organizationID: organization.id,
      });

      let value = await service.get('Agent', 'agt_false', 'config', 'falseVal');
      assert.equal(value, false);
    });

    it('multiple namespaces for same owner do not interfere', async () => {
      await service.set('Agent', 'agt_multi_ns', 'config', 'key', 'config_value', {
        organizationID: organization.id,
      });

      await service.set('Agent', 'agt_multi_ns', 'state', 'key', 'state_value', {
        organizationID: organization.id,
      });

      await service.set('Agent', 'agt_multi_ns', 'memory', 'key', 'memory_value', {
        organizationID: organization.id,
      });

      assert.equal(await service.get('Agent', 'agt_multi_ns', 'config', 'key'), 'config_value');
      assert.equal(await service.get('Agent', 'agt_multi_ns', 'state', 'key'), 'state_value');
      assert.equal(await service.get('Agent', 'agt_multi_ns', 'memory', 'key'), 'memory_value');
    });

    it('organizationID is required for creation', async () => {
      await assert.rejects(
        () => service.set('Agent', 'agt_noorg', 'config', 'key', 'value'),
        { message: /organizationID is required/ },
      );
    });

    it('organizationID is not required for update of existing entry', async () => {
      await service.set('Agent', 'agt_upd', 'config', 'key', 'v1', {
        organizationID: organization.id,
      });

      // Update without providing organizationID — should succeed
      await service.set('Agent', 'agt_upd', 'config', 'key', 'v2');

      let value = await service.get('Agent', 'agt_upd', 'config', 'key');
      assert.equal(value, 'v2');
    });

    it('set() clears signature and fingerprint on upsert (unsigned overwrite of signed entry)', async () => {
      let { publicKey, privateKey } = keystore.generateSigningKeyPair();

      await service.setSigned('Agent', 'agt_clear_sig', 'config', 'key', 'signed', privateKey, publicKey, {
        organizationID: organization.id,
      });

      // Overwrite with unsigned set()
      await service.set('Agent', 'agt_clear_sig', 'config', 'key', 'unsigned');

      // The old signature and fingerprint should be cleared
      let { ValueStore } = models;
      let entry = await ValueStore
        .where.ownerType.EQ('Agent')
        .ownerID.EQ('agt_clear_sig')
        .key.EQ('key')
        .first();

      assert.equal(entry.signature, null, 'signature should be cleared on unsigned upsert');
      assert.equal(entry.signingKeyFingerprint, null, 'fingerprint should be cleared on unsigned upsert');
    });

    it('set() with array value stores and retrieves correctly', async () => {
      let arr = [1, 'two', { three: 3 }];

      await service.set('Agent', 'agt_arr', 'config', 'list', arr, {
        organizationID: organization.id,
      });

      let value = await service.get('Agent', 'agt_arr', 'config', 'list');
      assert.deepEqual(value, arr);
    });

    it('different ownerTypes with same ownerID do not interfere', async () => {
      await service.set('Agent', 'shared_id', 'config', 'key', 'agent_value', {
        organizationID: organization.id,
      });

      await service.set('User', 'shared_id', 'config', 'key', 'user_value', {
        organizationID: organization.id,
      });

      assert.equal(await service.get('Agent', 'shared_id', 'config', 'key'), 'agent_value');
      assert.equal(await service.get('User', 'shared_id', 'config', 'key'), 'user_value');
    });
  });
});
