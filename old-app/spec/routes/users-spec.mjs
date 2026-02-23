'use strict';

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ============================================================================
// Environment Setup
// ============================================================================

let testDir = mkdtempSync(join(tmpdir(), 'hero-users-route-test-'));

process.env.HERO_JWT_SECRET     = 'test-secret-key-for-testing';
process.env.HERO_ENCRYPTION_KEY = 'test-encryption-key-32chars!!';
process.env.XDG_CONFIG_HOME     = testDir;

let database;
let auth;
let apiKeys;
let magicLinks;
let express;

async function loadModules() {
  database   = await import('../../server/database.mjs');
  auth       = await import('../../server/auth.mjs');
  apiKeys    = await import('../../server/lib/auth/api-keys.mjs');
  magicLinks = await import('../../server/lib/auth/magic-links.mjs');
  express    = (await import('express')).default;
}

/**
 * Create a test Express app with auth bypass.
 */
function createTestApp(userId, username = 'testuser') {
  let app = express();
  app.use(express.json());

  // Auth bypass
  app.use((req, res, next) => {
    req.user = { id: userId, username: username, secret: { dataKey: 'test-key' } };
    next();
  });

  return app;
}

/**
 * Make a request to the test app.
 */
function makeRequest(app, method, path, body) {
  return new Promise((resolve, reject) => {
    let server = app.listen(0, () => {
      let port    = server.address().port;
      let url     = `http://localhost:${port}${path}`;
      let options = {
        method,
        headers: { 'Content-Type': 'application/json' },
      };

      if (body) options.body = JSON.stringify(body);

      fetch(url, options)
        .then(async (res) => {
          let responseBody = await res.json();
          server.close();
          resolve({ status: res.status, body: responseBody });
        })
        .catch((err) => {
          server.close();
          reject(err);
        });
    });
  });
}

