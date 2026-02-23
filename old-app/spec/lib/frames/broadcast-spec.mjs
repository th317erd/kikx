'use strict';

// ============================================================================
// Frame Broadcast Helper Tests
// ============================================================================
// Tests for the frame creation with WebSocket broadcasting.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import {
  createAndBroadcastFrame,
  createUserMessageFrame,
  createAgentMessageFrame,
  createSystemMessageFrame,
  createRequestFrame,
  createResultFrame,
  createCompactFrame,
  createUpdateFrame,
} from '../../../server/lib/frames/broadcast.mjs';
import { FrameType, AuthorType } from '../../../server/lib/frames/index.mjs';

// ============================================================================
// Test Database Setup
// ============================================================================

let db = null;

function createTestDatabase() {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT);
    CREATE TABLE agents (id INTEGER PRIMARY KEY, user_id INTEGER, name TEXT);
    CREATE TABLE sessions (id INTEGER PRIMARY KEY, user_id INTEGER, agent_id INTEGER, name TEXT);
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
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );
    CREATE INDEX idx_frames_session ON frames(session_id, timestamp);
    CREATE INDEX idx_frames_parent ON frames(parent_id);
    CREATE INDEX idx_frames_type ON frames(type);
  `);

  db.prepare("INSERT INTO users (id, username) VALUES (1, 'testuser')").run();
  db.prepare("INSERT INTO agents (id, user_id, name) VALUES (1, 1, 'TestAgent')").run();
  db.prepare("INSERT INTO sessions (id, user_id, agent_id, name) VALUES (1, 1, 1, 'Test Session')").run();

  return db;
}

// ============================================================================
// Tests
// ============================================================================

describe('Frame Broadcast Helpers', () => {
  beforeEach(() => {
    createTestDatabase();
  });

  afterEach(() => {
    if (db) {
      db.close();
      db = null;
    }
  });

  describe('createUserMessageFrame', () => {
    it('should create a user message frame', () => {
      let frame = createUserMessageFrame({
        sessionId: 1,
        userId: 1,
        content: 'Hello, world!',
        skipBroadcast: true,
      }, db);

      assert.ok(frame.id);
      assert.equal(frame.type, FrameType.MESSAGE);
      assert.equal(frame.authorType, AuthorType.USER);
      assert.equal(frame.authorId, 1);
      assert.equal(frame.payload.role, 'user');
      assert.equal(frame.payload.content, 'Hello, world!');
      assert.equal(frame.payload.hidden, false);
    });

    it('should support hidden messages', () => {
      let frame = createUserMessageFrame({
        sessionId: 1,
        userId: 1,
        content: 'Hidden message',
        hidden: true,
        skipBroadcast: true,
      }, db);

      assert.equal(frame.payload.hidden, true);
    });
  });

  describe('createAgentMessageFrame', () => {
    it('should create an agent message frame', () => {
      let frame = createAgentMessageFrame({
        sessionId: 1,
        userId: 1,
        agentId: 1,
        content: 'Hello from agent!',
        skipBroadcast: true,
      }, db);

      assert.ok(frame.id);
      assert.equal(frame.type, FrameType.MESSAGE);
      assert.equal(frame.authorType, AuthorType.AGENT);
      assert.equal(frame.authorId, 1);
      assert.equal(frame.payload.role, 'assistant');
      assert.equal(frame.payload.content, 'Hello from agent!');
    });

    it('should support hidden agent messages', () => {
      let frame = createAgentMessageFrame({
        sessionId: 1,
        userId: 1,
        agentId: 1,
        content: 'Hidden agent response',
        hidden: true,
        skipBroadcast: true,
      }, db);

      assert.equal(frame.payload.hidden, true);
    });
  });

  describe('createSystemMessageFrame', () => {
    it('should create a system message frame', () => {
      let frame = createSystemMessageFrame({
        sessionId: 1,
        userId: 1,
        content: 'System notification',
        skipBroadcast: true,
      }, db);

      assert.ok(frame.id);
      assert.equal(frame.type, FrameType.MESSAGE);
      assert.equal(frame.authorType, AuthorType.SYSTEM);
      assert.equal(frame.payload.role, 'system');
      assert.equal(frame.payload.content, 'System notification');
    });

    it('should default to hidden for system messages', () => {
      let frame = createSystemMessageFrame({
        sessionId: 1,
        userId: 1,
        content: 'System message',
        skipBroadcast: true,
      }, db);

      assert.equal(frame.payload.hidden, true);
    });
  });

  describe('createRequestFrame', () => {
    it('should create a request frame', () => {
      let frame = createRequestFrame({
        sessionId: 1,
        userId: 1,
        agentId: 1,
        parentId: 'parent-frame-id',
        action: 'websearch',
        data: { query: 'test query' },
        skipBroadcast: true,
      }, db);

      assert.ok(frame.id);
      assert.equal(frame.type, FrameType.REQUEST);
      assert.equal(frame.authorType, AuthorType.AGENT);
      assert.equal(frame.parentId, 'parent-frame-id');
      assert.deepEqual(frame.targetIds, ['system:websearch']);
      assert.equal(frame.payload.action, 'websearch');
      assert.equal(frame.payload.query, 'test query');
    });

    it('should support custom target IDs', () => {
      let frame = createRequestFrame({
        sessionId: 1,
        userId: 1,
        agentId: 1,
        action: 'custom',
        data: {},
        targetIds: ['user:1', 'agent:2'],
        skipBroadcast: true,
      }, db);

      assert.deepEqual(frame.targetIds, ['user:1', 'agent:2']);
    });
  });

  describe('createResultFrame', () => {
    it('should create a result frame', () => {
      let frame = createResultFrame({
        sessionId: 1,
        userId: 1,
        parentId: 'request-frame-id',
        agentId: 1,
        result: { data: 'search results' },
        skipBroadcast: true,
      }, db);

      assert.ok(frame.id);
      assert.equal(frame.type, FrameType.RESULT);
      assert.equal(frame.authorType, AuthorType.SYSTEM);
      assert.equal(frame.parentId, 'request-frame-id');
      assert.deepEqual(frame.targetIds, ['agent:1']);
      assert.deepEqual(frame.payload, { data: 'search results' });
    });
  });

  describe('createCompactFrame', () => {
    it('should create a compact frame', () => {
      let frame = createCompactFrame({
        sessionId: 1,
        userId: 1,
        context: 'Summary of conversation',
        snapshot: { key: 'value' },
        skipBroadcast: true,
      }, db);

      assert.ok(frame.id);
      assert.equal(frame.type, FrameType.COMPACT);
      assert.equal(frame.authorType, AuthorType.SYSTEM);
      assert.equal(frame.payload.context, 'Summary of conversation');
      assert.deepEqual(frame.payload.snapshot, { key: 'value' });
    });
  });

  describe('createUpdateFrame', () => {
    it('should create an update frame', () => {
      let frame = createUpdateFrame({
        sessionId: 1,
        userId: 1,
        targetFrameId: 'original-frame-id',
        payload: { content: 'Updated content' },
        skipBroadcast: true,
      }, db);

      assert.ok(frame.id);
      assert.equal(frame.type, FrameType.UPDATE);
      assert.equal(frame.authorType, AuthorType.SYSTEM);
      assert.deepEqual(frame.targetIds, ['frame:original-frame-id']);
      assert.deepEqual(frame.payload, { content: 'Updated content' });
    });
  });

  describe('createAndBroadcastFrame', () => {
    it('should create a frame with custom options', () => {
      let frame = createAndBroadcastFrame({
        sessionId: 1,
        userId: 1,
        type: FrameType.MESSAGE,
        authorType: AuthorType.USER,
        authorId: 1,
        payload: { content: 'Test' },
        id: 'custom-id-123',
        skipBroadcast: true,
      }, db);

      assert.equal(frame.id, 'custom-id-123');
      assert.equal(frame.sessionId, 1);
    });
  });
});
