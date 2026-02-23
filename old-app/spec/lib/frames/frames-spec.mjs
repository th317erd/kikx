'use strict';

// ============================================================================
// Interaction Frames Tests
// ============================================================================
// Tests for the event-sourced conversation system including:
// - Frame CRUD operations
// - Frame compilation (replay logic)
// - Compact frame handling
// - Target ID lookups
// - Timestamp ordering

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import {
  FrameType,
  AuthorType,
  generateTimestamp,
  createFrame,
  getFrame,
  getFrames,
  getFramesBySession,
  getChildFrames,
  getFramesByTarget,
  getLatestCompact,
  countFrames,
  compileFrames,
} from '../../../server/lib/frames/index.mjs';

// ============================================================================
// Test Database Setup
// ============================================================================

let db = null;

/**
 * Create an in-memory test database with frames schema.
 */
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
      id            TEXT PRIMARY KEY,
      session_id    INTEGER NOT NULL,
      parent_id     TEXT,
      target_ids    TEXT,
      timestamp     TEXT NOT NULL,
      type          TEXT NOT NULL,
      author_type   TEXT NOT NULL,
      author_id     INTEGER,
      payload       TEXT NOT NULL,
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
// CRUD Tests
// ============================================================================

describe('Frames CRUD Operations', () => {
  beforeEach(() => {
    createTestDatabase();
  });

  afterEach(() => {
    if (db) {
      db.close();
      db = null;
    }
  });

  describe('createFrame', () => {
    it('should create a frame with auto-generated id and timestamp', () => {
      const frame = createFrame({
        sessionId: 1,
        type: 'message',
        authorType: 'user',
        authorId: 1,
        payload: { role: 'user', content: 'Hello, agent!' },
      }, db);

      assert.ok(frame.id, 'Frame should have an ID');
      assert.ok(frame.timestamp, 'Frame should have a timestamp');
      assert.equal(frame.sessionId, 1);
      assert.equal(frame.type, 'message');
      assert.equal(frame.authorType, 'user');
      assert.equal(frame.authorId, 1);
      assert.deepEqual(frame.payload, { role: 'user', content: 'Hello, agent!' });
    });

    it('should create a frame with custom id', () => {
      const frame = createFrame({
        id: 'custom-id-123',
        sessionId: 1,
        type: 'message',
        authorType: 'agent',
        authorId: 1,
        payload: { role: 'assistant', content: 'Hello!' },
      }, db);

      assert.equal(frame.id, 'custom-id-123');
    });

    it('should create a frame with parent_id', () => {
      const parent = createFrame({
        sessionId: 1,
        type: 'message',
        authorType: 'agent',
        payload: { content: 'Parent message' },
      }, db);

      const child = createFrame({
        sessionId: 1,
        parentId: parent.id,
        type: 'request',
        authorType: 'agent',
        payload: { action: 'websearch', query: 'test' },
      }, db);

      assert.equal(child.parentId, parent.id);
    });

    it('should create a frame with target_ids', () => {
      const frame = createFrame({
        sessionId: 1,
        type: 'result',
        authorType: 'system',
        targetIds: ['agent:1', 'frame:abc-123'],
        payload: { result: 'Search results here' },
      }, db);

      assert.deepEqual(frame.targetIds, ['agent:1', 'frame:abc-123']);
    });

    it('should store payload as JSON string in database', () => {
      const frame = createFrame({
        sessionId: 1,
        type: 'message',
        authorType: 'user',
        payload: { complex: { nested: true }, array: [1, 2, 3] },
      }, db);

      const row = db.prepare('SELECT payload FROM frames WHERE id = ?').get(frame.id);
      assert.equal(typeof row.payload, 'string');
      assert.deepEqual(JSON.parse(row.payload), { complex: { nested: true }, array: [1, 2, 3] });
    });
  });

  describe('getFrame', () => {
    it('should retrieve a frame by ID', () => {
      const created = createFrame({
        sessionId: 1,
        type: 'message',
        authorType: 'user',
        payload: { content: 'Test message' },
      }, db);

      const retrieved = getFrame(created.id, db);

      assert.deepEqual(retrieved.id, created.id);
      assert.deepEqual(retrieved.payload, created.payload);
    });

    it('should return null for non-existent frame', () => {
      const frame = getFrame('non-existent-id', db);
      assert.equal(frame, null);
    });
  });

  describe('getFrames', () => {
    it('should retrieve all frames for a session in timestamp order', () => {
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

      assert.equal(frames.length, 3);
      assert.equal(frames[0].id, frame1.id);
      assert.equal(frames[1].id, frame2.id);
      assert.equal(frames[2].id, frame3.id);
    });

    it('should filter by session_id', () => {
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

      const frames1 = getFrames(1, {}, db);
      const frames2 = getFrames(2, {}, db);

      assert.equal(frames1.length, 1);
      assert.equal(frames2.length, 1);
      assert.equal(frames1[0].payload.content, 'Session 1');
      assert.equal(frames2[0].payload.content, 'Session 2');
    });

    it('should filter by fromTimestamp', () => {
      const frame1 = createFrame({
        sessionId: 1,
        type: 'message',
        authorType: 'user',
        payload: { content: 'Old' },
      }, db);

      const frame2 = createFrame({
        sessionId: 1,
        type: 'message',
        authorType: 'agent',
        payload: { content: 'New' },
      }, db);

      const frames = getFrames(1, { fromTimestamp: frame1.timestamp }, db);

      assert.equal(frames.length, 1);
      assert.equal(frames[0].id, frame2.id);
    });

    it('should filter by types', () => {
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
        payload: { result: 'data' },
      }, db);

      const messages = getFrames(1, { types: ['message'] }, db);
      const interactions = getFrames(1, { types: ['request', 'result'] }, db);

      assert.equal(messages.length, 1);
      assert.equal(interactions.length, 2);
    });

    it('should limit results', () => {
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
      assert.equal(frames[0].payload.content, 'Message 0');
      assert.equal(frames[4].payload.content, 'Message 4');
    });

    it('should start from most recent compact frame when fromCompact is true', () => {
      createFrame({
        sessionId: 1,
        type: 'message',
        authorType: 'user',
        payload: { content: 'Before compact' },
      }, db);

      const compact = createFrame({
        sessionId: 1,
        type: 'compact',
        authorType: 'system',
        payload: { summary: 'Compacted state' },
      }, db);

      createFrame({
        sessionId: 1,
        type: 'message',
        authorType: 'user',
        payload: { content: 'After compact' },
      }, db);

      const frames = getFrames(1, { fromCompact: true }, db);

      assert.equal(frames.length, 2);
      assert.equal(frames[0].id, compact.id);
      assert.equal(frames[1].payload.content, 'After compact');
    });
  });

  describe('getChildFrames', () => {
    it('should retrieve child frames of a parent', () => {
      const parent = createFrame({
        sessionId: 1,
        type: 'message',
        authorType: 'agent',
        payload: { content: 'Parent' },
      }, db);

      const child1 = createFrame({
        sessionId: 1,
        parentId: parent.id,
        type: 'request',
        authorType: 'agent',
        payload: { action: 'websearch' },
      }, db);

      const child2 = createFrame({
        sessionId: 1,
        parentId: parent.id,
        type: 'request',
        authorType: 'agent',
        payload: { action: 'fetch' },
      }, db);

      const children = getChildFrames(parent.id, db);

      assert.equal(children.length, 2);
      assert.equal(children[0].id, child1.id);
      assert.equal(children[1].id, child2.id);
    });
  });

  describe('getFramesByTarget', () => {
    it('should find frames by target ID', () => {
      createFrame({
        sessionId: 1,
        type: 'result',
        authorType: 'system',
        targetIds: ['agent:1'],
        payload: { result: 'For agent' },
      }, db);

      createFrame({
        sessionId: 1,
        type: 'result',
        authorType: 'system',
        targetIds: ['user:1'],
        payload: { result: 'For user' },
      }, db);

      const agentFrames = getFramesByTarget('agent:1', null, db);
      const userFrames = getFramesByTarget('user:1', null, db);

      assert.equal(agentFrames.length, 1);
      assert.equal(userFrames.length, 1);
      assert.equal(agentFrames[0].payload.result, 'For agent');
      assert.equal(userFrames[0].payload.result, 'For user');
    });

    it('should scope by session_id when provided', () => {
      createFrame({
        sessionId: 1,
        type: 'result',
        authorType: 'system',
        targetIds: ['agent:1'],
        payload: { result: 'Session 1' },
      }, db);

      createFrame({
        sessionId: 2,
        type: 'result',
        authorType: 'system',
        targetIds: ['agent:1'],
        payload: { result: 'Session 2' },
      }, db);

      const allFrames = getFramesByTarget('agent:1', null, db);
      const session1Frames = getFramesByTarget('agent:1', 1, db);

      assert.equal(allFrames.length, 2);
      assert.equal(session1Frames.length, 1);
      assert.equal(session1Frames[0].payload.result, 'Session 1');
    });
  });

  describe('getLatestCompact', () => {
    it('should return the most recent compact frame', () => {
      createFrame({
        sessionId: 1,
        type: 'compact',
        authorType: 'system',
        payload: { summary: 'First compact' },
      }, db);

      createFrame({
        sessionId: 1,
        type: 'message',
        authorType: 'user',
        payload: { content: 'A message' },
      }, db);

      createFrame({
        sessionId: 1,
        type: 'compact',
        authorType: 'system',
        payload: { summary: 'Second compact' },
      }, db);

      const latest = getLatestCompact(1, db);

      assert.ok(latest);
      assert.equal(latest.payload.summary, 'Second compact');
    });

    it('should return null if no compact frames exist', () => {
      createFrame({
        sessionId: 1,
        type: 'message',
        authorType: 'user',
        payload: { content: 'Just a message' },
      }, db);

      const compact = getLatestCompact(1, db);

      assert.equal(compact, null);
    });
  });

  describe('countFrames', () => {
    it('should count frames in a session', () => {
      for (let i = 0; i < 5; i++) {
        createFrame({
          sessionId: 1,
          type: 'message',
          authorType: 'user',
          payload: { content: `Message ${i}` },
        }, db);
      }

      const count = countFrames(1, {}, db);

      assert.equal(count, 5);
    });

    it('should filter count by types', () => {
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
        type: 'request',
        authorType: 'agent',
        payload: { action: 'fetch' },
      }, db);

      const messageCount = countFrames(1, { types: ['message'] }, db);
      const requestCount = countFrames(1, { types: ['request'] }, db);

      assert.equal(messageCount, 1);
      assert.equal(requestCount, 2);
    });
  });

  describe('generateTimestamp', () => {
    it('should generate unique timestamps in ascending order', () => {
      const timestamps = [];
      for (let i = 0; i < 100; i++) {
        timestamps.push(generateTimestamp());
      }

      // All should be unique
      const unique = new Set(timestamps);
      assert.equal(unique.size, 100, 'All timestamps should be unique');

      // All should be in ascending order
      for (let i = 1; i < timestamps.length; i++) {
        assert.ok(timestamps[i] > timestamps[i - 1], 'Timestamps should be ascending');
      }
    });

    it('should produce valid ISO-like format', () => {
      const ts = generateTimestamp();

      // Should match pattern: 2026-02-07T12:34:56.789123456Z
      assert.match(ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{9}Z$/);
    });
  });
});

