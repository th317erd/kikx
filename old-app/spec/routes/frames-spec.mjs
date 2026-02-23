'use strict';

// ============================================================================
// Frames API Tests
// ============================================================================
// Tests for the frames REST API endpoints.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import {
  createFrame,
  getFrames,
  compileFrames,
} from '../../server/lib/frames/index.mjs';

// ============================================================================
// Test Database Setup
// ============================================================================

let db = null;

function createTestDatabase() {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL
    );

    CREATE TABLE agents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL
    );

    CREATE TABLE sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      name TEXT NOT NULL
    );

    CREATE TABLE frames (
      id TEXT PRIMARY KEY,
      session_id INTEGER NOT NULL,
      parent_id TEXT,
      target_ids TEXT,
      timestamp TEXT NOT NULL,
      type TEXT NOT NULL,
      author_type TEXT NOT NULL,
      author_id INTEGER,
      payload TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );

    CREATE INDEX idx_frames_session ON frames(session_id, timestamp);
    CREATE INDEX idx_frames_parent ON frames(parent_id);
    CREATE INDEX idx_frames_type ON frames(type);
  `);

  // Create test user, agent, and session
  db.prepare("INSERT INTO users (id, username) VALUES (1, 'testuser')").run();
  db.prepare("INSERT INTO agents (id, user_id, name) VALUES (1, 1, 'TestAgent')").run();
  db.prepare("INSERT INTO sessions (id, user_id, agent_id, name) VALUES (1, 1, 1, 'Test Session')").run();
  db.prepare("INSERT INTO sessions (id, user_id, agent_id, name) VALUES (2, 1, 1, 'Session Two')").run();

  return db;
}

// ============================================================================
// API-style Tests (direct function calls simulating API)
// ============================================================================

describe('Frames API (Function Simulation)', () => {
  beforeEach(() => {
    createTestDatabase();
  });

  afterEach(() => {
    if (db) {
      db.close();
      db = null;
    }
  });

  describe('GET /sessions/:id/frames', () => {
    it('should return empty array for session with no frames', () => {
      const frames = getFrames(1, {}, db);
      assert.deepEqual(frames, []);
    });

    it('should return all frames for a session', () => {
      createFrame({
        sessionId: 1,
        type: 'message',
        authorType: 'user',
        payload: { role: 'user', content: 'Hello' },
      }, db);

      createFrame({
        sessionId: 1,
        type: 'message',
        authorType: 'agent',
        payload: { role: 'assistant', content: 'Hi there!' },
      }, db);

      const frames = getFrames(1, {}, db);

      assert.equal(frames.length, 2);
      assert.equal(frames[0].payload.content, 'Hello');
      assert.equal(frames[1].payload.content, 'Hi there!');
    });

    it('should support fromCompact option', () => {
      createFrame({
        sessionId: 1,
        type: 'message',
        authorType: 'user',
        payload: { content: 'Old message' },
      }, db);

      createFrame({
        sessionId: 1,
        type: 'compact',
        authorType: 'system',
        payload: { snapshot: {} },
      }, db);

      createFrame({
        sessionId: 1,
        type: 'message',
        authorType: 'user',
        payload: { content: 'New message' },
      }, db);

      const frames = getFrames(1, { fromCompact: true }, db);

      assert.equal(frames.length, 2); // compact + new message
      assert.equal(frames[0].type, 'compact');
      assert.equal(frames[1].payload.content, 'New message');
    });

    it('should support types filter', () => {
      createFrame({
        sessionId: 1,
        type: 'message',
        authorType: 'user',
        payload: { content: 'Message' },
      }, db);

      createFrame({
        sessionId: 1,
        type: 'request',
        authorType: 'agent',
        payload: { action: 'websearch' },
      }, db);

      createFrame({
        sessionId: 1,
        type: 'result',
        authorType: 'system',
        payload: { results: [] },
      }, db);

      const messageFrames = getFrames(1, { types: ['message'] }, db);
      const interactionFrames = getFrames(1, { types: ['request', 'result'] }, db);

      assert.equal(messageFrames.length, 1);
      assert.equal(interactionFrames.length, 2);
    });

    it('should support limit option', () => {
      for (let i = 0; i < 10; i++) {
        createFrame({
          sessionId: 1,
          type: 'message',
          authorType: 'user',
          payload: { content: `Message ${i}` },
        }, db);
      }

      const frames = getFrames(1, { limit: 5 }, db);

      assert.equal(frames.length, 5);
    });
  });

  describe('GET /sessions/:id/frames?compiled=true', () => {
    it('should return compiled frame state', () => {
      createFrame({
        id: 'message-1',
        sessionId: 1,
        type: 'message',
        authorType: 'user',
        payload: { role: 'user', content: 'Original' },
      }, db);

      createFrame({
        sessionId: 1,
        type: 'update',
        authorType: 'system',
        targetIds: ['frame:message-1'],
        payload: { role: 'user', content: 'Updated' },
      }, db);

      const frames = getFrames(1, {}, db);
      const compiled = compileFrames(frames);

      assert.equal(compiled.get('message-1').content, 'Updated');
    });
  });

  describe('Frame Isolation by Session', () => {
    it('should not leak frames between sessions', () => {
      createFrame({
        sessionId: 1,
        type: 'message',
        authorType: 'user',
        payload: { content: 'Session 1' },
      }, db);

      createFrame({
        sessionId: 2,
        type: 'message',
        authorType: 'user',
        payload: { content: 'Session 2' },
      }, db);

      const session1Frames = getFrames(1, {}, db);
      const session2Frames = getFrames(2, {}, db);

      assert.equal(session1Frames.length, 1);
      assert.equal(session2Frames.length, 1);
      assert.equal(session1Frames[0].payload.content, 'Session 1');
      assert.equal(session2Frames[0].payload.content, 'Session 2');
    });
  });

  describe('Frame Ordering', () => {
    it('should return frames in timestamp order', () => {
      const frame1 = createFrame({
        sessionId: 1,
        type: 'message',
        authorType: 'user',
        payload: { content: 'First' },
      }, db);

      const frame2 = createFrame({
        sessionId: 1,
        type: 'message',
        authorType: 'agent',
        payload: { content: 'Second' },
      }, db);

      const frame3 = createFrame({
        sessionId: 1,
        type: 'message',
        authorType: 'user',
        payload: { content: 'Third' },
      }, db);

      const frames = getFrames(1, {}, db);

      assert.equal(frames[0].id, frame1.id);
      assert.equal(frames[1].id, frame2.id);
      assert.equal(frames[2].id, frame3.id);
    });
  });

  describe('Parent-Child Relationships', () => {
    it('should preserve parent-child relationships', () => {
      const parent = createFrame({
        sessionId: 1,
        type: 'message',
        authorType: 'agent',
        payload: { content: 'Let me search' },
      }, db);

      const child = createFrame({
        sessionId: 1,
        parentId: parent.id,
        type: 'request',
        authorType: 'agent',
        targetIds: ['system:websearch'],
        payload: { action: 'websearch', query: 'test' },
      }, db);

      const frames = getFrames(1, {}, db);

      assert.equal(frames.length, 2);
      assert.equal(frames[1].parentId, parent.id);
    });
  });
});
