'use strict';

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ============================================================================
// Environment Setup
// ============================================================================

let testDir = mkdtempSync(join(tmpdir(), 'hero-pagination-test-'));

process.env.HERO_JWT_SECRET     = 'test-secret-key-for-testing';
process.env.HERO_ENCRYPTION_KEY = 'test-encryption-key-32chars!!';
process.env.XDG_CONFIG_HOME     = testDir;

let database;
let auth;
let frames;

async function loadModules() {
  database = await import('../../../server/database.mjs');
  auth     = await import('../../../server/auth.mjs');
  frames   = await import('../../../server/lib/frames/index.mjs');
}

describe('Frames Pagination (Phase 5)', async () => {
  await loadModules();

  let db;
  let userId;
  let sessionId;

  beforeEach(async () => {
    db = database.getDatabase();

    // Clear test data
    db.exec('DELETE FROM frames');
    db.exec('DELETE FROM session_participants');
    db.exec('DELETE FROM sessions');
    db.exec('DELETE FROM agents');
    db.exec('DELETE FROM users');

    // Create test user and session
    let user = await auth.createUser('testuser', 'testpass');
    userId   = user.id;

    let agentResult = db.prepare(`
      INSERT INTO agents (user_id, name, type, encrypted_api_key)
      VALUES (?, 'test-agent', 'claude', 'fake-key')
    `).run(userId);
    let agentId = Number(agentResult.lastInsertRowid);

    let sessionResult = db.prepare(`
      INSERT INTO sessions (user_id, agent_id, name)
      VALUES (?, ?, 'Test Session')
    `).run(userId, agentId);
    sessionId = Number(sessionResult.lastInsertRowid);
  });

  /**
   * Helper: create N message frames with sequential timestamps.
   */
  function createTestFrames(count, baseMs = 1700000000000) {
    let created = [];
    for (let i = 0; i < count; i++) {
      let frame = frames.createFrame({
        sessionId:  sessionId,
        type:       'message',
        authorType: (i % 2 === 0) ? 'user' : 'agent',
        authorId:   userId,
        payload:    { role: (i % 2 === 0) ? 'user' : 'assistant', content: `Message ${i}`, hidden: false },
      }, db);
      created.push(frame);
    }
    return created;
  }

  // ===========================================================================
  // beforeTimestamp (backward pagination)
  // ===========================================================================
  describe('getFrames() with beforeTimestamp', () => {
    it('should return frames before a timestamp', () => {
      let created = createTestFrames(10);

      // Get frames before the 6th frame's timestamp
      let result = frames.getFrames(sessionId, {
        beforeTimestamp: created[5].timestamp,
      }, db);

      assert.strictEqual(result.length, 5);
      assert.strictEqual(result[0].payload.content, 'Message 0');
      assert.strictEqual(result[4].payload.content, 'Message 4');
    });

    it('should return empty array when no frames before timestamp', () => {
      let created = createTestFrames(5);

      let result = frames.getFrames(sessionId, {
        beforeTimestamp: created[0].timestamp,
      }, db);

      assert.strictEqual(result.length, 0);
    });

    it('should respect limit with beforeTimestamp', () => {
      let created = createTestFrames(10);

      // Get last 3 frames before the 8th
      let result = frames.getFrames(sessionId, {
        beforeTimestamp: created[7].timestamp,
        limit:          3,
      }, db);

      // Should return the 3 most recent frames before timestamp (in ASC order)
      assert.strictEqual(result.length, 3);
      assert.strictEqual(result[0].payload.content, 'Message 4');
      assert.strictEqual(result[1].payload.content, 'Message 5');
      assert.strictEqual(result[2].payload.content, 'Message 6');
    });

    it('should return frames in ascending timestamp order', () => {
      let created = createTestFrames(10);

      let result = frames.getFrames(sessionId, {
        beforeTimestamp: created[5].timestamp,
        limit:          3,
      }, db);

      // Verify ascending order
      for (let i = 1; i < result.length; i++) {
        assert.ok(result[i].timestamp > result[i - 1].timestamp,
          `Frame ${i} should be after frame ${i - 1}`);
      }
    });

    it('should combine beforeTimestamp with type filter', () => {
      let created = createTestFrames(10);

      // Add a compact frame in the middle
      frames.createFrame({
        sessionId:  sessionId,
        type:       'compact',
        authorType: 'system',
        payload:    { context: 'test compaction', snapshot: {} },
      }, db);

      let result = frames.getFrames(sessionId, {
        beforeTimestamp: created[9].timestamp,
        types:          ['message'],
      }, db);

      // Should only return message frames
      for (let frame of result) {
        assert.strictEqual(frame.type, 'message');
      }
    });
  });

  // ===========================================================================
  // Combined forward + backward pagination
  // ===========================================================================
  describe('Forward and backward pagination together', () => {
    it('should support fromTimestamp + limit for forward pagination', () => {
      let created = createTestFrames(10);

      let result = frames.getFrames(sessionId, {
        fromTimestamp: created[4].timestamp,
        limit:        3,
      }, db);

      assert.strictEqual(result.length, 3);
      assert.strictEqual(result[0].payload.content, 'Message 5');
      assert.strictEqual(result[1].payload.content, 'Message 6');
      assert.strictEqual(result[2].payload.content, 'Message 7');
    });

    it('should handle window between fromTimestamp and beforeTimestamp', () => {
      let created = createTestFrames(10);

      let result = frames.getFrames(sessionId, {
        fromTimestamp:   created[2].timestamp,
        beforeTimestamp: created[7].timestamp,
      }, db);

      assert.strictEqual(result.length, 4);
      assert.strictEqual(result[0].payload.content, 'Message 3');
      assert.strictEqual(result[3].payload.content, 'Message 6');
    });
  });

  // ===========================================================================
  // countFrames (for hasMore detection)
  // ===========================================================================
  describe('countFrames()', () => {
    it('should count all frames for a session', () => {
      createTestFrames(7);

      let count = frames.countFrames(sessionId, {}, db);

      assert.strictEqual(count, 7);
    });

    it('should count with type filter', () => {
      createTestFrames(5);

      // Add a compact frame
      frames.createFrame({
        sessionId:  sessionId,
        type:       'compact',
        authorType: 'system',
        payload:    { context: 'compaction', snapshot: {} },
      }, db);

      let messageCount = frames.countFrames(sessionId, { types: ['message'] }, db);
      let compactCount = frames.countFrames(sessionId, { types: ['compact'] }, db);

      assert.strictEqual(messageCount, 5);
      assert.strictEqual(compactCount, 1);
    });
  });
});