// ============================================================================
// Frame Compilation Tests
// ============================================================================

describe('Frame Compilation', () => {
  beforeEach(() => {
    createTestDatabase();
  });

  afterEach(() => {
    if (db) {
      db.close();
      db = null;
    }
  });

  describe('compileFrames', () => {
    it('should compile message frames into a map', () => {
      createFrame({
        id: 'message-1',
        sessionId: 1,
        type: 'message',
        authorType: 'user',
        payload: { role: 'user', content: 'Hello' },
      }, db);

      createFrame({
        id: 'message-2',
        sessionId: 1,
        type: 'message',
        authorType: 'agent',
        payload: { role: 'assistant', content: 'Hi there!' },
      }, db);

      const frames = getFrames(1, {}, db);
      const compiled = compileFrames(frames);

      assert.equal(compiled.size, 2);
      assert.deepEqual(compiled.get('message-1'), { role: 'user', content: 'Hello' });
      assert.deepEqual(compiled.get('message-2'), { role: 'assistant', content: 'Hi there!' });
    });

    it('should apply update frames to replace content', () => {
      createFrame({
        id: 'message-1',
        sessionId: 1,
        type: 'message',
        authorType: 'user',
        payload: { role: 'user', content: 'Original content' },
      }, db);

      createFrame({
        sessionId: 1,
        type: 'update',
        authorType: 'system',
        targetIds: ['frame:message-1'],
        payload: { role: 'user', content: 'Updated content' },
      }, db);

      const frames = getFrames(1, {}, db);
      const compiled = compileFrames(frames);

      assert.deepEqual(compiled.get('message-1'), { role: 'user', content: 'Updated content' });
    });

    it('should handle multiple updates to the same frame', () => {
      createFrame({
        id: 'message-1',
        sessionId: 1,
        type: 'message',
        authorType: 'agent',
        payload: { content: 'First' },
      }, db);

      createFrame({
        sessionId: 1,
        type: 'update',
        authorType: 'agent',
        targetIds: ['frame:message-1'],
        payload: { content: 'Second' },
      }, db);

      createFrame({
        sessionId: 1,
        type: 'update',
        authorType: 'agent',
        targetIds: ['frame:message-1'],
        payload: { content: 'Third' },
      }, db);

      const frames = getFrames(1, {}, db);
      const compiled = compileFrames(frames);

      assert.deepEqual(compiled.get('message-1'), { content: 'Third' });
    });

    it('should load from compact frame when present', () => {
      // Old messages before compact
      createFrame({
        id: 'old-1',
        sessionId: 1,
        type: 'message',
        authorType: 'user',
        payload: { content: 'Old message 1' },
      }, db);

      createFrame({
        id: 'old-2',
        sessionId: 1,
        type: 'message',
        authorType: 'agent',
        payload: { content: 'Old message 2' },
      }, db);

      // Compact frame with snapshot
      createFrame({
        id: 'compact-1',
        sessionId: 1,
        type: 'compact',
        authorType: 'system',
        payload: {
          snapshot: {
            'summary-message': { role: 'system', content: 'Summary of conversation' },
          },
        },
      }, db);

      // New messages after compact
      createFrame({
        id: 'new-1',
        sessionId: 1,
        type: 'message',
        authorType: 'user',
        payload: { content: 'New message' },
      }, db);

      const frames = getFrames(1, { fromCompact: true }, db);
      const compiled = compileFrames(frames);

      // Should NOT have old messages
      assert.equal(compiled.has('old-1'), false);
      assert.equal(compiled.has('old-2'), false);

      // Should have compact snapshot
      assert.deepEqual(compiled.get('summary-message'), { role: 'system', content: 'Summary of conversation' });

      // Should have new message
      assert.deepEqual(compiled.get('new-1'), { content: 'New message' });
    });

    it('should gracefully handle updates to missing targets', () => {
      createFrame({
        sessionId: 1,
        type: 'update',
        authorType: 'system',
        targetIds: ['frame:non-existent'],
        payload: { content: 'This update has no target' },
      }, db);

      const frames = getFrames(1, {}, db);

      // Should not throw
      const compiled = compileFrames(frames);

      // The update with missing target should be skipped
      assert.equal(compiled.size, 0);
    });

    it('should be idempotent', () => {
      createFrame({
        id: 'message-1',
        sessionId: 1,
        type: 'message',
        authorType: 'user',
        payload: { content: 'Test' },
      }, db);

      createFrame({
        sessionId: 1,
        type: 'update',
        authorType: 'system',
        targetIds: ['frame:message-1'],
        payload: { content: 'Updated' },
      }, db);

      const frames = getFrames(1, {}, db);

      const compiled1 = compileFrames(frames);
      const compiled2 = compileFrames(frames);
      const compiled3 = compileFrames(frames);

      assert.deepEqual(compiled1.get('message-1'), compiled2.get('message-1'));
      assert.deepEqual(compiled2.get('message-1'), compiled3.get('message-1'));
    });

    it('should handle request and result frames', () => {
      createFrame({
        id: 'message-1',
        sessionId: 1,
        type: 'message',
        authorType: 'agent',
        payload: { content: 'Let me search for that' },
      }, db);

      createFrame({
        id: 'req-1',
        sessionId: 1,
        parentId: 'message-1',
        type: 'request',
        authorType: 'agent',
        targetIds: ['system:websearch'],
        payload: { action: 'websearch', query: 'test query' },
      }, db);

      createFrame({
        id: 'res-1',
        sessionId: 1,
        parentId: 'req-1',
        type: 'result',
        authorType: 'system',
        targetIds: ['agent:1'],
        payload: { results: ['result1', 'result2'] },
      }, db);

      const frames = getFrames(1, {}, db);
      const compiled = compileFrames(frames);

      assert.equal(compiled.size, 3);
      assert.deepEqual(compiled.get('message-1'), { content: 'Let me search for that' });
      assert.deepEqual(compiled.get('req-1'), { action: 'websearch', query: 'test query' });
      assert.deepEqual(compiled.get('res-1'), { results: ['result1', 'result2'] });
    });
  });
});

