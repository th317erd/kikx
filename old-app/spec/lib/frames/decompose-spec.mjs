'use strict';

// ============================================================================
// Frame Decomposition Tests
// ============================================================================
// Tests for the pure decomposeMessage() function that splits raw agent/user
// message text into an ordered array of content + interaction segments.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { decomposeMessage } from '../../../server/lib/frames/decompose.mjs';

// ============================================================================
// Helper: build a simple interaction tag
// ============================================================================

function makeInteractionTag(overrides = {}) {
  let interaction = {
    interaction_id: overrides.interaction_id || 'test-001',
    target_id:      overrides.target_id || '@system',
    target_property: overrides.target_property || 'websearch',
    payload:        overrides.payload || { query: 'test' },
    ...overrides,
  };
  return `<interaction>${JSON.stringify(interaction)}</interaction>`;
}

// ============================================================================
// Tests
// ============================================================================

describe('decomposeMessage', () => {

  // --------------------------------------------------------------------------
  // Simple text — no interactions
  // --------------------------------------------------------------------------

  describe('simple text (no interactions)', () => {
    it('returns single content descriptor for plain text', () => {
      let result = decomposeMessage('Hello there!', 'assistant');
      assert.deepStrictEqual(result, [
        { type: 'content', role: 'assistant', text: 'Hello there!' },
      ]);
    });

    it('returns single content descriptor for user message', () => {
      let result = decomposeMessage('How are you?', 'user');
      assert.deepStrictEqual(result, [
        { type: 'content', role: 'user', text: 'How are you?' },
      ]);
    });

    it('returns empty array for null input', () => {
      let result = decomposeMessage(null, 'assistant');
      assert.deepStrictEqual(result, []);
    });

    it('returns empty array for undefined input', () => {
      let result = decomposeMessage(undefined, 'assistant');
      assert.deepStrictEqual(result, []);
    });

    it('returns empty array for empty string', () => {
      let result = decomposeMessage('', 'assistant');
      assert.deepStrictEqual(result, []);
    });

    it('returns empty array for whitespace-only string', () => {
      let result = decomposeMessage('   \n\n  ', 'assistant');
      assert.deepStrictEqual(result, []);
    });

    it('preserves HTML content in text', () => {
      let html = '<p>Hello <strong>world</strong></p>';
      let result = decomposeMessage(html, 'assistant');
      assert.deepStrictEqual(result, [
        { type: 'content', role: 'assistant', text: html },
      ]);
    });

    it('preserves markdown content in text', () => {
      let markdown = '## Heading\n\n- item 1\n- item 2\n\n```js\nlet x = 1;\n```';
      let result = decomposeMessage(markdown, 'assistant');
      assert.deepStrictEqual(result, [
        { type: 'content', role: 'assistant', text: markdown },
      ]);
    });
  });

  // --------------------------------------------------------------------------
  // Text with one interaction
  // --------------------------------------------------------------------------

  describe('text with one interaction', () => {
    it('splits into [content, interaction, content]', () => {
      let tag = makeInteractionTag();
      let input = `I'll search for that.\n${tag}\nHere are the results.`;
      let result = decomposeMessage(input, 'assistant');

      assert.equal(result.length, 3);
      assert.equal(result[0].type, 'content');
      assert.equal(result[0].text, "I'll search for that.");
      assert.equal(result[1].type, 'interaction');
      assert.equal(result[1].raw, tag);
      assert.equal(result[1].parsed.interaction_id, 'test-001');
      assert.equal(result[1].parsed.target_id, '@system');
      assert.equal(result[1].parsed.target_property, 'websearch');
      assert.deepStrictEqual(result[1].parsed.payload, { query: 'test' });
      assert.equal(result[2].type, 'content');
      assert.equal(result[2].text, 'Here are the results.');
    });

    it('returns [interaction, content] when interaction is first', () => {
      let tag = makeInteractionTag();
      let input = `${tag}\nHere is my response.`;
      let result = decomposeMessage(input, 'assistant');

      assert.equal(result.length, 2);
      assert.equal(result[0].type, 'interaction');
      assert.equal(result[1].type, 'content');
      assert.equal(result[1].text, 'Here is my response.');
    });

    it('returns [content, interaction] when interaction is last', () => {
      let tag = makeInteractionTag();
      let input = `Let me search for that.\n${tag}`;
      let result = decomposeMessage(input, 'assistant');

      assert.equal(result.length, 2);
      assert.equal(result[0].type, 'content');
      assert.equal(result[0].text, 'Let me search for that.');
      assert.equal(result[1].type, 'interaction');
    });

    it('returns [interaction] when content is only an interaction tag', () => {
      let tag = makeInteractionTag();
      let result = decomposeMessage(tag, 'assistant');

      assert.equal(result.length, 1);
      assert.equal(result[0].type, 'interaction');
      assert.equal(result[0].parsed.interaction_id, 'test-001');
    });
  });

  // --------------------------------------------------------------------------
  // Multiple interactions
  // --------------------------------------------------------------------------

  describe('multiple interactions', () => {
    it('interleaves content and interaction segments', () => {
      let tag1 = makeInteractionTag({ interaction_id: 'int-1', target_property: 'websearch', payload: { query: 'first' } });
      let tag2 = makeInteractionTag({ interaction_id: 'int-2', target_property: 'delegate', payload: { agentId: 3 } });
      let input = `Starting.\n${tag1}\nMiddle text.\n${tag2}\nDone.`;
      let result = decomposeMessage(input, 'assistant');

      assert.equal(result.length, 5);
      assert.equal(result[0].type, 'content');
      assert.equal(result[0].text, 'Starting.');
      assert.equal(result[1].type, 'interaction');
      assert.equal(result[1].parsed.interaction_id, 'int-1');
      assert.equal(result[2].type, 'content');
      assert.equal(result[2].text, 'Middle text.');
      assert.equal(result[3].type, 'interaction');
      assert.equal(result[3].parsed.interaction_id, 'int-2');
      assert.equal(result[4].type, 'content');
      assert.equal(result[4].text, 'Done.');
    });

    it('handles consecutive interactions with no text between', () => {
      let tag1 = makeInteractionTag({ interaction_id: 'int-1' });
      let tag2 = makeInteractionTag({ interaction_id: 'int-2' });
      let input = `Before.\n${tag1}\n${tag2}\nAfter.`;
      let result = decomposeMessage(input, 'assistant');

      assert.equal(result.length, 4);
      assert.equal(result[0].type, 'content');
      assert.equal(result[1].type, 'interaction');
      assert.equal(result[1].parsed.interaction_id, 'int-1');
      assert.equal(result[2].type, 'interaction');
      assert.equal(result[2].parsed.interaction_id, 'int-2');
      assert.equal(result[3].type, 'content');
    });
  });

  // --------------------------------------------------------------------------
  // Empty content segments are skipped
  // --------------------------------------------------------------------------

  describe('empty content segments', () => {
    it('skips whitespace-only content between tags', () => {
      let tag = makeInteractionTag();
      let input = `   \n\n${tag}\n   \n`;
      let result = decomposeMessage(input, 'assistant');

      assert.equal(result.length, 1);
      assert.equal(result[0].type, 'interaction');
    });

    it('skips empty content created by adjacent interaction tags', () => {
      let tag1 = makeInteractionTag({ interaction_id: 'int-1' });
      let tag2 = makeInteractionTag({ interaction_id: 'int-2' });
      let input = `${tag1}${tag2}`;
      let result = decomposeMessage(input, 'assistant');

      assert.equal(result.length, 2);
      assert.equal(result[0].type, 'interaction');
      assert.equal(result[1].type, 'interaction');
    });
  });

  // --------------------------------------------------------------------------
  // Malformed interactions → treated as content
  // --------------------------------------------------------------------------

  describe('malformed interactions', () => {
    it('treats malformed JSON as content', () => {
      let input = 'Before.\n<interaction>this is not json</interaction>\nAfter.';
      let result = decomposeMessage(input, 'assistant');

      // The malformed tag can't be parsed — entire thing is content
      assert.equal(result.length, 1);
      assert.equal(result[0].type, 'content');
      assert.ok(result[0].text.includes('Before.'));
      assert.ok(result[0].text.includes('After.'));
    });

    it('treats interaction with missing required fields as content', () => {
      // Missing target_id, target_property, interaction_id
      let input = 'Before.\n<interaction>{"foo": "bar"}</interaction>\nAfter.';
      let result = decomposeMessage(input, 'assistant');

      assert.equal(result.length, 1);
      assert.equal(result[0].type, 'content');
    });

    it('handles unclosed interaction tag as content', () => {
      let input = 'Before.\n<interaction>{"test": true}\nAfter with no closing tag.';
      let result = decomposeMessage(input, 'assistant');

      assert.equal(result.length, 1);
      assert.equal(result[0].type, 'content');
    });
  });

  // --------------------------------------------------------------------------
  // sender_id stripping
  // --------------------------------------------------------------------------

  describe('sender_id stripping', () => {
    it('strips sender_id from parsed interaction', () => {
      let json = JSON.stringify({
        interaction_id:  'test-001',
        target_id:       '@system',
        target_property: 'websearch',
        sender_id:       'agent:5',
        payload:         { query: 'test' },
      });
      let input = `<interaction>${json}</interaction>`;
      let result = decomposeMessage(input, 'assistant');

      assert.equal(result.length, 1);
      assert.equal(result[0].type, 'interaction');
      assert.equal(result[0].parsed.sender_id, undefined);
      assert.equal(result[0].parsed.interaction_id, 'test-001');
    });
  });

  // --------------------------------------------------------------------------
  // Interaction with HTML attributes (LLM format deviation)
  // --------------------------------------------------------------------------

  describe('interaction with HTML attributes', () => {
    it('handles interaction tag with attributes', () => {
      let json = JSON.stringify({
        interaction_id:  'test-001',
        target_id:       '@system',
        target_property: 'websearch',
        payload:         { query: 'test' },
      });
      let input = `Before.\n<interaction type="websearch">${json}</interaction>\nAfter.`;
      let result = decomposeMessage(input, 'assistant');

      assert.equal(result.length, 3);
      assert.equal(result[0].type, 'content');
      assert.equal(result[1].type, 'interaction');
      assert.equal(result[1].parsed.target_property, 'websearch');
      assert.equal(result[2].type, 'content');
    });
  });

  // --------------------------------------------------------------------------
  // Nested/escaped interaction-like strings inside JSON payload
  // --------------------------------------------------------------------------

  describe('nested interaction-like strings in payload', () => {
    it('handles JSON payload containing </interaction> text in a string value', () => {
      let json = JSON.stringify({
        interaction_id:  'test-001',
        target_id:       '@system',
        target_property: 'websearch',
        payload:         { query: 'search for </interaction> tag parsing' },
      });
      // Note: The JSON.stringify will escape the < and > but not the string itself.
      // The real test is whether the parser finds the right closing tag.
      let input = `Before.\n<interaction>${json}</interaction>\nAfter.`;
      let result = decomposeMessage(input, 'assistant');

      // Should successfully parse — the </interaction> inside the JSON string
      // is escaped by the JSON serializer
      assert.equal(result.length, 3);
      assert.equal(result[1].type, 'interaction');
    });
  });

  // --------------------------------------------------------------------------
  // Role mapping
  // --------------------------------------------------------------------------

  describe('role mapping', () => {
    it('uses assistant role for agent authorType', () => {
      let result = decomposeMessage('Hello', 'agent');
      assert.equal(result[0].role, 'assistant');
    });

    it('uses assistant role for assistant authorType', () => {
      let result = decomposeMessage('Hello', 'assistant');
      assert.equal(result[0].role, 'assistant');
    });

    it('uses user role for user authorType', () => {
      let result = decomposeMessage('Hello', 'user');
      assert.equal(result[0].role, 'user');
    });

    it('uses user role for system authorType', () => {
      let result = decomposeMessage('Hello', 'system');
      assert.equal(result[0].role, 'user');
    });
  });

  // --------------------------------------------------------------------------
  // Idempotency
  // --------------------------------------------------------------------------

  describe('idempotency', () => {
    it('same input always produces same output', () => {
      let tag = makeInteractionTag();
      let input = `Text before.\n${tag}\nText after.`;
      let result1 = decomposeMessage(input, 'assistant');
      let result2 = decomposeMessage(input, 'assistant');
      assert.deepStrictEqual(result1, result2);
    });
  });

  // --------------------------------------------------------------------------
  // Edge cases
  // --------------------------------------------------------------------------

  describe('edge cases', () => {
    it('handles interaction tag on its own line with surrounding newlines', () => {
      let tag = makeInteractionTag();
      let input = `First paragraph.\n\n${tag}\n\nSecond paragraph.`;
      let result = decomposeMessage(input, 'assistant');

      assert.equal(result.length, 3);
      assert.equal(result[0].type, 'content');
      assert.equal(result[1].type, 'interaction');
      assert.equal(result[2].type, 'content');
    });

    it('handles very long content segments', () => {
      let longText = 'A'.repeat(10000);
      let tag = makeInteractionTag();
      let input = `${longText}\n${tag}\n${longText}`;
      let result = decomposeMessage(input, 'assistant');

      assert.equal(result.length, 3);
      assert.equal(result[0].text, longText);
      assert.equal(result[2].text, longText);
    });

    it('handles interaction with array payload in JSON', () => {
      let json = JSON.stringify({
        interaction_id:  'test-001',
        target_id:       '@system',
        target_property: 'delegate',
        payload:         { agents: [1, 2, 3] },
      });
      let input = `<interaction>${json}</interaction>`;
      let result = decomposeMessage(input, 'assistant');

      assert.equal(result.length, 1);
      assert.equal(result[0].type, 'interaction');
      assert.deepStrictEqual(result[0].parsed.payload.agents, [1, 2, 3]);
    });
  });
});
