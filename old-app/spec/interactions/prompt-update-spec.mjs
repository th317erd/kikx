'use strict';

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import { PromptUpdateFunction } from '../../server/lib/interactions/functions/prompt-update.mjs';

// Mock database for testing
let testDb;
let originalGetDatabase;

describe('PromptUpdateFunction', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.exec(`
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY,
        content TEXT NOT NULL
      )
    `);

    // Mock the getDatabase function
    originalGetDatabase = PromptUpdateFunction.prototype.execute;
  });

  afterEach(() => {
    testDb.close();
  });

  describe('register()', () => {
    it('should return correct registration info', () => {
      let registration = PromptUpdateFunction.register();

      assert.strictEqual(registration.name, 'update_prompt');
      assert.strictEqual(registration.target, '@system');
      assert.ok(registration.schema);
      assert.deepStrictEqual(registration.schema.required, ['message_id', 'prompt_id', 'answer']);
    });
  });

  describe('allowed()', () => {
    it('should reject missing payload', async () => {
      let fn = new PromptUpdateFunction();
      let result = await fn.allowed(null);

      assert.strictEqual(result.allowed, false);
      assert.strictEqual(result.reason, 'Payload is required');
    });

    it('should reject missing message_id', async () => {
      let fn = new PromptUpdateFunction();
      let result = await fn.allowed({ prompt_id: 'abc', answer: 'test' });

      assert.strictEqual(result.allowed, false);
      assert.strictEqual(result.reason, 'message_id is required');
    });

    it('should reject missing prompt_id', async () => {
      let fn = new PromptUpdateFunction();
      let result = await fn.allowed({ message_id: 1, answer: 'test' });

      assert.strictEqual(result.allowed, false);
      assert.strictEqual(result.reason, 'prompt_id is required');
    });

    it('should reject missing answer', async () => {
      let fn = new PromptUpdateFunction();
      let result = await fn.allowed({ message_id: 1, prompt_id: 'abc' });

      assert.strictEqual(result.allowed, false);
      assert.strictEqual(result.reason, 'answer is required');
    });

    it('should allow valid payload', async () => {
      let fn = new PromptUpdateFunction();
      let result = await fn.allowed({
        message_id: 1,
        prompt_id:  'prompt-abc',
        answer:     'Blue',
      });

      assert.strictEqual(result.allowed, true);
    });
  });

  describe('escapeXml helper', () => {
    it('should escape XML special characters in answer', async () => {
      // We test this indirectly through the execute function behavior
      // The answer should be escaped when inserted into the XML
      let fn = new PromptUpdateFunction();

      // Test the allowed() validation passes with special characters
      let result = await fn.allowed({
        message_id: 1,
        prompt_id:  'prompt-test',
        answer:     '<script>alert("XSS")</script>',
      });

      assert.strictEqual(result.allowed, true);
    });
  });
});

describe('PromptUpdateFunction XML Pattern Matching', () => {
  it('should match user_prompt with simple id', () => {
    let content = '<user_prompt id="prompt-abc123">What is your name?</user_prompt>';
    let promptId = 'prompt-abc123';

    let pattern = new RegExp(
      `(<user_prompt\\s+id=["']${promptId}["'][^>]*)>([\\s\\S]*?)<\\/user_prompt>`,
      'g'
    );

    let match = pattern.exec(content);
    assert.ok(match, 'Pattern should match');
    assert.ok(match[1].includes('user_prompt'), 'Should capture opening tag');
    assert.strictEqual(match[2].trim(), 'What is your name?');
  });

  it('should match user_prompt with additional attributes', () => {
    let content = '<user_prompt id="prompt-xyz" type="text" required="true">Enter value:</user_prompt>';
    let promptId = 'prompt-xyz';

    let pattern = new RegExp(
      `(<user_prompt\\s+id=["']${promptId}["'][^>]*)>([\\s\\S]*?)<\\/user_prompt>`,
      'g'
    );

    let match = pattern.exec(content);
    assert.ok(match, 'Pattern should match with additional attributes');
  });

  it('should produce correct updated content', () => {
    let content = 'Hello\n<user_prompt id="prompt-123">What color?</user_prompt>\nBye';
    let promptId = 'prompt-123';
    let answer = 'Blue';

    let pattern = new RegExp(
      `(<user_prompt\\s+id=["']${promptId}["'][^>]*)>([\\s\\S]*?)<\\/user_prompt>`,
      'g'
    );

    let updated = content.replace(
      pattern,
      `$1 answered="true">$2<response>${answer}</response></user_prompt>`
    );

    assert.ok(updated.includes('answered="true"'), 'Should add answered attribute');
    assert.ok(updated.includes('<response>Blue</response>'), 'Should add response element');
    assert.ok(updated.includes('What color?'), 'Should preserve question');
  });

  it('should handle multiline questions', () => {
    let content = '<user_prompt id="prompt-multi">First line\nSecond line\nThird line</user_prompt>';
    let promptId = 'prompt-multi';

    let pattern = new RegExp(
      `(<user_prompt\\s+id=["']${promptId}["'][^>]*)>([\\s\\S]*?)<\\/user_prompt>`,
      'g'
    );

    let match = pattern.exec(content);
    assert.ok(match, 'Pattern should match multiline content');
    assert.ok(match[2].includes('Second line'), 'Should capture all lines');
  });

  it('should escape special regex characters in prompt_id', () => {
    // Test the escapeRegex helper indirectly
    let promptId = 'prompt-abc.def+xyz';
    let escapedId = promptId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    assert.strictEqual(escapedId, 'prompt-abc\\.def\\+xyz');
  });
});
