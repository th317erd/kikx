'use strict';

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ============================================================================
// Environment Setup
// ============================================================================

let testDir = mkdtempSync(join(tmpdir(), 'hero-magic-links-test-'));

process.env.HERO_JWT_SECRET     = 'test-secret-key-for-testing';
process.env.HERO_ENCRYPTION_KEY = 'test-encryption-key-32chars!!';
process.env.XDG_CONFIG_HOME     = testDir;

let database;
let auth;
let magicLinks;

async function loadModules() {
  database   = await import('../../../server/database.mjs');
  auth       = await import('../../../server/auth.mjs');
  magicLinks = await import('../../../server/lib/auth/magic-links.mjs');
}

describe('Magic Link Auth', async () => {
  await loadModules();

  let db;
  let userId;

  beforeEach(async () => {
    db = database.getDatabase();

    db.exec('DELETE FROM magic_link_tokens');
    db.exec('DELETE FROM api_keys');
    db.exec('DELETE FROM frames');
    db.exec('DELETE FROM session_participants');
    db.exec('DELETE FROM sessions');
    db.exec('DELETE FROM agents');
    db.exec('DELETE FROM users');

    let user = await auth.createUser('magicuser', 'testpass');
    userId = user.id;

    // Set email on user
    db.prepare('UPDATE users SET email = ? WHERE id = ?').run('magic@example.com', userId);
  });

  // ===========================================================================
  // generateMagicLink
  // ===========================================================================
  describe('generateMagicLink()', () => {
    it('should generate a token for a valid email', () => {
      let result = magicLinks.generateMagicLink('magic@example.com', db);

      assert.ok(result.token);
      assert.ok(result.token.length >= 32);
      assert.ok(result.expiresAt);
    });

    it('should link to existing user by email', () => {
      let result = magicLinks.generateMagicLink('magic@example.com', db);

      let record = db.prepare('SELECT user_id FROM magic_link_tokens WHERE token = ?').get(result.token);
      assert.strictEqual(record.user_id, userId);
    });

    it('should generate token with null user_id for unknown email', () => {
      let result = magicLinks.generateMagicLink('unknown@example.com', db);

      let record = db.prepare('SELECT user_id FROM magic_link_tokens WHERE token = ?').get(result.token);
      assert.strictEqual(record.user_id, null);
    });

    it('should normalize email to lowercase', () => {
      let result = magicLinks.generateMagicLink('MAGIC@EXAMPLE.COM', db);

      let record = db.prepare('SELECT email FROM magic_link_tokens WHERE token = ?').get(result.token);
      assert.strictEqual(record.email, 'magic@example.com');
    });

    it('should throw for invalid email', () => {
      assert.throws(() => magicLinks.generateMagicLink('notanemail', db), /Valid email/);
    });

    it('should throw for empty email', () => {
      assert.throws(() => magicLinks.generateMagicLink('', db), /Valid email/);
    });

    it('should throw for null email', () => {
      assert.throws(() => magicLinks.generateMagicLink(null, db), /Valid email/);
    });

    it('should generate unique tokens', () => {
      let t1 = magicLinks.generateMagicLink('magic@example.com', db);
      let t2 = magicLinks.generateMagicLink('magic@example.com', db);

      assert.notStrictEqual(t1.token, t2.token);
    });

    it('should set expiry in the future', () => {
      let result = magicLinks.generateMagicLink('magic@example.com', db);
      let expiry = new Date(result.expiresAt);

      assert.ok(expiry > new Date());
    });
  });

  // ===========================================================================
  // verifyMagicLink
  // ===========================================================================
  describe('verifyMagicLink()', () => {
    it('should verify a valid token', () => {
      let { token } = magicLinks.generateMagicLink('magic@example.com', db);
      let result    = magicLinks.verifyMagicLink(token, db);

      assert.ok(result);
      assert.strictEqual(result.userId, userId);
      assert.strictEqual(result.email, 'magic@example.com');
    });

    it('should mark token as used after verification', () => {
      let { token } = magicLinks.generateMagicLink('magic@example.com', db);

      magicLinks.verifyMagicLink(token, db);

      let record = db.prepare('SELECT used_at FROM magic_link_tokens WHERE token = ?').get(token);
      assert.ok(record.used_at);
    });

    it('should reject already-used token', () => {
      let { token } = magicLinks.generateMagicLink('magic@example.com', db);

      magicLinks.verifyMagicLink(token, db);
      let second = magicLinks.verifyMagicLink(token, db);

      assert.strictEqual(second, null);
    });

    it('should reject expired token', () => {
      let { token } = magicLinks.generateMagicLink('magic@example.com', db);

      // Manually expire it using ISO format (matches what generateMagicLink stores)
      let pastDate = new Date(Date.now() - 3600000).toISOString();
      db.prepare('UPDATE magic_link_tokens SET expires_at = ? WHERE token = ?').run(pastDate, token);

      let result = magicLinks.verifyMagicLink(token, db);
      assert.strictEqual(result, null);
    });

    it('should reject nonexistent token', () => {
      let result = magicLinks.verifyMagicLink('nonexistent-token', db);
      assert.strictEqual(result, null);
    });

    it('should return null for empty token', () => {
      assert.strictEqual(magicLinks.verifyMagicLink('', db), null);
    });

    it('should return null for null token', () => {
      assert.strictEqual(magicLinks.verifyMagicLink(null, db), null);
    });

    it('should return userId null for unknown email token', () => {
      let { token } = magicLinks.generateMagicLink('unknown@example.com', db);
      let result    = magicLinks.verifyMagicLink(token, db);

      assert.ok(result);
      assert.strictEqual(result.userId, null);
      assert.strictEqual(result.email, 'unknown@example.com');
    });
  });

  // ===========================================================================
  // cleanExpiredTokens
  // ===========================================================================
  describe('cleanExpiredTokens()', () => {
    it('should delete expired tokens', () => {
      magicLinks.generateMagicLink('magic@example.com', db);

      // Manually expire it
      db.prepare("UPDATE magic_link_tokens SET expires_at = datetime('now', '-1 hour')").run();

      let deleted = magicLinks.cleanExpiredTokens(db);
      assert.strictEqual(deleted, 1);

      let count = db.prepare('SELECT COUNT(*) AS c FROM magic_link_tokens').get().c;
      assert.strictEqual(count, 0);
    });

    it('should delete used tokens', () => {
      let { token } = magicLinks.generateMagicLink('magic@example.com', db);
      magicLinks.verifyMagicLink(token, db);

      let deleted = magicLinks.cleanExpiredTokens(db);
      assert.strictEqual(deleted, 1);
    });

    it('should not delete valid unused tokens', () => {
      magicLinks.generateMagicLink('magic@example.com', db);

      let deleted = magicLinks.cleanExpiredTokens(db);
      assert.strictEqual(deleted, 0);

      let count = db.prepare('SELECT COUNT(*) AS c FROM magic_link_tokens').get().c;
      assert.strictEqual(count, 1);
    });
  });

  // ===========================================================================
  // sendEmail (stub)
  // ===========================================================================
  describe('sendEmail()', () => {
    it('should return email content', () => {
      let result = magicLinks.sendEmail('test@example.com', 'Test Subject', 'Test Body');

      assert.strictEqual(result.to, 'test@example.com');
      assert.strictEqual(result.subject, 'Test Subject');
      assert.strictEqual(result.body, 'Test Body');
    });
  });
});
