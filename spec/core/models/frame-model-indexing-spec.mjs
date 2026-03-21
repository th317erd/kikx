'use strict';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Frame } from '../../../src/core/models/frame-model.mjs';

// =============================================================================
// Helper: create a minimal Frame-like instance with type and content
// =============================================================================
// We bypass the ORM connection by directly setting properties on a bare object
// that inherits Frame's prototype. This lets us test getContentForIndexing()
// without starting the full application or database.
// =============================================================================

function createTestFrame({ type, content } = {}) {
  let frame = Object.create(Frame.prototype);
  frame.type = type;
  frame.content = content;
  return frame;
}

// =============================================================================
// Frame.getContentForIndexing() Tests
// =============================================================================

describe('Frame.getContentForIndexing()', () => {

  // ===========================================================================
  // Return format invariants
  // ===========================================================================

  describe('return format', () => {
    it('should always return an array', () => {
      let frame  = createTestFrame({ type: 'message', content: JSON.stringify({ text: 'hi' }) });
      let result = frame.getContentForIndexing();
      assert.ok(Array.isArray(result), 'result should be an array');
    });

    it('should return entries with { field, value } shape', () => {
      let frame  = createTestFrame({ type: 'message', content: JSON.stringify({ text: 'hi' }) });
      let result = frame.getContentForIndexing();
      assert.ok(result.length > 0, 'should have at least one entry');
      for (let entry of result) {
        assert.equal(typeof entry.field, 'string', 'field should be a string');
        assert.equal(typeof entry.value, 'string', 'value should be a string');
      }
    });

    it('should return empty array when content is null', () => {
      let frame  = createTestFrame({ type: 'message', content: null });
      let result = frame.getContentForIndexing();
      assert.deepStrictEqual(result, []);
    });

    it('should return empty array when content is undefined', () => {
      let frame  = createTestFrame({ type: 'message', content: undefined });
      let result = frame.getContentForIndexing();
      assert.deepStrictEqual(result, []);
    });
  });

  // ===========================================================================
  // Happy paths — one test per frame type
  // ===========================================================================

  describe('user-message type', () => {
    it('should extract text content', () => {
      let frame  = createTestFrame({ type: 'user-message', content: JSON.stringify({ text: 'Hello world' }) });
      let result = frame.getContentForIndexing();
      assert.ok(result.some((e) => e.field === 'content' && e.value === 'Hello world'));
    });

    it('should extract html content', () => {
      let frame  = createTestFrame({ type: 'user-message', content: JSON.stringify({ html: '<p>Hello</p>' }) });
      let result = frame.getContentForIndexing();
      assert.ok(result.some((e) => e.field === 'content' && e.value === '<p>Hello</p>'));
    });

    it('should extract both text and html, preferring text', () => {
      let frame  = createTestFrame({ type: 'user-message', content: JSON.stringify({ text: 'plain', html: '<b>bold</b>' }) });
      let result = frame.getContentForIndexing();
      assert.ok(result.some((e) => e.field === 'content' && e.value === 'plain'));
    });
  });

  describe('message type', () => {
    it('should extract text content', () => {
      let frame  = createTestFrame({ type: 'message', content: JSON.stringify({ text: 'Agent says hi' }) });
      let result = frame.getContentForIndexing();
      assert.ok(result.some((e) => e.field === 'content' && e.value === 'Agent says hi'));
    });

    it('should extract html when no text', () => {
      let frame  = createTestFrame({ type: 'message', content: JSON.stringify({ html: '<em>styled</em>' }) });
      let result = frame.getContentForIndexing();
      assert.ok(result.some((e) => e.field === 'content' && e.value === '<em>styled</em>'));
    });
  });

  describe('reflection type', () => {
    it('should extract text content', () => {
      let frame  = createTestFrame({ type: 'reflection', content: JSON.stringify({ text: 'Thinking about it...' }) });
      let result = frame.getContentForIndexing();
      assert.ok(result.some((e) => e.field === 'content' && e.value === 'Thinking about it...'));
    });

    it('should extract html when no text', () => {
      let frame  = createTestFrame({ type: 'reflection', content: JSON.stringify({ html: '<p>Deep thought</p>' }) });
      let result = frame.getContentForIndexing();
      assert.ok(result.some((e) => e.field === 'content' && e.value === '<p>Deep thought</p>'));
    });
  });

  describe('tool-call type', () => {
    it('should serialize toolName and arguments', () => {
      let content = JSON.stringify({ toolName: 'shell:execute', arguments: { command: 'ls' } });
      let frame   = createTestFrame({ type: 'tool-call', content });
      let result  = frame.getContentForIndexing();
      assert.ok(result.some((e) => e.field === 'content' && e.value === 'shell:execute: {"command":"ls"}'));
    });

    it('should handle missing arguments', () => {
      let content = JSON.stringify({ toolName: 'shell:execute' });
      let frame   = createTestFrame({ type: 'tool-call', content });
      let result  = frame.getContentForIndexing();
      assert.ok(result.some((e) => e.field === 'content' && e.value === 'shell:execute: {}'));
    });

    it('should handle missing toolName', () => {
      let content = JSON.stringify({ arguments: { command: 'ls' } });
      let frame   = createTestFrame({ type: 'tool-call', content });
      let result  = frame.getContentForIndexing();
      assert.ok(result.some((e) => e.field === 'content' && e.value === ': {"command":"ls"}'));
    });
  });

  describe('tool-result type', () => {
    it('should extract string result', () => {
      let content = JSON.stringify({ result: 'command output here' });
      let frame   = createTestFrame({ type: 'tool-result', content });
      let result  = frame.getContentForIndexing();
      assert.ok(result.some((e) => e.field === 'content' && e.value === 'command output here'));
    });

    it('should JSON.stringify non-string result', () => {
      let content = JSON.stringify({ result: { data: [1, 2, 3] } });
      let frame   = createTestFrame({ type: 'tool-result', content });
      let result  = frame.getContentForIndexing();
      assert.ok(result.some((e) => e.field === 'content' && e.value === '{"data":[1,2,3]}'));
    });

    it('should handle undefined result', () => {
      let content = JSON.stringify({});
      let frame   = createTestFrame({ type: 'tool-result', content });
      let result  = frame.getContentForIndexing();
      assert.deepStrictEqual(result, []);
    });
  });

  describe('tool-error type', () => {
    it('should extract message', () => {
      let content = JSON.stringify({ message: 'Something failed' });
      let frame   = createTestFrame({ type: 'tool-error', content });
      let result  = frame.getContentForIndexing();
      assert.ok(result.some((e) => e.field === 'content' && e.value === 'Something failed'));
    });

    it('should fall back to error', () => {
      let content = JSON.stringify({ error: 'ENOENT' });
      let frame   = createTestFrame({ type: 'tool-error', content });
      let result  = frame.getContentForIndexing();
      assert.ok(result.some((e) => e.field === 'content' && e.value === 'ENOENT'));
    });

    it('should fall back to text', () => {
      let content = JSON.stringify({ text: 'error text' });
      let frame   = createTestFrame({ type: 'tool-error', content });
      let result  = frame.getContentForIndexing();
      assert.ok(result.some((e) => e.field === 'content' && e.value === 'error text'));
    });

    it('should return empty array when none of message/error/text exist', () => {
      let content = JSON.stringify({ code: 404 });
      let frame   = createTestFrame({ type: 'tool-error', content });
      let result  = frame.getContentForIndexing();
      assert.deepStrictEqual(result, []);
    });
  });

  describe('error type', () => {
    it('should extract message', () => {
      let content = JSON.stringify({ message: 'Internal error' });
      let frame   = createTestFrame({ type: 'error', content });
      let result  = frame.getContentForIndexing();
      assert.ok(result.some((e) => e.field === 'content' && e.value === 'Internal error'));
    });

    it('should fall back to error', () => {
      let content = JSON.stringify({ error: 'crash' });
      let frame   = createTestFrame({ type: 'error', content });
      let result  = frame.getContentForIndexing();
      assert.ok(result.some((e) => e.field === 'content' && e.value === 'crash'));
    });

    it('should fall back to text', () => {
      let content = JSON.stringify({ text: 'err text' });
      let frame   = createTestFrame({ type: 'error', content });
      let result  = frame.getContentForIndexing();
      assert.ok(result.some((e) => e.field === 'content' && e.value === 'err text'));
    });
  });

  describe('permission-denied type', () => {
    it('should extract message', () => {
      let content = JSON.stringify({ message: 'Access denied' });
      let frame   = createTestFrame({ type: 'permission-denied', content });
      let result  = frame.getContentForIndexing();
      assert.ok(result.some((e) => e.field === 'content' && e.value === 'Access denied'));
    });

    it('should fall back to reason', () => {
      let content = JSON.stringify({ reason: 'Insufficient privileges' });
      let frame   = createTestFrame({ type: 'permission-denied', content });
      let result  = frame.getContentForIndexing();
      assert.ok(result.some((e) => e.field === 'content' && e.value === 'Insufficient privileges'));
    });
  });

  describe('stop type', () => {
    it('should extract text', () => {
      let content = JSON.stringify({ text: 'Stopped by user' });
      let frame   = createTestFrame({ type: 'stop', content });
      let result  = frame.getContentForIndexing();
      assert.ok(result.some((e) => e.field === 'content' && e.value === 'Stopped by user'));
    });

    it('should fall back to message', () => {
      let content = JSON.stringify({ message: 'Stop requested' });
      let frame   = createTestFrame({ type: 'stop', content });
      let result  = frame.getContentForIndexing();
      assert.ok(result.some((e) => e.field === 'content' && e.value === 'Stop requested'));
    });
  });

  describe('hook-blocked type', () => {
    it('should extract text', () => {
      let content = JSON.stringify({ text: 'Blocked by hook' });
      let frame   = createTestFrame({ type: 'hook-blocked', content });
      let result  = frame.getContentForIndexing();
      assert.ok(result.some((e) => e.field === 'content' && e.value === 'Blocked by hook'));
    });

    it('should fall back to message', () => {
      let content = JSON.stringify({ message: 'Hook denied' });
      let frame   = createTestFrame({ type: 'hook-blocked', content });
      let result  = frame.getContentForIndexing();
      assert.ok(result.some((e) => e.field === 'content' && e.value === 'Hook denied'));
    });
  });

  describe('tool-activity type', () => {
    it('should extract html', () => {
      let content = JSON.stringify({ html: '<div>Processing...</div>' });
      let frame   = createTestFrame({ type: 'tool-activity', content });
      let result  = frame.getContentForIndexing();
      assert.ok(result.some((e) => e.field === 'content' && e.value === '<div>Processing...</div>'));
    });

    it('should return empty array when html is missing', () => {
      let content = JSON.stringify({ text: 'no html here' });
      let frame   = createTestFrame({ type: 'tool-activity', content });
      let result  = frame.getContentForIndexing();
      assert.deepStrictEqual(result, []);
    });
  });

  // ===========================================================================
  // Default handler — unknown frame types
  // ===========================================================================

  describe('unknown/default frame type', () => {
    it('should JSON.stringify the content for unknown type', () => {
      let contentObj = { custom: 'data', nested: { value: 42 } };
      let frame      = createTestFrame({ type: 'custom-unknown', content: JSON.stringify(contentObj) });
      let result     = frame.getContentForIndexing();
      assert.ok(result.some((e) => e.field === 'content' && e.value === JSON.stringify(contentObj)));
    });

    it('should handle null type as default case', () => {
      let contentObj = { text: 'something' };
      let frame      = createTestFrame({ type: null, content: JSON.stringify(contentObj) });
      let result     = frame.getContentForIndexing();
      assert.ok(result.some((e) => e.field === 'content'));
    });

    it('should handle undefined type as default case', () => {
      let contentObj = { text: 'something' };
      let frame      = createTestFrame({ type: undefined, content: JSON.stringify(contentObj) });
      let result     = frame.getContentForIndexing();
      assert.ok(result.some((e) => e.field === 'content'));
    });

    it('should handle empty string type as default case', () => {
      let contentObj = { text: 'something' };
      let frame      = createTestFrame({ type: '', content: JSON.stringify(contentObj) });
      let result     = frame.getContentForIndexing();
      assert.ok(result.some((e) => e.field === 'content'));
    });
  });

  // ===========================================================================
  // Content format variations
  // ===========================================================================

  describe('content format variations', () => {
    it('should handle object content directly (already parsed)', () => {
      let frame  = createTestFrame({ type: 'message', content: { text: 'already an object' } });
      let result = frame.getContentForIndexing();
      assert.ok(result.some((e) => e.field === 'content' && e.value === 'already an object'));
    });

    it('should handle non-JSON string content as raw text', () => {
      let frame  = createTestFrame({ type: 'message', content: 'just plain text, not JSON' });
      let result = frame.getContentForIndexing();
      assert.ok(result.some((e) => e.field === 'content' && e.value === 'just plain text, not JSON'));
    });

    it('should handle empty string content', () => {
      let frame  = createTestFrame({ type: 'message', content: '' });
      let result = frame.getContentForIndexing();
      assert.deepStrictEqual(result, []);
    });

    it('should handle broken JSON string as raw text', () => {
      let frame  = createTestFrame({ type: 'message', content: '{ broken json: }}}' });
      let result = frame.getContentForIndexing();
      assert.ok(result.some((e) => e.field === 'content' && e.value === '{ broken json: }}}'));
    });

    it('should handle content that is a number', () => {
      let frame  = createTestFrame({ type: 'message', content: 42 });
      let result = frame.getContentForIndexing();
      assert.ok(Array.isArray(result));
      // Number content goes through default — JSON.stringify
    });

    it('should handle content that is a boolean', () => {
      let frame  = createTestFrame({ type: 'message', content: true });
      let result = frame.getContentForIndexing();
      assert.ok(Array.isArray(result));
    });

    it('should handle content that is an array', () => {
      let frame  = createTestFrame({ type: 'message', content: JSON.stringify([1, 2, 3]) });
      let result = frame.getContentForIndexing();
      assert.ok(Array.isArray(result));
    });

    it('should handle empty content object {}', () => {
      let frame  = createTestFrame({ type: 'message', content: JSON.stringify({}) });
      let result = frame.getContentForIndexing();
      // No text or html in empty object — should return []
      assert.deepStrictEqual(result, []);
    });
  });

  // ===========================================================================
  // Sad paths — getContent() throws
  // ===========================================================================

  describe('getContent() throws', () => {
    it('should return empty array when getContent() throws', () => {
      let frame = createTestFrame({ type: 'message', content: null });
      // Override getContent to throw
      frame.getContent = () => { throw new Error('Boom'); };
      let result = frame.getContentForIndexing();
      assert.deepStrictEqual(result, []);
    });
  });

  // ===========================================================================
  // Sad paths — tool-call edge cases
  // ===========================================================================

  describe('tool-call edge cases', () => {
    it('should handle tool-call with empty arguments object', () => {
      let content = JSON.stringify({ toolName: 'test:tool', arguments: {} });
      let frame   = createTestFrame({ type: 'tool-call', content });
      let result  = frame.getContentForIndexing();
      assert.ok(result.some((e) => e.field === 'content' && e.value === 'test:tool: {}'));
    });

    it('should handle tool-call with null arguments', () => {
      let content = JSON.stringify({ toolName: 'test:tool', arguments: null });
      let frame   = createTestFrame({ type: 'tool-call', content });
      let result  = frame.getContentForIndexing();
      assert.ok(result.some((e) => e.field === 'content' && e.value === 'test:tool: {}'));
    });
  });

  // ===========================================================================
  // Sad paths — tool-result edge cases
  // ===========================================================================

  describe('tool-result edge cases', () => {
    it('should handle tool-result with null result', () => {
      let content = JSON.stringify({ result: null });
      let frame   = createTestFrame({ type: 'tool-result', content });
      let result  = frame.getContentForIndexing();
      assert.deepStrictEqual(result, []);
    });

    it('should handle tool-result with numeric result', () => {
      let content = JSON.stringify({ result: 42 });
      let frame   = createTestFrame({ type: 'tool-result', content });
      let result  = frame.getContentForIndexing();
      assert.ok(result.some((e) => e.field === 'content' && e.value === '42'));
    });

    it('should handle tool-result with boolean result', () => {
      let content = JSON.stringify({ result: true });
      let frame   = createTestFrame({ type: 'tool-result', content });
      let result  = frame.getContentForIndexing();
      assert.ok(result.some((e) => e.field === 'content' && e.value === 'true'));
    });
  });

  // ===========================================================================
  // Edge cases — large content, unicode, etc.
  // ===========================================================================

  describe('edge cases', () => {
    it('should return large text fully (no truncation)', () => {
      let largeText = 'x'.repeat(100_000);
      let frame     = createTestFrame({ type: 'message', content: JSON.stringify({ text: largeText }) });
      let result    = frame.getContentForIndexing();
      assert.ok(result.some((e) => e.field === 'content' && e.value.length === 100_000));
    });

    it('should handle unicode and emoji content', () => {
      let text   = 'Hello \u{1F600} \u{1F680} \u4E16\u754C';
      let frame  = createTestFrame({ type: 'message', content: JSON.stringify({ text }) });
      let result = frame.getContentForIndexing();
      assert.ok(result.some((e) => e.field === 'content' && e.value === text));
    });

    it('should handle RTL text', () => {
      let text   = '\u0645\u0631\u062D\u0628\u0627 \u0628\u0627\u0644\u0639\u0627\u0644\u0645';
      let frame  = createTestFrame({ type: 'message', content: JSON.stringify({ text }) });
      let result = frame.getContentForIndexing();
      assert.ok(result.some((e) => e.field === 'content' && e.value === text));
    });

    it('should catch circular reference in default JSON.stringify', () => {
      let circular = {};
      circular.self = circular;
      let frame = createTestFrame({ type: 'custom-type', content: null });
      // Override getContent to return a circular object
      frame.getContent = () => circular;
      let result = frame.getContentForIndexing();
      // Should not throw, should return []
      assert.deepStrictEqual(result, []);
    });

    it('should never throw regardless of input', () => {
      let edgeCases = [
        { type: null, content: null },
        { type: undefined, content: undefined },
        { type: 123, content: 456 },
        { type: 'message', content: Symbol('test') },
        { type: 'message', content: () => {} },
      ];

      for (let edgeCase of edgeCases) {
        let frame = createTestFrame(edgeCase);
        assert.doesNotThrow(() => frame.getContentForIndexing());
      }
    });
  });
});
