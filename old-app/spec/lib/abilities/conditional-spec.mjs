'use strict';

// ============================================================================
// Conditional Abilities Tests
// ============================================================================
// Tests for the conditional abilities system, including:
// - getUnansweredPrompts frame parsing

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { getUnansweredPrompts } from '../../../server/lib/abilities/conditional.mjs';

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
      id INTEGER PRIMARY KEY AUTOINCREMENT,
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
  `);

  db.prepare("INSERT INTO users (id, username) VALUES (1, 'testuser')").run();
  db.prepare("INSERT INTO agents (id, user_id, name) VALUES (1, 1, 'TestAgent')").run();
  db.prepare("INSERT INTO sessions (id, user_id, agent_id, name) VALUES (1, 1, 1, 'Test Session')").run();

  return db;
}

/**
 * Create a test frame with the given content.
 */
function createTestFrame(sessionId, content, options = {}) {
  let payload = JSON.stringify({
    role: 'assistant',
    content: content,
    hidden: options.hidden || false,
  });

  let result = db.prepare(`
    INSERT INTO frames (session_id, timestamp, type, author_type, author_id, payload)
    VALUES (?, datetime('now'), 'message', 'agent', 1, ?)
  `).run(sessionId, payload);

  return result.lastInsertRowid;
}

/**
 * Update a frame's content.
 */
function updateFrameContent(frameId, newContent) {
  let frame = db.prepare('SELECT payload FROM frames WHERE id = ?').get(frameId);
  let payload = JSON.parse(frame.payload);
  payload.content = newContent;
  db.prepare('UPDATE frames SET payload = ? WHERE id = ?').run(JSON.stringify(payload), frameId);
}

// ============================================================================
// getUnansweredPrompts Tests
// ============================================================================

describe('getUnansweredPrompts', () => {
  beforeEach(() => {
    createTestDatabase();
  });

  afterEach(() => {
    if (db) {
      db.close();
      db = null;
    }
  });

  it('should return empty array when no frames exist', () => {
    let result = getUnansweredPrompts(1, db);
    assert.deepEqual(result, []);
  });

  it('should return empty array when frames have no prompts', () => {
    createTestFrame(1, 'Hello, how can I help you today?');
    let result = getUnansweredPrompts(1, db);
    assert.deepEqual(result, []);
  });

  it('should find unanswered hml-prompt in frame content', () => {
    let content = 'Please answer: <hml-prompt id="prompt-123" type="text">What is your name?</hml-prompt>';
    createTestFrame(1, content);

    let result = getUnansweredPrompts(1, db);

    assert.equal(result.length, 1);
    assert.equal(result[0].promptID, 'prompt-123');
    assert.equal(result[0].question, 'What is your name?');
  });

  it('should find multiple unanswered prompts', () => {
    let content = `
      <hml-prompt id="prompt-1" type="text">Question 1?</hml-prompt>
      <hml-prompt id="prompt-2" type="radio">Question 2?</hml-prompt>
    `;
    createTestFrame(1, content);

    let result = getUnansweredPrompts(1, db);

    assert.equal(result.length, 2);
    assert.equal(result[0].promptID, 'prompt-1');
    assert.equal(result[1].promptID, 'prompt-2');
  });

  it('should NOT return prompts with answered="true" attribute', () => {
    let content = '<hml-prompt id="prompt-123" type="text" answered="true">What is your name?<response>Claude</response></hml-prompt>';
    createTestFrame(1, content);

    let result = getUnansweredPrompts(1, db);

    assert.deepEqual(result, []);
  });

  it('should NOT return prompts with answered attribute (no value)', () => {
    let content = '<hml-prompt id="prompt-123" type="text" answered>What is your name?</hml-prompt>';
    createTestFrame(1, content);

    let result = getUnansweredPrompts(1, db);

    assert.deepEqual(result, []);
  });

  it('should skip hidden frames', () => {
    let content = '<hml-prompt id="prompt-123" type="text">What is your name?</hml-prompt>';
    createTestFrame(1, content, { hidden: true });

    let result = getUnansweredPrompts(1, db);

    assert.deepEqual(result, []);
  });

  it('should return empty after frame is updated with answered="true"', () => {
    // This tests the core bug scenario:
    // 1. Frame has unanswered prompt
    // 2. Interaction updates frame with answered="true"
    // 3. getUnansweredPrompts should now return empty

    let content = '<hml-prompt id="prompt-123" type="text">What is your name?</hml-prompt>';
    let frameId = createTestFrame(1, content);

    // Verify prompt is found before update
    let beforeUpdate = getUnansweredPrompts(1, db);
    assert.equal(beforeUpdate.length, 1, 'Prompt should be found before update');

    // Simulate interaction updating the frame (what PromptUpdateFunction does)
    let updatedContent = '<hml-prompt id="prompt-123" type="text" answered="true">What is your name?<response>Claude</response></hml-prompt>';
    updateFrameContent(frameId, updatedContent);

    // Verify prompt is NOT found after update
    let afterUpdate = getUnansweredPrompts(1, db);
    assert.deepEqual(afterUpdate, [], 'Prompt should NOT be found after update with answered="true"');
  });

  it('should handle legacy user-prompt tag', () => {
    let content = '<user-prompt id="legacy-123">Old style prompt?</user-prompt>';
    createTestFrame(1, content);

    let result = getUnansweredPrompts(1, db);

    assert.equal(result.length, 1);
    assert.equal(result[0].promptID, 'legacy-123');
  });

  it('should handle legacy user_prompt tag (underscore)', () => {
    let content = '<user_prompt id="legacy-456">Old style prompt?</user_prompt>';
    createTestFrame(1, content);

    let result = getUnansweredPrompts(1, db);

    assert.equal(result.length, 1);
    assert.equal(result[0].promptID, 'legacy-456');
  });
});

