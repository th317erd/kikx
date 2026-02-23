'use strict';

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ============================================================================
// Environment Setup
// ============================================================================

let testDir = mkdtempSync(join(tmpdir(), 'hero-api-keys-test-'));

process.env.HERO_JWT_SECRET     = 'test-secret-key-for-testing';
process.env.HERO_ENCRYPTION_KEY = 'test-encryption-key-32chars!!';
process.env.XDG_CONFIG_HOME     = testDir;

let database;
let auth;
let apiKeys;

async function loadModules() {
  database = await import('../../../server/database.mjs');
  auth     = await import('../../../server/auth.mjs');
  apiKeys  = await import('../../../server/lib/auth/api-keys.mjs');
}

describe('API Keys', async () => {
  await loadModules();

  let db;
  let userId;
  let otherUserId;

  beforeEach(async () => {
    db = database.getDatabase();

    db.exec('DELETE FROM api_keys');
    db.exec('DELETE FROM magic_link_tokens');
    db.exec('DELETE FROM frames');
    db.exec('DELETE FROM session_participants');
    db.exec('DELETE FROM sessions');
    db.exec('DELETE FROM agents');
    db.exec('DELETE FROM users');

    let user1 = await auth.createUser('apiuser1', 'testpass');
    userId = user1.id;

    let user2 = await auth.createUser('apiuser2', 'testpass');
    otherUserId = user2.id;
  });

  // ===========================================================================
  // createApiKey
  // ===========================================================================
  describe('createApiKey()', () => {
    it('should create an API key and return plaintext', () => {
      let result = apiKeys.createApiKey(userId, 'Test Key', {}, db);

      assert.ok(result.id);
      assert.ok(result.key);
      assert.ok(result.key.startsWith('hero_'));
      assert.ok(result.keyPrefix);
      assert.strictEqual(result.name, 'Test Key');
      assert.deepStrictEqual(result.scopes, []);
      assert.strictEqual(result.expiresAt, null);
    });

    it('should store hash in database, not plaintext', () => {
      let result = apiKeys.createApiKey(userId, 'Test Key', {}, db);
      let record = db.prepare('SELECT key_hash FROM api_keys WHERE id = ?').get(result.id);

      assert.ok(record.key_hash);
      assert.notStrictEqual(record.key_hash, result.key);
      assert.ok(record.key_hash.length === 64); // SHA-256 hex
    });

    it('should store key prefix', () => {
      let result = apiKeys.createApiKey(userId, 'Test Key', {}, db);

      assert.ok(result.key.startsWith(result.keyPrefix));
    });

    it('should accept custom scopes', () => {
      let result = apiKeys.createApiKey(userId, 'Scoped Key', {
        scopes: ['read:sessions', 'write:sessions'],
      }, db);

      assert.deepStrictEqual(result.scopes, ['read:sessions', 'write:sessions']);
    });

    it('should accept expiry date', () => {
      let expiry = new Date(Date.now() + 86400000).toISOString();
      let result = apiKeys.createApiKey(userId, 'Expiring Key', {
        expiresAt: expiry,
      }, db);

      assert.strictEqual(result.expiresAt, expiry);
    });

    it('should throw for empty name', () => {
      assert.throws(() => apiKeys.createApiKey(userId, '', {}, db), /name is required/);
    });

    it('should throw for null name', () => {
      assert.throws(() => apiKeys.createApiKey(userId, null, {}, db), /name is required/);
    });

    it('should trim name', () => {
      let result = apiKeys.createApiKey(userId, '  Spaced Key  ', {}, db);
      assert.strictEqual(result.name, 'Spaced Key');
    });

    it('should generate unique keys', () => {
      let k1 = apiKeys.createApiKey(userId, 'Key 1', {}, db);
      let k2 = apiKeys.createApiKey(userId, 'Key 2', {}, db);

      assert.notStrictEqual(k1.key, k2.key);
    });
  });

  // ===========================================================================
  // listApiKeys
  // ===========================================================================
  describe('listApiKeys()', () => {
    it('should return empty array when no keys exist', () => {
      let keys = apiKeys.listApiKeys(userId, db);
      assert.strictEqual(keys.length, 0);
    });

    it('should list all keys for a user', () => {
      apiKeys.createApiKey(userId, 'Key 1', {}, db);
      apiKeys.createApiKey(userId, 'Key 2', {}, db);

      let keys = apiKeys.listApiKeys(userId, db);
      assert.strictEqual(keys.length, 2);
    });

    it('should not include plaintext key', () => {
      apiKeys.createApiKey(userId, 'Test Key', {}, db);

      let keys = apiKeys.listApiKeys(userId, db);
      assert.strictEqual(keys[0].key, undefined);
      assert.ok(keys[0].keyPrefix);
    });

    it('should isolate keys by user', () => {
      apiKeys.createApiKey(userId, 'User 1 Key', {}, db);
      apiKeys.createApiKey(otherUserId, 'User 2 Key', {}, db);

      let user1Keys = apiKeys.listApiKeys(userId, db);
      let user2Keys = apiKeys.listApiKeys(otherUserId, db);

      assert.strictEqual(user1Keys.length, 1);
      assert.strictEqual(user2Keys.length, 1);
      assert.strictEqual(user1Keys[0].name, 'User 1 Key');
      assert.strictEqual(user2Keys[0].name, 'User 2 Key');
    });

    it('should deserialize scopes', () => {
      apiKeys.createApiKey(userId, 'Scoped', { scopes: ['read', 'write'] }, db);

      let keys = apiKeys.listApiKeys(userId, db);
      assert.deepStrictEqual(keys[0].scopes, ['read', 'write']);
    });

    it('should include metadata fields', () => {
      apiKeys.createApiKey(userId, 'Full Key', {}, db);

      let keys = apiKeys.listApiKeys(userId, db);
      let key  = keys[0];

      assert.ok(key.id);
      assert.ok(key.keyPrefix);
      assert.strictEqual(key.name, 'Full Key');
      assert.ok(key.createdAt);
      assert.strictEqual(key.lastUsedAt, null);
    });
  });

  // ===========================================================================
  // revokeApiKey
  // ===========================================================================
  describe('revokeApiKey()', () => {
    it('should delete an API key', () => {
      let created = apiKeys.createApiKey(userId, 'Doomed Key', {}, db);
      let deleted = apiKeys.revokeApiKey(userId, created.id, db);

      assert.strictEqual(deleted, true);
      assert.strictEqual(apiKeys.listApiKeys(userId, db).length, 0);
    });

    it('should return false for nonexistent key', () => {
      let deleted = apiKeys.revokeApiKey(userId, 99999, db);
      assert.strictEqual(deleted, false);
    });

    it('should enforce ownership', () => {
      let created = apiKeys.createApiKey(userId, 'My Key', {}, db);
      let deleted = apiKeys.revokeApiKey(otherUserId, created.id, db);

      assert.strictEqual(deleted, false);
      assert.strictEqual(apiKeys.listApiKeys(userId, db).length, 1);
    });

    it('should not affect other keys', () => {
      let k1 = apiKeys.createApiKey(userId, 'Key 1', {}, db);
      apiKeys.createApiKey(userId, 'Key 2', {}, db);

      apiKeys.revokeApiKey(userId, k1.id, db);

      let remaining = apiKeys.listApiKeys(userId, db);
      assert.strictEqual(remaining.length, 1);
      assert.strictEqual(remaining[0].name, 'Key 2');
    });
  });

  // ===========================================================================
  // validateApiKey
  // ===========================================================================
  describe('validateApiKey()', () => {
    it('should validate a correct API key', () => {
      let created = apiKeys.createApiKey(userId, 'Valid Key', {}, db);
      let result  = apiKeys.validateApiKey(created.key, db);

      assert.ok(result);
      assert.strictEqual(result.userId, userId);
      assert.strictEqual(result.name, 'Valid Key');
    });

    it('should update last_used_at on validation', () => {
      let created = apiKeys.createApiKey(userId, 'Used Key', {}, db);
      apiKeys.validateApiKey(created.key, db);

      let keys = apiKeys.listApiKeys(userId, db);
      assert.ok(keys[0].lastUsedAt);
    });

    it('should reject invalid key', () => {
      let result = apiKeys.validateApiKey('hero_invalid_key_here', db);
      assert.strictEqual(result, null);
    });

    it('should reject key without hero_ prefix', () => {
      let result = apiKeys.validateApiKey('not_a_hero_key', db);
      assert.strictEqual(result, null);
    });

    it('should reject null key', () => {
      assert.strictEqual(apiKeys.validateApiKey(null, db), null);
    });

    it('should reject empty key', () => {
      assert.strictEqual(apiKeys.validateApiKey('', db), null);
    });

    it('should reject expired key', () => {
      let created = apiKeys.createApiKey(userId, 'Expired Key', {
        expiresAt: new Date(Date.now() - 86400000).toISOString(),
      }, db);

      let result = apiKeys.validateApiKey(created.key, db);
      assert.strictEqual(result, null);
    });

    it('should accept key with future expiry', () => {
      let created = apiKeys.createApiKey(userId, 'Future Key', {
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
      }, db);

      let result = apiKeys.validateApiKey(created.key, db);
      assert.ok(result);
      assert.strictEqual(result.userId, userId);
    });

    it('should reject revoked key', () => {
      let created = apiKeys.createApiKey(userId, 'Revoked Key', {}, db);
      apiKeys.revokeApiKey(userId, created.id, db);

      let result = apiKeys.validateApiKey(created.key, db);
      assert.strictEqual(result, null);
    });

    it('should return scopes', () => {
      let created = apiKeys.createApiKey(userId, 'Scoped', {
        scopes: ['read:sessions'],
      }, db);

      let result = apiKeys.validateApiKey(created.key, db);
      assert.deepStrictEqual(result.scopes, ['read:sessions']);
    });
  });
});
