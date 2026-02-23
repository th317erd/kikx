'use strict';

// ============================================================================
// Frame Context Builder Tests
// ============================================================================
// Tests for the frame-based conversation context loading.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { createFrame, FrameType, AuthorType } from '../../../server/lib/frames/index.mjs';
import {
  loadFramesForContext,
  getFramesForDisplay,
  buildConversationForCompaction,
  countMessagesSinceCompact,
} from '../../../server/lib/frames/context.mjs';
import {
  registerAbility,
  clearAbilitiesBySource,
} from '../../../server/lib/abilities/registry.mjs';

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

describe('Frame Context Builder', () => {
  beforeEach(() => {
    createTestDatabase();
  });

  afterEach(() => {
    if (db) {
      db.close();
      db = null;
    }
  });

  describe('loadFramesForContext', () => {
    it('should return empty array for session with no frames', () => {
      const messages = loadFramesForContext(1, {}, db);
      assert.deepEqual(messages, []);
    });

    it('should convert message frames to AI format', () => {
      createFrame({
        sessionId: 1,
        type: 'message',
        authorType: 'user',
        payload: { role: 'user', content: 'Hello!' },
      }, db);

      createFrame({
        sessionId: 1,
        type: 'message',
        authorType: 'agent',
        payload: { role: 'assistant', content: 'Hi there!' },
      }, db);

      const messages = loadFramesForContext(1, {}, db);

      assert.equal(messages.length, 2);
      assert.equal(messages[0].role, 'user');
      assert.equal(messages[0].content, 'Hello!');
      assert.equal(messages[1].role, 'assistant');
      assert.equal(messages[1].content, 'Hi there!');
    });

    it('should infer role from authorType if not in payload', () => {
      createFrame({
        sessionId: 1,
        type: 'message',
        authorType: 'user',
        payload: { content: 'User message' },
      }, db);

      createFrame({
        sessionId: 1,
        type: 'message',
        authorType: 'agent',
        payload: { content: 'Agent message' },
      }, db);

      const messages = loadFramesForContext(1, {}, db);

      assert.equal(messages[0].role, 'user');
      assert.equal(messages[1].role, 'assistant');
    });

    it('should respect compact frame as starting point', () => {
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
        payload: { context: 'Previous conversation summary' },
      }, db);

      createFrame({
        sessionId: 1,
        type: 'message',
        authorType: 'user',
        payload: { content: 'New message' },
      }, db);

      const messages = loadFramesForContext(1, {}, db);

      // Should have: restored context + new message
      assert.equal(messages.length, 2);
      assert.ok(messages[0].content.includes('RESTORED CONTEXT'));
      assert.ok(messages[0].content.includes('Previous conversation summary'));
      assert.equal(messages[1].content, 'New message');
    });

    it('should re-inject startup abilities after compaction', () => {
      // Register a test startup ability
      registerAbility({
        id:          'startup-__onstart_',
        name:        '__onstart_',
        type:        'process',
        source:      'startup',
        description: 'Test startup instructions',
        content:     'You must use <interaction> tags for tool calls.',
        permissions: { autoApprove: true, autoApprovePolicy: 'always', dangerLevel: 'safe' },
      });

      try {
        // Create compact frame + one new message
        createFrame({
          sessionId: 1,
          type: 'compact',
          authorType: 'system',
          payload: { context: 'Summary of prior conversation' },
        }, db);

        createFrame({
          sessionId: 1,
          type: 'message',
          authorType: 'user',
          payload: { content: 'New user message' },
        }, db);

        const messages = loadFramesForContext(1, {}, db);

        // Should have: restored context, startup user, startup ack, new message
        assert.equal(messages.length, 4);
        assert.ok(messages[0].content.includes('RESTORED CONTEXT'));
        assert.equal(messages[1].role, 'user');
        assert.ok(messages[1].content.includes('[System Initialization]'));
        assert.ok(messages[1].content.includes('<interaction>'));
        assert.equal(messages[2].role, 'assistant');
        assert.ok(messages[2].content.includes('Understood'));
        assert.equal(messages[3].content, 'New user message');
      } finally {
        clearAbilitiesBySource('startup');
      }
    });

    it('should NOT inject startup abilities when no compact frame exists', () => {
      // Register a test startup ability
      registerAbility({
        id:          'startup-__onstart_',
        name:        '__onstart_',
        type:        'process',
        source:      'startup',
        description: 'Test startup instructions',
        content:     'You must use <interaction> tags.',
        permissions: { autoApprove: true, autoApprovePolicy: 'always', dangerLevel: 'safe' },
      });

      try {
        // Create frames WITHOUT a compact frame
        createFrame({
          sessionId: 1,
          type: 'message',
          authorType: 'user',
          payload: { content: 'Hello' },
        }, db);

        createFrame({
          sessionId: 1,
          type: 'message',
          authorType: 'agent',
          payload: { content: 'Hi' },
        }, db);

        const messages = loadFramesForContext(1, {}, db);

        // Should just have the two messages — no startup injection
        assert.equal(messages.length, 2);
        assert.equal(messages[0].content, 'Hello');
        assert.equal(messages[1].content, 'Hi');
      } finally {
        clearAbilitiesBySource('startup');
      }
    });

    it('should maintain role alternation with startup re-injection', () => {
      registerAbility({
        id:          'startup-__onstart_',
        name:        '__onstart_',
        type:        'process',
        source:      'startup',
        description: 'Test startup instructions',
        content:     'Instructions here.',
        permissions: { autoApprove: true, autoApprovePolicy: 'always', dangerLevel: 'safe' },
      });

      try {
        createFrame({
          sessionId: 1,
          type: 'compact',
          authorType: 'system',
          payload: { context: 'Summary' },
        }, db);

        createFrame({
          sessionId: 1,
          type: 'message',
          authorType: 'user',
          payload: { content: 'User msg' },
        }, db);

        createFrame({
          sessionId: 1,
          type: 'message',
          authorType: 'agent',
          payload: { content: 'Agent msg' },
        }, db);

        const messages = loadFramesForContext(1, {}, db);

        // Verify alternation: assistant, user, assistant, user, assistant
        assert.equal(messages[0].role, 'assistant'); // compact context
        assert.equal(messages[1].role, 'user');      // startup init
        assert.equal(messages[2].role, 'assistant'); // startup ack
        assert.equal(messages[3].role, 'user');      // user msg
        assert.equal(messages[4].role, 'assistant'); // agent msg
      } finally {
        clearAbilitiesBySource('startup');
      }
    });

    it('should only inject process-type startup abilities', () => {
      // Register a function-type ability (should be skipped)
      registerAbility({
        id:          'startup-__onstart_func',
        name:        '__onstart_func',
        type:        'function',
        source:      'startup',
        description: 'Function ability',
        execute:     () => {},
        permissions: { autoApprove: true, autoApprovePolicy: 'always', dangerLevel: 'safe' },
      });

      try {
        createFrame({
          sessionId: 1,
          type: 'compact',
          authorType: 'system',
          payload: { context: 'Summary' },
        }, db);

        createFrame({
          sessionId: 1,
          type: 'message',
          authorType: 'user',
          payload: { content: 'Hello' },
        }, db);

        const messages = loadFramesForContext(1, {}, db);

        // No process-type startup ability, so no injection
        assert.equal(messages.length, 2);
        assert.ok(messages[0].content.includes('RESTORED CONTEXT'));
        assert.equal(messages[1].content, 'Hello');
      } finally {
        clearAbilitiesBySource('startup');
      }
    });

    it('should apply update frames correctly', () => {
      createFrame({
        id: 'message-1',
        sessionId: 1,
        type: 'message',
        authorType: 'user',
        payload: { content: 'Original message' },
      }, db);

      createFrame({
        sessionId: 1,
        type: 'update',
        authorType: 'system',
        targetIds: ['frame:message-1'],
        payload: { content: 'Updated message' },
      }, db);

      const messages = loadFramesForContext(1, {}, db);

      assert.equal(messages.length, 1);
      assert.equal(messages[0].content, 'Updated message');
    });

    it('should respect maxRecentFrames limit', () => {
      for (let i = 0; i < 10; i++) {
        createFrame({
          sessionId: 1,
          type: 'message',
          authorType: 'user',
          payload: { content: `Message ${i}` },
        }, db);
      }

      const messages = loadFramesForContext(1, { maxRecentFrames: 5 }, db);

      assert.equal(messages.length, 5);
    });

    it('should strip <interaction> tags from user messages', () => {
      // User message containing an interaction tag (e.g., from prompt answer)
      createFrame({
        sessionId:  1,
        type:       'message',
        authorType: 'user',
        payload:    { content: 'Blue<interaction>{"target_id":"@system","target_property":"update_prompt"}</interaction>' },
      }, db);

      const messages = loadFramesForContext(1, {}, db);

      assert.equal(messages.length, 1);
      assert.equal(messages[0].role, 'user');
      // The <interaction> tag should be stripped
      assert.equal(messages[0].content, 'Blue');
      assert.ok(!messages[0].content.includes('<interaction>'), 'Should not contain <interaction> tags');
    });

    it('should NOT strip <interaction> tags from assistant messages', () => {
      // Agent messages may legitimately contain interaction tags
      createFrame({
        sessionId:  1,
        type:       'message',
        authorType: 'agent',
        payload:    { content: 'Let me search for that.<interaction>{"target_id":"@system"}</interaction>' },
      }, db);

      const messages = loadFramesForContext(1, {}, db);

      assert.equal(messages.length, 1);
      assert.equal(messages[0].role, 'assistant');
      // Agent messages keep their interaction tags
      assert.ok(messages[0].content.includes('<interaction>'), 'Assistant messages should keep <interaction> tags');
    });
  });

  describe('getFramesForDisplay', () => {
    it('should return frames and compiled state', () => {
      createFrame({
        id: 'message-1',
        sessionId: 1,
        type: 'message',
        authorType: 'user',
        payload: { content: 'Hello' },
      }, db);

      createFrame({
        sessionId: 1,
        type: 'update',
        authorType: 'system',
        targetIds: ['frame:message-1'],
        payload: { content: 'Hello (edited)' },
      }, db);

      const result = getFramesForDisplay(1, {}, db);

      assert.equal(result.frames.length, 2);
      assert.equal(result.count, 2);
      assert.deepEqual(result.compiled['message-1'], { content: 'Hello (edited)' });
    });
  });

  describe('buildConversationForCompaction', () => {
    it('should format conversation for summarization', () => {
      createFrame({
        sessionId: 1,
        type: 'message',
        authorType: 'user',
        payload: { content: 'What is 2+2?' },
      }, db);

      createFrame({
        sessionId: 1,
        type: 'message',
        authorType: 'agent',
        payload: { content: 'The answer is 4.' },
      }, db);

      const conversation = buildConversationForCompaction(1, db);

      assert.ok(conversation.includes('User: What is 2+2?'));
      assert.ok(conversation.includes('Assistant: The answer is 4.'));
    });

    it('should only include messages after last compact', () => {
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
        payload: { context: 'Summary' },
      }, db);

      createFrame({
        sessionId: 1,
        type: 'message',
        authorType: 'user',
        payload: { content: 'New message' },
      }, db);

      const conversation = buildConversationForCompaction(1, db);

      assert.ok(!conversation.includes('Old message'));
      assert.ok(conversation.includes('New message'));
    });
  });

  describe('countMessagesSinceCompact', () => {
    it('should count all messages when no compact exists', () => {
      createFrame({
        sessionId: 1,
        type: 'message',
        authorType: 'user',
        payload: { content: 'Message 1' },
      }, db);

      createFrame({
        sessionId: 1,
        type: 'message',
        authorType: 'agent',
        payload: { content: 'Message 2' },
      }, db);

      const count = countMessagesSinceCompact(1, db);

      assert.equal(count, 2);
    });

    it('should only count messages after compact', () => {
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
        payload: { context: 'Summary' },
      }, db);

      createFrame({
        sessionId: 1,
        type: 'message',
        authorType: 'user',
        payload: { content: 'New message 1' },
      }, db);

      createFrame({
        sessionId: 1,
        type: 'message',
        authorType: 'agent',
        payload: { content: 'New message 2' },
      }, db);

      const count = countMessagesSinceCompact(1, db);

      assert.equal(count, 2);
    });

    it('should not count non-message frames', () => {
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

      const count = countMessagesSinceCompact(1, db);

      assert.equal(count, 1);
    });
  });
});