// ============================================================================
// Edge Cases
// ============================================================================

describe('Edge Cases', () => {
  beforeEach(() => {
    createTestDatabase();
  });

  afterEach(() => {
    if (db) {
      db.close();
      db = null;
    }
  });

  it('should handle empty session', () => {
    const frames = getFrames(1, {}, db);
    const compiled = compileFrames(frames);

    assert.equal(frames.length, 0);
    assert.equal(compiled.size, 0);
  });

  it('should handle payload as string', () => {
    const frame = createFrame({
      sessionId: 1,
      type: 'message',
      authorType: 'user',
      payload: '{"content": "String payload"}',
    }, db);

    const retrieved = getFrame(frame.id, db);

    assert.deepEqual(retrieved.payload, { content: 'String payload' });
  });

  it('should preserve special characters in payload', () => {
    const specialContent = 'Hello "world"!\nNew line\tTab\u0000Null';

    const frame = createFrame({
      sessionId: 1,
      type: 'message',
      authorType: 'user',
      payload: { content: specialContent },
    }, db);

    const retrieved = getFrame(frame.id, db);

    assert.equal(retrieved.payload.content, specialContent);
  });

  it('should handle deeply nested payload', () => {
    const deepPayload = {
      level1: {
        level2: {
          level3: {
            level4: {
              value: 'deep',
            },
          },
        },
      },
    };

    const frame = createFrame({
      sessionId: 1,
      type: 'message',
      authorType: 'agent',
      payload: deepPayload,
    }, db);

    const retrieved = getFrame(frame.id, db);

    assert.deepEqual(retrieved.payload, deepPayload);
  });

  it('should handle large payloads', () => {
    const largeContent = 'x'.repeat(100000);

    const frame = createFrame({
      sessionId: 1,
      type: 'message',
      authorType: 'agent',
      payload: { content: largeContent },
    }, db);

    const retrieved = getFrame(frame.id, db);

    assert.equal(retrieved.payload.content.length, 100000);
  });
});

// ============================================================================
// Frame Type Constants
// ============================================================================

describe('Frame Type Constants', () => {
  it('should export correct FrameType values', () => {
    assert.equal(FrameType.MESSAGE, 'message');
    assert.equal(FrameType.REQUEST, 'request');
    assert.equal(FrameType.RESULT, 'result');
    assert.equal(FrameType.UPDATE, 'update');
    assert.equal(FrameType.COMPACT, 'compact');
  });

  it('should export correct AuthorType values', () => {
    assert.equal(AuthorType.USER, 'user');
    assert.equal(AuthorType.AGENT, 'agent');
    assert.equal(AuthorType.SYSTEM, 'system');
  });
});
