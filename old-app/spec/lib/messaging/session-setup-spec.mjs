'use strict';

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ============================================================================
// Environment Setup (must happen before any app module imports)
// ============================================================================

let testDir = mkdtempSync(join(tmpdir(), 'hero-session-setup-test-'));

process.env.HERO_JWT_SECRET = 'test-secret-key-for-testing';
process.env.HERO_ENCRYPTION_KEY = 'test-encryption-key-32chars!!';
process.env.XDG_CONFIG_HOME = testDir;

// Dynamic imports after env is configured
let setupSessionAgent;
let database;
let auth;
let encryption;

async function loadModules() {
  database = await import('../../../server/database.mjs');
  auth = await import('../../../server/auth.mjs');
  encryption = await import('../../../server/encryption.mjs');
  let mod = await import('../../../server/lib/messaging/session-setup.mjs');
  setupSessionAgent = mod.setupSessionAgent;
}

describe('session-setup', async () => {
  await loadModules();

  let db;
  let userId;
  let dataKey;

  beforeEach(async () => {
    db = database.getDatabase();

    // Clear test data for isolation
    db.exec('DELETE FROM frames');
    db.exec('DELETE FROM sessions');
    db.exec('DELETE FROM agents');
    db.exec('DELETE FROM processes');
    db.exec('DELETE FROM users');

    // Create and authenticate test user to get dataKey
    await auth.createUser('testuser', 'testpass');
    let authed = await auth.authenticateUser('testuser', 'testpass');
    userId = authed.id;
    dataKey = authed.secret.dataKey;
  });

  /**
   * Helper: create agent + session and return the joined session row.
   */
  function createSessionWithAgent(agentOverrides = {}) {
    let defaults = {
      name: 'test-agent',
      type: 'claude',
      encrypted_api_key: null,
      encrypted_config: null,
      default_processes: '[]',
    };
    let opts = { ...defaults, ...agentOverrides };

    let agentResult = db.prepare(`
      INSERT INTO agents (user_id, name, type, encrypted_api_key, encrypted_config, default_processes)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(userId, opts.name, opts.type, opts.encrypted_api_key, opts.encrypted_config, opts.default_processes);

    let agentId = Number(agentResult.lastInsertRowid);

    let sessionResult = db.prepare(`
      INSERT INTO sessions (user_id, agent_id, name)
      VALUES (?, ?, 'Test Session')
    `).run(userId, agentId);

    let sessionId = Number(sessionResult.lastInsertRowid);

    return db.prepare(`
      SELECT
        s.id,
        s.system_prompt,
        a.id as agent_id,
        a.type as agent_type,
        a.api_url as agent_api_url,
        a.encrypted_api_key,
        a.encrypted_config,
        a.default_processes
      FROM sessions s
      JOIN agents a ON s.agent_id = a.id
      WHERE s.id = ?
    `).get(sessionId);
  }

  describe('setupSessionAgent()', () => {
    it('should create an agent and return processedContent', () => {
      let session = createSessionWithAgent();

      let result = setupSessionAgent({
        session,
        userId,
        dataKey,
        content: 'Hello world',
      });

      assert.ok(result.agent);
      assert.strictEqual(typeof result.agent.sendMessage, 'function');
      assert.strictEqual(result.processedContent, 'Hello world');
      assert.ok(result.processMap instanceof Map);
    });

    it('should handle session with no API key', () => {
      let session = createSessionWithAgent();

      let result = setupSessionAgent({
        session,
        userId,
        dataKey,
        content: 'test',
      });

      assert.ok(result.agent);
    });

    it('should decrypt API key when provided', () => {
      let encryptedKey = encryption.encryptWithKey('sk-test-key-12345', dataKey);
      let session = createSessionWithAgent({ encrypted_api_key: encryptedKey });

      let result = setupSessionAgent({
        session,
        userId,
        dataKey,
        content: 'test',
      });

      assert.ok(result.agent);
    });

    it('should handle malformed default_processes gracefully', () => {
      let session = createSessionWithAgent({ default_processes: 'not-json' });

      let result = setupSessionAgent({
        session,
        userId,
        dataKey,
        content: 'test',
      });

      assert.ok(result.agent);
      assert.strictEqual(result.processMap.size, 0);
    });

    it('should handle malformed encrypted_config gracefully', () => {
      let badConfig = encryption.encryptWithKey('not-valid-json', dataKey);
      let session = createSessionWithAgent({ encrypted_config: badConfig });

      let result = setupSessionAgent({
        session,
        userId,
        dataKey,
        content: 'test',
      });

      assert.ok(result.agent);
    });

    it('should handle process names in default_processes', () => {
      // System processes require loadSystemProcesses() to be called first.
      // Without loading, they won't be in the map, but the function shouldn't throw.
      let session = createSessionWithAgent({ default_processes: '["_think"]' });

      let result = setupSessionAgent({
        session,
        userId,
        dataKey,
        content: 'test',
      });

      // _think is a valid system process name but may not be loaded in test context
      // The important thing is it doesn't throw
      assert.ok(result.processMap instanceof Map);
    });

    it('should return empty processMap for empty processes', () => {
      let session = createSessionWithAgent({ default_processes: '[]' });

      let result = setupSessionAgent({
        session,
        userId,
        dataKey,
        content: 'test',
      });

      assert.strictEqual(result.processMap.size, 0);
    });

    it('should return processMap as a Map', () => {
      let session = createSessionWithAgent();

      let result = setupSessionAgent({
        session,
        userId,
        dataKey,
        content: 'test',
      });

      assert.ok(result.processMap instanceof Map);
    });
  });
});
