'use strict';

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ============================================================================
// Environment Setup
// ============================================================================

let testDir = mkdtempSync(join(tmpdir(), 'hero-search-test-'));

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

describe('Frames Search (Phase 5)', async () => {
  await loadModules();

  let db;
  let userId;
  let otherUserId;
  let session1Id;
  let session2Id;
  let otherSessionId;

  beforeEach(async () => {
    db = database.getDatabase();

    // Clear test data
    db.exec('DELETE FROM frames');
    db.exec('DELETE FROM session_participants');
    db.exec('DELETE FROM sessions');
    db.exec('DELETE FROM agents');
    db.exec('DELETE FROM users');

    // Create users
    let user1 = await auth.createUser('searchuser1', 'testpass');
    userId = user1.id;

    let user2 = await auth.createUser('searchuser2', 'testpass');
    otherUserId = user2.id;

    // Create agents
    let agent1 = db.prepare(`
      INSERT INTO agents (user_id, name, type, encrypted_api_key)
      VALUES (?, 'test-agent-1', 'claude', 'fake-key')
    `).run(userId);
    let agentId = Number(agent1.lastInsertRowid);

    let agent2 = db.prepare(`
      INSERT INTO agents (user_id, name, type, encrypted_api_key)
      VALUES (?, 'test-agent-2', 'claude', 'fake-key')
    `).run(otherUserId);
    let otherAgentId = Number(agent2.lastInsertRowid);

    // Create sessions
    let s1 = db.prepare(`INSERT INTO sessions (user_id, agent_id, name) VALUES (?, ?, 'Session Alpha')`).run(userId, agentId);
    session1Id = Number(s1.lastInsertRowid);

    let s2 = db.prepare(`INSERT INTO sessions (user_id, agent_id, name) VALUES (?, ?, 'Session Beta')`).run(userId, agentId);
    session2Id = Number(s2.lastInsertRowid);

    let s3 = db.prepare(`INSERT INTO sessions (user_id, agent_id, name) VALUES (?, ?, 'Other Session')`).run(otherUserId, otherAgentId);
    otherSessionId = Number(s3.lastInsertRowid);

    // Populate frames across sessions
    frames.createFrame({
      sessionId: session1Id, type: 'message', authorType: 'user', authorId: userId,
      payload: { role: 'user', content: 'How do I implement quicksort?', hidden: false },
    }, db);

    frames.createFrame({
      sessionId: session1Id, type: 'message', authorType: 'agent', authorId: agentId,
      payload: { role: 'assistant', content: 'Quicksort uses a pivot element to partition the array.', hidden: false },
    }, db);

    frames.createFrame({
      sessionId: session2Id, type: 'message', authorType: 'user', authorId: userId,
      payload: { role: 'user', content: 'What about merge sort?', hidden: false },
    }, db);

    frames.createFrame({
      sessionId: session2Id, type: 'message', authorType: 'agent', authorId: agentId,
      payload: { role: 'assistant', content: 'Merge sort divides the array in half recursively.', hidden: false },
    }, db);

    // Hidden message (should still be searchable)
    frames.createFrame({
      sessionId: session1Id, type: 'message', authorType: 'system',
      payload: { role: 'system', content: 'System context about sorting algorithms', hidden: true },
    }, db);

    // Other user's frames (should NOT appear in search)
    frames.createFrame({
      sessionId: otherSessionId, type: 'message', authorType: 'user', authorId: otherUserId,
      payload: { role: 'user', content: 'Quicksort is my favorite algorithm', hidden: false },
    }, db);
  });

  // ===========================================================================
  // searchFrames
  // ===========================================================================
  describe('searchFrames()', () => {
    it('should find frames matching query text', () => {
      let results = frames.searchFrames(userId, 'quicksort', {}, db);

      assert.ok(results.length >= 2);
      for (let result of results) {
        let content = JSON.stringify(result.payload);
        assert.ok(content.toLowerCase().includes('quicksort'),
          `Result should contain "quicksort": ${content}`);
      }
    });

    it('should only return frames owned by the user', () => {
      let results = frames.searchFrames(userId, 'quicksort', {}, db);

      // Should find user1's frames but NOT user2's
      for (let result of results) {
        assert.notStrictEqual(result.sessionId, otherSessionId,
          'Should not include frames from other users');
      }
    });

    it('should scope search to specific session', () => {
      let results = frames.searchFrames(userId, 'sort', { sessionId: session1Id }, db);

      for (let result of results) {
        assert.strictEqual(result.sessionId, session1Id);
      }
    });

    it('should search across all user sessions when no sessionId', () => {
      let results = frames.searchFrames(userId, 'sort', {}, db);

      let sessionIds = new Set(results.map((r) => r.sessionId));
      assert.ok(sessionIds.has(session1Id), 'Should include session 1');
      assert.ok(sessionIds.has(session2Id), 'Should include session 2');
    });

    it('should include session name in results', () => {
      let results = frames.searchFrames(userId, 'quicksort', {}, db);

      assert.ok(results.length > 0);
      let sessionNames = results.map((r) => r.sessionName);
      assert.ok(sessionNames.includes('Session Alpha'));
    });

    it('should respect limit', () => {
      let results = frames.searchFrames(userId, 'sort', { limit: 2 }, db);

      assert.ok(results.length <= 2);
    });

    it('should support offset for pagination', () => {
      let allResults  = frames.searchFrames(userId, 'sort', {}, db);
      let pageResults = frames.searchFrames(userId, 'sort', { offset: 1, limit: 2 }, db);

      if (allResults.length > 1) {
        assert.strictEqual(pageResults[0].id, allResults[1].id);
      }
    });

    it('should filter by frame type', () => {
      // Add a request frame with sort-related content
      frames.createFrame({
        sessionId: session1Id, type: 'request', authorType: 'agent',
        payload: { action: 'websearch', query: 'sorting algorithms comparison' },
      }, db);

      let messageOnly = frames.searchFrames(userId, 'sort', { types: ['message'] }, db);
      let requestOnly = frames.searchFrames(userId, 'sort', { types: ['request'] }, db);

      for (let r of messageOnly) assert.strictEqual(r.type, 'message');
      for (let r of requestOnly) assert.strictEqual(r.type, 'request');
    });

    it('should return empty array for empty query', () => {
      let results = frames.searchFrames(userId, '', {}, db);
      assert.strictEqual(results.length, 0);
    });

    it('should return empty array for null query', () => {
      let results = frames.searchFrames(userId, null, {}, db);
      assert.strictEqual(results.length, 0);
    });

    it('should return empty array for no matches', () => {
      let results = frames.searchFrames(userId, 'xyznonexistent', {}, db);
      assert.strictEqual(results.length, 0);
    });

    it('should be case-insensitive (SQLite LIKE)', () => {
      let lower = frames.searchFrames(userId, 'quicksort', {}, db);
      let upper = frames.searchFrames(userId, 'QUICKSORT', {}, db);

      // SQLite LIKE is case-insensitive for ASCII by default
      assert.strictEqual(lower.length, upper.length);
    });
  });

  // ===========================================================================
  // countSearchResults
  // ===========================================================================
  describe('countSearchResults()', () => {
    it('should count matching frames', () => {
      let count = frames.countSearchResults(userId, 'sort', {}, db);

      assert.ok(count > 0);
    });

    it('should match searchFrames result count', () => {
      let results = frames.searchFrames(userId, 'sort', {}, db);
      let count   = frames.countSearchResults(userId, 'sort', {}, db);

      assert.strictEqual(count, results.length);
    });

    it('should scope to session', () => {
      let total     = frames.countSearchResults(userId, 'sort', {}, db);
      let session1  = frames.countSearchResults(userId, 'sort', { sessionId: session1Id }, db);
      let session2  = frames.countSearchResults(userId, 'sort', { sessionId: session2Id }, db);

      assert.ok(session1 <= total);
      assert.ok(session2 <= total);
    });

    it('should return 0 for empty query', () => {
      let count = frames.countSearchResults(userId, '', {}, db);
      assert.strictEqual(count, 0);
    });

    it('should only count frames for the specified user', () => {
      let userCount  = frames.countSearchResults(userId, 'quicksort', {}, db);
      let otherCount = frames.countSearchResults(otherUserId, 'quicksort', {}, db);

      // Both users have quicksort-related frames
      assert.ok(userCount > 0);
      assert.ok(otherCount > 0);

      // They should have different counts (user1 has 2, user2 has 1)
      assert.ok(userCount >= 2);
      assert.ok(otherCount >= 1);
    });
  });
});
