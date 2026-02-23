'use strict';

import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  deduplicateParagraphs,
  stripInteractionTags,
  replaceInteractionTagsWithNote,
  isInteractionOnly,
  getFriendlyErrorMessage,
  elementToAssertion,
} from '../../../server/lib/messaging/content-utils.mjs';

describe('content-utils', () => {
  // ===========================================================================
  // deduplicateParagraphs
  // ===========================================================================
  describe('deduplicateParagraphs()', () => {
    it('should return null/empty for falsy input', () => {
      assert.strictEqual(deduplicateParagraphs(null), null);
      assert.strictEqual(deduplicateParagraphs(''), '');
      assert.strictEqual(deduplicateParagraphs(undefined), undefined);
    });

    it('should pass through text without duplicates', () => {
      assert.strictEqual(deduplicateParagraphs('Hello world'), 'Hello world');
    });

    it('should remove consecutive duplicate paragraphs', () => {
      let input = 'First paragraph\n\nSecond paragraph\n\nSecond paragraph';
      let result = deduplicateParagraphs(input);
      assert.strictEqual(result, 'First paragraph\n\nSecond paragraph');
    });

    it('should handle multiple duplicates', () => {
      let input = 'A\n\nB\n\nA\n\nB';
      let result = deduplicateParagraphs(input);
      assert.strictEqual(result, 'A\n\nB');
    });

    it('should skip empty paragraphs', () => {
      let input = 'Hello\n\n\n\nHello';
      let result = deduplicateParagraphs(input);
      assert.strictEqual(result, 'Hello');
    });
  });

  // ===========================================================================
  // stripInteractionTags
  // ===========================================================================
  describe('stripInteractionTags()', () => {
    it('should return falsy input unchanged', () => {
      assert.strictEqual(stripInteractionTags(null), null);
      assert.strictEqual(stripInteractionTags(''), '');
    });

    it('should pass through text without interaction tags', () => {
      assert.strictEqual(stripInteractionTags('Hello world'), 'Hello world');
    });

    it('should strip a single interaction tag', () => {
      let input = 'Before <interaction>{"foo":"bar"}</interaction> After';
      let result = stripInteractionTags(input);
      assert.strictEqual(result, 'Before  After');
    });

    it('should strip multiple interaction tags', () => {
      let input = 'Text <interaction>one</interaction> more <interaction>two</interaction> end';
      let result = stripInteractionTags(input);
      assert.ok(!result.includes('<interaction>'));
      assert.ok(result.includes('Text'));
      assert.ok(result.includes('end'));
    });

    it('should handle multiline interaction tags', () => {
      let input = 'Start\n<interaction>\n{"multi":"line"}\n</interaction>\nEnd';
      let result = stripInteractionTags(input);
      assert.ok(!result.includes('<interaction>'));
      assert.ok(result.includes('Start'));
      assert.ok(result.includes('End'));
    });

    it('should collapse excess whitespace', () => {
      let input = 'Before\n\n\n\n<interaction>x</interaction>\n\n\n\nAfter';
      let result = stripInteractionTags(input);
      // Should not have more than 2 consecutive newlines
      assert.ok(!result.includes('\n\n\n'));
    });
  });

  // ===========================================================================
  // replaceInteractionTagsWithNote
  // ===========================================================================
  describe('replaceInteractionTagsWithNote()', () => {
    it('should return falsy input unchanged', () => {
      assert.strictEqual(replaceInteractionTagsWithNote(null), null);
      assert.strictEqual(replaceInteractionTagsWithNote(''), '');
    });

    it('should replace update_prompt interaction with note', () => {
      let input = 'Hello <interaction>{"target_property": "update_prompt"}</interaction>';
      let result = replaceInteractionTagsWithNote(input);
      assert.ok(result.includes('[System:'));
      assert.ok(result.includes('already been processed'));
      assert.ok(!result.includes('<interaction>'));
    });

    it('should strip non-update_prompt interactions', () => {
      let input = 'Hello <interaction>{"target_property": "websearch"}</interaction>';
      let result = replaceInteractionTagsWithNote(input);
      assert.ok(!result.includes('<interaction>'));
      assert.ok(!result.includes('[System:'));
      assert.ok(result.includes('Hello'));
    });

    it('should pass through text without interactions', () => {
      assert.strictEqual(replaceInteractionTagsWithNote('Just text'), 'Just text');
    });
  });

  // ===========================================================================
  // isInteractionOnly
  // ===========================================================================
  describe('isInteractionOnly()', () => {
    it('should return true for null/empty', () => {
      assert.strictEqual(isInteractionOnly(null), true);
      assert.strictEqual(isInteractionOnly(''), true);
    });

    it('should return true for content that is only interaction tags', () => {
      let input = '<interaction>{"target":"system"}</interaction>';
      assert.strictEqual(isInteractionOnly(input), true);
    });

    it('should return false for content with visible text', () => {
      let input = 'Hello <interaction>x</interaction>';
      assert.strictEqual(isInteractionOnly(input), false);
    });

    it('should return true for whitespace-only content after stripping', () => {
      let input = '  \n  <interaction>x</interaction>  \n  ';
      assert.strictEqual(isInteractionOnly(input), true);
    });
  });

  // ===========================================================================
  // getFriendlyErrorMessage
  // ===========================================================================
  describe('getFriendlyErrorMessage()', () => {
    it('should return generic message for null/empty', () => {
      let result = getFriendlyErrorMessage(null);
      assert.ok(result.includes('unexpected error'));
    });

    it('should return rate limit message for 429', () => {
      let result = getFriendlyErrorMessage('Error: 429 Too Many Requests');
      assert.ok(result.includes('busy'));
    });

    it('should return auth message for 401', () => {
      let result = getFriendlyErrorMessage('Error: 401 Unauthorized');
      assert.ok(result.includes('authentication'));
    });

    it('should return overloaded message for 529', () => {
      let result = getFriendlyErrorMessage('Error: 529 overloaded');
      assert.ok(result.includes('overloaded'));
    });

    it('should return timeout message', () => {
      let result = getFriendlyErrorMessage('Error: ETIMEDOUT');
      assert.ok(result.includes('timed out'));
    });

    it('should return network message for ECONNREFUSED', () => {
      let result = getFriendlyErrorMessage('Error: ECONNREFUSED');
      assert.ok(result.includes('connect'));
    });

    it('should hide raw JSON in error messages', () => {
      let result = getFriendlyErrorMessage('{"error":"some internal detail"}');
      assert.ok(!result.includes('{'));
      assert.ok(result.includes('error occurred'));
    });

    it('should pass through short, non-technical messages', () => {
      let result = getFriendlyErrorMessage('Something went wrong');
      assert.strictEqual(result, 'Something went wrong');
    });
  });

  // ===========================================================================
  // elementToAssertion
  // ===========================================================================
  describe('elementToAssertion()', () => {
    it('should return null for websearch type', () => {
      assert.strictEqual(elementToAssertion({ type: 'websearch' }), null);
    });

    it('should convert bash element to command assertion', () => {
      let element = {
        id: 'test-1',
        type: 'bash',
        content: 'ls -la',
        attributes: {},
      };
      let result = elementToAssertion(element);
      assert.strictEqual(result.assertion, 'command');
      assert.strictEqual(result.name, 'bash');
      assert.strictEqual(result.message, 'ls -la');
      assert.strictEqual(result.id, 'test-1');
    });

    it('should convert ask element to question assertion', () => {
      let element = {
        id: 'test-2',
        type: 'ask',
        content: 'What is your name?',
        attributes: { options: 'Alice,Bob,Charlie' },
      };
      let result = elementToAssertion(element);
      assert.strictEqual(result.assertion, 'question');
      assert.strictEqual(result.name, 'ask');
      assert.strictEqual(result.mode, 'demand');
      assert.deepStrictEqual(result.options, ['Alice', 'Bob', 'Charlie']);
    });

    it('should set timeout mode for ask with timeout', () => {
      let element = {
        id: 'test-3',
        type: 'ask',
        content: 'Continue?',
        attributes: { timeout: '30' },
      };
      let result = elementToAssertion(element);
      assert.strictEqual(result.mode, 'timeout');
      assert.strictEqual(result.timeout, 30000);
    });

    it('should return null for unknown element types', () => {
      assert.strictEqual(elementToAssertion({ type: 'unknown', attributes: {} }), null);
    });
  });
});
