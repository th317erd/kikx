'use strict';

// ============================================================================
// Auth Module Tests
// ============================================================================
// Tests for user authentication functions: createUser, authenticateUser,
// generateToken, verifyToken, changePassword, getUserById, getUserByUsername.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import jwt from 'jsonwebtoken';

// ============================================================================
// Environment Setup (must happen before any app module imports)
// ============================================================================

let testDir = mkdtempSync(join(tmpdir(), 'hero-auth-test-'));

process.env.HERO_JWT_SECRET = 'test-secret-key-for-testing';
process.env.HERO_ENCRYPTION_KEY = 'test-encryption-key-32chars!!';
process.env.XDG_CONFIG_HOME = testDir;

// Dynamic imports after env is configured
let auth;
let database;

async function loadModules() {
  database = await import('../../server/database.mjs');
  auth = await import('../../server/auth.mjs');
}

// ============================================================================
// Test Helpers
// ============================================================================

const TEST_USERNAME = 'testuser';
const TEST_PASSWORD = 'testpassword123';

async function createTestUser(username = TEST_USERNAME, password = TEST_PASSWORD) {
  return await auth.createUser(username, password);
}

// ============================================================================
// Tests
// ============================================================================

describe('Auth Module', async () => {
  // Load modules once before all tests
  await loadModules();

  beforeEach(() => {
    // Clear all users before each test for isolation
    let db = database.getDatabase();
    db.exec('DELETE FROM users');
  });

  // --------------------------------------------------------------------------
  // createUser
  // --------------------------------------------------------------------------

  describe('createUser', () => {
    it('should create a user successfully', async () => {
      let user = await createTestUser();
      assert.ok(user, 'createUser should return a user object');
    });

    it('should return user object with id and username', async () => {
      let user = await createTestUser();
      assert.ok(typeof user.id === 'number' || typeof user.id === 'bigint', 'user should have a numeric id');
      assert.equal(user.username, TEST_USERNAME);
    });

    it('should throw on duplicate username', async () => {
      await createTestUser();
      await assert.rejects(
        () => createTestUser(),
        { message: `User "${TEST_USERNAME}" already exists` },
      );
    });

    it('should hash the password (not store as plain text)', async () => {
      await createTestUser();
      let db = database.getDatabase();
      let row = db.prepare('SELECT password_hash FROM users WHERE username = ?').get(TEST_USERNAME);
      assert.ok(row.password_hash, 'password_hash should exist');
      assert.notEqual(row.password_hash, TEST_PASSWORD, 'password should not be stored as plain text');
      assert.ok(row.password_hash.includes(':'), 'password_hash should be in salt:hash format');
    });

    it('should store an encrypted secret', async () => {
      await createTestUser();
      let db = database.getDatabase();
      let row = db.prepare('SELECT encrypted_secret FROM users WHERE username = ?').get(TEST_USERNAME);
      assert.ok(row.encrypted_secret, 'encrypted_secret should exist');
      assert.ok(row.encrypted_secret.length > 0, 'encrypted_secret should not be empty');
    });
  });

  // --------------------------------------------------------------------------
  // authenticateUser
  // --------------------------------------------------------------------------

  describe('authenticateUser', () => {
    it('should return user object for valid credentials', async () => {
      await createTestUser();
      let result = await auth.authenticateUser(TEST_USERNAME, TEST_PASSWORD);
      assert.ok(result, 'authenticateUser should return a user object');
      assert.equal(result.username, TEST_USERNAME);
    });

    it('should return null for wrong password', async () => {
      await createTestUser();
      let result = await auth.authenticateUser(TEST_USERNAME, 'wrongpassword');
      assert.equal(result, null);
    });

    it('should return null for non-existent user', async () => {
      let result = await auth.authenticateUser('nonexistent', 'somepassword');
      assert.equal(result, null);
    });

    it('should return user with secret containing dataKey', async () => {
      await createTestUser();
      let result = await auth.authenticateUser(TEST_USERNAME, TEST_PASSWORD);
      assert.ok(result.secret, 'authenticated user should have a secret');
      assert.ok(result.secret.dataKey, 'secret should contain a dataKey');
      assert.equal(typeof result.secret.dataKey, 'string');
      assert.equal(result.secret.dataKey.length, 64, 'dataKey should be a 64-char hex string (256-bit key)');
    });

    it('should return user with correct id', async () => {
      let created = await createTestUser();
      let result = await auth.authenticateUser(TEST_USERNAME, TEST_PASSWORD);
      assert.equal(Number(result.id), Number(created.id));
    });
  });

  // --------------------------------------------------------------------------
  // generateToken
  // --------------------------------------------------------------------------

  describe('generateToken', () => {
    it('should return a string JWT token', async () => {
      await createTestUser();
      let user = await auth.authenticateUser(TEST_USERNAME, TEST_PASSWORD);
      let token = auth.generateToken(user);
      assert.equal(typeof token, 'string');
      assert.ok(token.length > 0, 'token should not be empty');
    });

    it('should produce a token with three dot-separated parts', async () => {
      await createTestUser();
      let user = await auth.authenticateUser(TEST_USERNAME, TEST_PASSWORD);
      let token = auth.generateToken(user);
      let parts = token.split('.');
      assert.equal(parts.length, 3, 'JWT should have 3 parts: header.payload.signature');
    });

    it('should contain user id as sub in token payload', async () => {
      await createTestUser();
      let user = await auth.authenticateUser(TEST_USERNAME, TEST_PASSWORD);
      let token = auth.generateToken(user);
      let decoded = jwt.decode(token);
      assert.equal(Number(decoded.sub), Number(user.id));
    });

    it('should contain username in token payload', async () => {
      await createTestUser();
      let user = await auth.authenticateUser(TEST_USERNAME, TEST_PASSWORD);
      let token = auth.generateToken(user);
      let decoded = jwt.decode(token);
      assert.equal(decoded.username, TEST_USERNAME);
    });

    it('should contain secret in token payload', async () => {
      await createTestUser();
      let user = await auth.authenticateUser(TEST_USERNAME, TEST_PASSWORD);
      let token = auth.generateToken(user);
      let decoded = jwt.decode(token);
      assert.ok(decoded.secret, 'token payload should contain secret');
      assert.ok(decoded.secret.dataKey, 'token secret should contain dataKey');
    });
  });

  // --------------------------------------------------------------------------
  // verifyToken
  // --------------------------------------------------------------------------

  describe('verifyToken', () => {
    it('should decode a valid token', async () => {
      await createTestUser();
      let user = await auth.authenticateUser(TEST_USERNAME, TEST_PASSWORD);
      let token = auth.generateToken(user);
      let decoded = auth.verifyToken(token);
      assert.ok(decoded, 'verifyToken should return decoded payload');
      assert.equal(Number(decoded.sub), Number(user.id));
      assert.equal(decoded.username, TEST_USERNAME);
    });

    it('should return null for invalid token', () => {
      let result = auth.verifyToken('not.a.valid.jwt.token');
      assert.equal(result, null);
    });

    it('should return null for tampered token', async () => {
      await createTestUser();
      let user = await auth.authenticateUser(TEST_USERNAME, TEST_PASSWORD);
      let token = auth.generateToken(user);
      // Tamper with the payload
      let parts = token.split('.');
      parts[1] = parts[1] + 'tampered';
      let tamperedToken = parts.join('.');
      let result = auth.verifyToken(tamperedToken);
      assert.equal(result, null);
    });

    it('should return null for expired token', () => {
      // Sign a token that expires immediately
      let payload = { sub: 1, username: 'expired-user' };
      let expiredToken = jwt.sign(payload, process.env.HERO_JWT_SECRET, { expiresIn: '0s' });
      let result = auth.verifyToken(expiredToken);
      assert.equal(result, null);
    });

    it('should return null for token signed with wrong secret', () => {
      let payload = { sub: 1, username: 'wrong-secret-user' };
      let badToken = jwt.sign(payload, 'completely-wrong-secret-key');
      let result = auth.verifyToken(badToken);
      assert.equal(result, null);
    });
  });

  // --------------------------------------------------------------------------
  // changePassword
  // --------------------------------------------------------------------------

  describe('changePassword', () => {
    it('should successfully change password', async () => {
      await createTestUser();
      let result = await auth.changePassword(TEST_USERNAME, TEST_PASSWORD, 'newpassword456');
      assert.equal(result, true);
    });

    it('should make old password no longer work after change', async () => {
      await createTestUser();
      await auth.changePassword(TEST_USERNAME, TEST_PASSWORD, 'newpassword456');
      let result = await auth.authenticateUser(TEST_USERNAME, TEST_PASSWORD);
      assert.equal(result, null, 'old password should no longer authenticate');
    });

    it('should make new password work after change', async () => {
      await createTestUser();
      await auth.changePassword(TEST_USERNAME, TEST_PASSWORD, 'newpassword456');
      let result = await auth.authenticateUser(TEST_USERNAME, 'newpassword456');
      assert.ok(result, 'new password should authenticate');
      assert.equal(result.username, TEST_USERNAME);
    });

    it('should preserve the dataKey after password change', async () => {
      await createTestUser();
      let beforeChange = await auth.authenticateUser(TEST_USERNAME, TEST_PASSWORD);
      await auth.changePassword(TEST_USERNAME, TEST_PASSWORD, 'newpassword456');
      let afterChange = await auth.authenticateUser(TEST_USERNAME, 'newpassword456');
      assert.equal(afterChange.secret.dataKey, beforeChange.secret.dataKey, 'dataKey should survive password change');
    });

    it('should throw for wrong current password', async () => {
      await createTestUser();
      await assert.rejects(
        () => auth.changePassword(TEST_USERNAME, 'wrongpassword', 'newpassword456'),
        { message: 'Invalid current password' },
      );
    });

    it('should throw for non-existent user', async () => {
      await assert.rejects(
        () => auth.changePassword('nonexistent', 'old', 'new'),
        { message: 'User "nonexistent" not found' },
      );
    });
  });

  // --------------------------------------------------------------------------
  // getUserById
  // --------------------------------------------------------------------------

  describe('getUserById', () => {
    it('should return user for valid id', async () => {
      let created = await createTestUser();
      let user = auth.getUserById(Number(created.id));
      assert.ok(user, 'getUserById should return a user');
      assert.equal(user.username, TEST_USERNAME);
      assert.equal(Number(user.id), Number(created.id));
    });

    it('should return undefined for invalid id', () => {
      // getDatabase() call inside getUserById triggers DB creation via migrations
      let user = auth.getUserById(99999);
      assert.equal(user, undefined);
    });

    it('should not return password_hash or encrypted_secret', async () => {
      let created = await createTestUser();
      let user = auth.getUserById(Number(created.id));
      assert.equal(user.password_hash, undefined, 'should not expose password_hash');
      assert.equal(user.encrypted_secret, undefined, 'should not expose encrypted_secret');
    });

    it('should return created_at and updated_at timestamps', async () => {
      let created = await createTestUser();
      let user = auth.getUserById(Number(created.id));
      assert.ok(user.created_at, 'should have created_at');
      assert.ok(user.updated_at, 'should have updated_at');
    });
  });

  // --------------------------------------------------------------------------
  // getUserByUsername
  // --------------------------------------------------------------------------

  describe('getUserByUsername', () => {
    it('should return user for valid username', async () => {
      let created = await createTestUser();
      let user = auth.getUserByUsername(TEST_USERNAME);
      assert.ok(user, 'getUserByUsername should return a user');
      assert.equal(user.username, TEST_USERNAME);
      assert.equal(Number(user.id), Number(created.id));
    });

    it('should return undefined for non-existent username', () => {
      let user = auth.getUserByUsername('nonexistent');
      assert.equal(user, undefined);
    });

    it('should not return sensitive fields', async () => {
      await createTestUser();
      let user = auth.getUserByUsername(TEST_USERNAME);
      assert.equal(user.password_hash, undefined, 'should not expose password_hash');
      assert.equal(user.encrypted_secret, undefined, 'should not expose encrypted_secret');
    });
  });
});
