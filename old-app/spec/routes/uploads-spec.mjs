'use strict';

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ============================================================================
// Environment Setup
// ============================================================================

let testDir = mkdtempSync(join(tmpdir(), 'hero-uploads-test-'));

process.env.HERO_JWT_SECRET     = 'test-secret-key-for-testing';
process.env.HERO_ENCRYPTION_KEY = 'test-encryption-key-32chars!!';
process.env.XDG_CONFIG_HOME     = testDir;

let database;
let auth;
let configPath;

async function loadModules() {
  database   = await import('../../server/database.mjs');
  auth       = await import('../../server/auth.mjs');
  configPath = await import('../../server/lib/config-path.mjs');
}

describe('Upload System', async () => {
  await loadModules();

  let db;
  let userId;
  let sessionId;

  beforeEach(async () => {
    db = database.getDatabase();

    db.exec('DELETE FROM uploads');
    db.exec('DELETE FROM frames');
    db.exec('DELETE FROM session_participants');
    db.exec('DELETE FROM sessions');
    db.exec('DELETE FROM agents');
    db.exec('DELETE FROM users');

    let user = await auth.createUser('uploaduser', 'testpass');
    userId = user.id;

    let agent = db.prepare(`
      INSERT INTO agents (user_id, name, type, encrypted_api_key)
      VALUES (?, 'test-agent', 'claude', 'fake-key')
    `).run(userId);
    let agentId = Number(agent.lastInsertRowid);

    let session = db.prepare(`
      INSERT INTO sessions (user_id, agent_id, name)
      VALUES (?, ?, 'Test Session')
    `).run(userId, agentId);
    sessionId = Number(session.lastInsertRowid);
  });

  // ===========================================================================
  // uploads table
  // ===========================================================================
  describe('uploads table', () => {
    it('should exist with correct columns', () => {
      let columns = db.prepare("PRAGMA table_info('uploads')").all();
      let names   = columns.map((c) => c.name);

      assert.ok(names.includes('id'));
      assert.ok(names.includes('user_id'));
      assert.ok(names.includes('session_id'));
      assert.ok(names.includes('filename'));
      assert.ok(names.includes('original_name'));
      assert.ok(names.includes('mime_type'));
      assert.ok(names.includes('size_bytes'));
      assert.ok(names.includes('storage_path'));
      assert.ok(names.includes('created_at'));
    });

    it('should enforce user_id foreign key', () => {
      assert.throws(() => {
        db.prepare(`
          INSERT INTO uploads (user_id, filename, original_name, mime_type, size_bytes, storage_path)
          VALUES (99999, 'test.txt', 'test.txt', 'text/plain', 100, '/tmp/test.txt')
        `).run();
      });
    });

    it('should allow inserting upload record', () => {
      let result = db.prepare(`
        INSERT INTO uploads (user_id, session_id, filename, original_name, mime_type, size_bytes, storage_path)
        VALUES (?, ?, 'abc123.png', 'photo.png', 'image/png', 54321, '/tmp/abc123.png')
      `).run(userId, sessionId);

      assert.ok(result.lastInsertRowid > 0);
    });

    it('should set session_id to NULL on session delete', () => {
      let result = db.prepare(`
        INSERT INTO uploads (user_id, session_id, filename, original_name, mime_type, size_bytes, storage_path)
        VALUES (?, ?, 'abc.png', 'photo.png', 'image/png', 100, '/tmp/abc.png')
      `).run(userId, sessionId);

      let uploadId = Number(result.lastInsertRowid);

      // Delete the session
      db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);

      // Upload should still exist but with NULL session_id
      let upload = db.prepare('SELECT * FROM uploads WHERE id = ?').get(uploadId);
      assert.ok(upload);
      assert.strictEqual(upload.session_id, null);
    });

    it('should delete uploads on user delete', () => {
      db.prepare(`
        INSERT INTO uploads (user_id, session_id, filename, original_name, mime_type, size_bytes, storage_path)
        VALUES (?, ?, 'abc.png', 'photo.png', 'image/png', 100, '/tmp/abc.png')
      `).run(userId, sessionId);

      // Delete the user (cascades)
      db.prepare('DELETE FROM users WHERE id = ?').run(userId);

      let uploads = db.prepare('SELECT * FROM uploads WHERE user_id = ?').all(userId);
      assert.strictEqual(uploads.length, 0);
    });
  });

  // ===========================================================================
  // agents avatar_url column
  // ===========================================================================
  describe('agents avatar_url column', () => {
    it('should exist on agents table', () => {
      let columns = db.prepare("PRAGMA table_info('agents')").all();
      let names   = columns.map((c) => c.name);
      assert.ok(names.includes('avatar_url'));
    });

    it('should default to NULL', () => {
      let agent = db.prepare('SELECT avatar_url FROM agents WHERE user_id = ?').get(userId);
      assert.strictEqual(agent.avatar_url, null);
    });

    it('should accept a URL value', () => {
      let agentId = db.prepare('SELECT id FROM agents WHERE user_id = ?').get(userId).id;
      db.prepare('UPDATE agents SET avatar_url = ? WHERE id = ?').run('https://example.com/avatar.png', agentId);
      let agent = db.prepare('SELECT avatar_url FROM agents WHERE id = ?').get(agentId);
      assert.strictEqual(agent.avatar_url, 'https://example.com/avatar.png');
    });
  });

  // ===========================================================================
  // Upload directory helpers
  // ===========================================================================
  describe('config-path upload helpers', () => {
    it('should return uploads dir path', () => {
      let dir = configPath.getUploadsDir();
      assert.ok(dir.endsWith('uploads'));
    });

    it('should create uploads dir', () => {
      let dir = configPath.ensureUploadsDir();
      assert.ok(existsSync(dir));
    });
  });

  // ===========================================================================
  // Upload CRUD
  // ===========================================================================
  describe('Upload CRUD', () => {
    it('should insert and retrieve an upload', () => {
      let result = db.prepare(`
        INSERT INTO uploads (user_id, session_id, filename, original_name, mime_type, size_bytes, storage_path)
        VALUES (?, ?, 'uuid.jpg', 'vacation.jpg', 'image/jpeg', 2048000, '/uploads/1/uuid.jpg')
      `).run(userId, sessionId);

      let upload = db.prepare('SELECT * FROM uploads WHERE id = ?').get(result.lastInsertRowid);
      assert.strictEqual(upload.original_name, 'vacation.jpg');
      assert.strictEqual(upload.mime_type, 'image/jpeg');
      assert.strictEqual(upload.size_bytes, 2048000);
    });

    it('should list uploads by session', () => {
      db.prepare(`
        INSERT INTO uploads (user_id, session_id, filename, original_name, mime_type, size_bytes, storage_path)
        VALUES (?, ?, 'a.jpg', 'a.jpg', 'image/jpeg', 100, '/tmp/a.jpg')
      `).run(userId, sessionId);

      db.prepare(`
        INSERT INTO uploads (user_id, session_id, filename, original_name, mime_type, size_bytes, storage_path)
        VALUES (?, ?, 'b.txt', 'b.txt', 'text/plain', 200, '/tmp/b.txt')
      `).run(userId, sessionId);

      let uploads = db.prepare('SELECT * FROM uploads WHERE session_id = ?').all(sessionId);
      assert.strictEqual(uploads.length, 2);
    });

    it('should delete an upload', () => {
      let result = db.prepare(`
        INSERT INTO uploads (user_id, session_id, filename, original_name, mime_type, size_bytes, storage_path)
        VALUES (?, ?, 'del.txt', 'del.txt', 'text/plain', 50, '/tmp/del.txt')
      `).run(userId, sessionId);

      db.prepare('DELETE FROM uploads WHERE id = ? AND user_id = ?').run(result.lastInsertRowid, userId);

      let upload = db.prepare('SELECT * FROM uploads WHERE id = ?').get(result.lastInsertRowid);
      assert.strictEqual(upload, undefined);
    });

    it('should not delete upload owned by different user', () => {
      let result = db.prepare(`
        INSERT INTO uploads (user_id, session_id, filename, original_name, mime_type, size_bytes, storage_path)
        VALUES (?, ?, 'owned.txt', 'owned.txt', 'text/plain', 50, '/tmp/owned.txt')
      `).run(userId, sessionId);

      let deleteResult = db.prepare('DELETE FROM uploads WHERE id = ? AND user_id = ?').run(result.lastInsertRowid, 99999);
      assert.strictEqual(deleteResult.changes, 0);

      // Should still exist
      let upload = db.prepare('SELECT * FROM uploads WHERE id = ?').get(result.lastInsertRowid);
      assert.ok(upload);
    });
  });
});