describe('User Routes (Phase 6)', async () => {
  await loadModules();

  let db;
  let userId;
  let otherUserId;

  beforeEach(async () => {
    db = database.getDatabase();

    db.exec('DELETE FROM api_keys');
    db.exec('DELETE FROM magic_link_tokens');
    db.exec('DELETE FROM token_charges');
    db.exec('DELETE FROM frames');
    db.exec('DELETE FROM session_participants');
    db.exec('DELETE FROM sessions');
    db.exec('DELETE FROM agents');
    db.exec('DELETE FROM users');

    let user1 = await auth.createUser('routeuser', 'testpass');
    userId = user1.id;

    let user2 = await auth.createUser('otheruser', 'testpass');
    otherUserId = user2.id;

    // Set email + display name
    db.prepare('UPDATE users SET email = ?, display_name = ? WHERE id = ?')
      .run('route@example.com', 'Route User', userId);
  });

  // ===========================================================================
  // GET /users/me/profile
  // ===========================================================================
  describe('GET /users/me/profile', () => {
    it('should return user profile', async () => {
      let app = createTestApp(userId, 'routeuser');
      app.get('/users/me/profile', (req, res) => {
        let user = db.prepare('SELECT id, username, email, display_name, created_at, updated_at FROM users WHERE id = ?').get(req.user.id);
        let usage = db.prepare(`
          SELECT COALESCE(SUM(tc.input_tokens), 0) AS totalInputTokens,
                 COALESCE(SUM(tc.output_tokens), 0) AS totalOutputTokens,
                 COALESCE(SUM(tc.cost_cents), 0) AS totalCostCents,
                 COUNT(*) AS totalCharges
          FROM token_charges tc
          JOIN agents a ON tc.agent_id = a.id
          WHERE a.user_id = ?
        `).get(req.user.id);
        res.json({
          id: user.id, username: user.username, email: user.email,
          displayName: user.display_name, createdAt: user.created_at,
          usage: { totalInputTokens: usage.totalInputTokens, totalOutputTokens: usage.totalOutputTokens,
                   totalCostCents: usage.totalCostCents, totalCharges: usage.totalCharges },
        });
      });

      let res = await makeRequest(app, 'GET', '/users/me/profile');

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.username, 'routeuser');
      assert.strictEqual(res.body.email, 'route@example.com');
      assert.strictEqual(res.body.displayName, 'Route User');
      assert.ok(res.body.createdAt);
      assert.ok(res.body.usage);
      assert.strictEqual(res.body.usage.totalCharges, 0);
    });

    it('should include usage stats when charges exist', async () => {
      // Add a token charge
      let agent = db.prepare(`INSERT INTO agents (user_id, name, type, encrypted_api_key) VALUES (?, 'test-agent', 'claude', 'fake')`).run(userId);
      let agentId = Number(agent.lastInsertRowid);
      let session = db.prepare('INSERT INTO sessions (user_id, agent_id, name) VALUES (?, ?, ?)').run(userId, agentId, 'Test');
      let sessionId = Number(session.lastInsertRowid);

      db.prepare(`
        INSERT INTO token_charges (agent_id, session_id, input_tokens, output_tokens, cost_cents)
        VALUES (?, ?, 100, 50, 500)
      `).run(agentId, sessionId);

      let app = createTestApp(userId);
      app.get('/users/me/profile', (req, res) => {
        let usage = db.prepare(`
          SELECT COALESCE(SUM(tc.input_tokens), 0) AS totalInputTokens,
                 COALESCE(SUM(tc.output_tokens), 0) AS totalOutputTokens,
                 COALESCE(SUM(tc.cost_cents), 0) AS totalCostCents,
                 COUNT(*) AS totalCharges
          FROM token_charges tc
          JOIN agents a ON tc.agent_id = a.id
          WHERE a.user_id = ?
        `).get(req.user.id);
        res.json({ usage });
      });

      let res = await makeRequest(app, 'GET', '/users/me/profile');

      assert.strictEqual(res.body.usage.totalInputTokens, 100);
      assert.strictEqual(res.body.usage.totalOutputTokens, 50);
      assert.strictEqual(res.body.usage.totalCostCents, 500);
      assert.strictEqual(res.body.usage.totalCharges, 1);
    });
  });

  // ===========================================================================
  // PUT /users/me/profile
  // ===========================================================================
  describe('PUT /users/me/profile', () => {
    it('should update display name', async () => {
      let app = createTestApp(userId);
      app.put('/users/me/profile', (req, res) => {
        if (req.body.displayName !== undefined) {
          db.prepare('UPDATE users SET display_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
            .run(req.body.displayName, req.user.id);
        }
        let user = db.prepare('SELECT display_name FROM users WHERE id = ?').get(req.user.id);
        res.json({ displayName: user.display_name });
      });

      let res = await makeRequest(app, 'PUT', '/users/me/profile', { displayName: 'New Name' });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.displayName, 'New Name');
    });

    it('should update email', async () => {
      let app = createTestApp(userId);
      app.put('/users/me/profile', (req, res) => {
        if (req.body.email !== undefined) {
          let email = req.body.email.trim().toLowerCase();
          db.prepare('UPDATE users SET email = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
            .run(email, req.user.id);
        }
        let user = db.prepare('SELECT email FROM users WHERE id = ?').get(req.user.id);
        res.json({ email: user.email });
      });

      let res = await makeRequest(app, 'PUT', '/users/me/profile', { email: 'new@example.com' });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.email, 'new@example.com');
    });

    it('should allow clearing display name', async () => {
      let app = createTestApp(userId);
      app.put('/users/me/profile', (req, res) => {
        if (req.body.displayName !== undefined) {
          db.prepare('UPDATE users SET display_name = ? WHERE id = ?')
            .run(req.body.displayName, req.user.id);
        }
        let user = db.prepare('SELECT display_name FROM users WHERE id = ?').get(req.user.id);
        res.json({ displayName: user.display_name });
      });

      let res = await makeRequest(app, 'PUT', '/users/me/profile', { displayName: null });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.displayName, null);
    });
  });

  // ===========================================================================
  // API Keys routes
  // ===========================================================================
  describe('API Keys routes', () => {
    it('should create and list API keys', async () => {
      let app = createTestApp(userId);
      app.post('/users/me/api-keys', (req, res) => {
        let result = apiKeys.createApiKey(req.user.id, req.body.name, {
          scopes: req.body.scopes, expiresAt: req.body.expiresAt,
        }, db);
        res.status(201).json(result);
      });
      app.get('/users/me/api-keys', (req, res) => {
        res.json({ keys: apiKeys.listApiKeys(req.user.id, db) });
      });

      let createRes = await makeRequest(app, 'POST', '/users/me/api-keys', { name: 'Test Key' });
      assert.strictEqual(createRes.status, 201);
      assert.ok(createRes.body.key);
      assert.ok(createRes.body.key.startsWith('hero_'));

      let listRes = await makeRequest(app, 'GET', '/users/me/api-keys');
      assert.strictEqual(listRes.body.keys.length, 1);
      assert.strictEqual(listRes.body.keys[0].name, 'Test Key');
      assert.strictEqual(listRes.body.keys[0].key, undefined);
    });

    it('should revoke API key', async () => {
      let created = apiKeys.createApiKey(userId, 'Revoke Me', {}, db);

      let app = createTestApp(userId);
      app.delete('/users/me/api-keys/:id', (req, res) => {
        let deleted = apiKeys.revokeApiKey(req.user.id, parseInt(req.params.id, 10), db);
        if (!deleted) return res.status(404).json({ error: 'Not found' });
        res.json({ success: true });
      });

      let res = await makeRequest(app, 'DELETE', `/users/me/api-keys/${created.id}`);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);

      assert.strictEqual(apiKeys.listApiKeys(userId, db).length, 0);
    });

    it('should return 404 for nonexistent key', async () => {
      let app = createTestApp(userId);
      app.delete('/users/me/api-keys/:id', (req, res) => {
        let deleted = apiKeys.revokeApiKey(req.user.id, parseInt(req.params.id, 10), db);
        if (!deleted) return res.status(404).json({ error: 'Not found' });
        res.json({ success: true });
      });

      let res = await makeRequest(app, 'DELETE', '/users/me/api-keys/99999');
      assert.strictEqual(res.status, 404);
    });
  });

  // ===========================================================================
  // Magic Link routes
  // ===========================================================================
  describe('Magic Link routes', () => {
    it('should generate a magic link', async () => {
      db.prepare('UPDATE users SET email = ? WHERE id = ?').run('magic@test.com', userId);

      let app = express();
      app.use(express.json());
      app.post('/users/auth/magic-link/request', (req, res) => {
        try {
          let result = magicLinks.generateMagicLink(req.body.email, db);
          res.json({ success: true, expiresAt: result.expiresAt });
        } catch (error) {
          res.status(400).json({ error: error.message });
        }
      });

      let res = await makeRequest(app, 'POST', '/users/auth/magic-link/request', { email: 'magic@test.com' });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);
      assert.ok(res.body.expiresAt);
    });

    it('should verify a magic link', async () => {
      db.prepare('UPDATE users SET email = ? WHERE id = ?').run('verify@test.com', userId);
      let { token } = magicLinks.generateMagicLink('verify@test.com', db);

      let app = express();
      app.use(express.json());
      app.get('/users/auth/magic-link/verify', (req, res) => {
        let result = magicLinks.verifyMagicLink(req.query.token, db);
        if (!result) return res.status(401).json({ error: 'Invalid token' });
        if (!result.userId) return res.status(404).json({ error: 'No user' });
        res.json({ success: true, userId: result.userId });
      });

      let res = await makeRequest(app, 'GET', `/users/auth/magic-link/verify?token=${token}`);

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);
      assert.strictEqual(res.body.userId, userId);
    });

    it('should reject invalid magic link', async () => {
      let app = express();
      app.use(express.json());
      app.get('/users/auth/magic-link/verify', (req, res) => {
        let result = magicLinks.verifyMagicLink(req.query.token, db);
        if (!result) return res.status(401).json({ error: 'Invalid token' });
        res.json({ success: true });
      });

      let res = await makeRequest(app, 'GET', '/users/auth/magic-link/verify?token=invalid');

      assert.strictEqual(res.status, 401);
    });
  });

  // ===========================================================================
  // Password change
  // ===========================================================================
  describe('PUT /users/me/password', () => {
    it('should change password with valid current password', async () => {
      let app = createTestApp(userId, 'routeuser');
      app.put('/users/me/password', async (req, res) => {
        try {
          await auth.changePassword(req.user.username, req.body.currentPassword, req.body.newPassword);
          res.json({ success: true });
        } catch (error) {
          if (error.message.includes('Invalid current password'))
            return res.status(401).json({ error: 'Invalid current password' });
          res.status(500).json({ error: 'Failed' });
        }
      });

      let res = await makeRequest(app, 'PUT', '/users/me/password', {
        currentPassword: 'testpass',
        newPassword:     'newpassword123',
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);

      // Verify new password works
      let authed = await auth.authenticateUser('routeuser', 'newpassword123');
      assert.ok(authed);
    });

    it('should reject wrong current password', async () => {
      let app = createTestApp(userId, 'routeuser');
      app.put('/users/me/password', async (req, res) => {
        try {
          await auth.changePassword(req.user.username, req.body.currentPassword, req.body.newPassword);
          res.json({ success: true });
        } catch (error) {
          if (error.message.includes('Invalid current password'))
            return res.status(401).json({ error: 'Invalid current password' });
          res.status(500).json({ error: 'Failed' });
        }
      });

      let res = await makeRequest(app, 'PUT', '/users/me/password', {
        currentPassword: 'wrongpass',
        newPassword:     'newpassword123',
      });

      assert.strictEqual(res.status, 401);
    });
  });
});
