'use strict';

import { describe, it } from 'node:test';
import assert            from 'node:assert/strict';

import { SelectorCompiler } from '../../../src/core/routing/selector-compiler.mjs';

// =============================================================================
// Helpers
// =============================================================================

function makeFrame(overrides) {
  return { id: 'f1', type: 'UserMessage', content: {}, ...overrides };
}

// =============================================================================
// SelectorCompiler
// =============================================================================

describe('SelectorCompiler', () => {

  // ---------------------------------------------------------------------------
  // type selectors
  // ---------------------------------------------------------------------------

  describe('type selectors', () => {
    it('should match frame.type for type:UserMessage', () => {
      let matcher = SelectorCompiler.compile('type:UserMessage');
      assert.strictEqual(matcher(makeFrame({ type: 'UserMessage' })), true);
      assert.strictEqual(matcher(makeFrame({ type: 'ToolCall' })), false);
    });

    it('should match frame.type for type:ToolCall', () => {
      let matcher = SelectorCompiler.compile('type:ToolCall');
      assert.strictEqual(matcher(makeFrame({ type: 'ToolCall' })), true);
      assert.strictEqual(matcher(makeFrame({ type: 'UserMessage' })), false);
    });

    it('should match frame.type for type:agent-response', () => {
      let matcher = SelectorCompiler.compile('type:agent-response');
      assert.strictEqual(matcher(makeFrame({ type: 'agent-response' })), true);
      assert.strictEqual(matcher(makeFrame({ type: 'UserMessage' })), false);
    });

    it('should handle hyphenated type names correctly', () => {
      let matcher = SelectorCompiler.compile('type:long-kebab-case-name');
      assert.strictEqual(matcher(makeFrame({ type: 'long-kebab-case-name' })), true);
      assert.strictEqual(matcher(makeFrame({ type: 'long-kebab-case' })), false);
    });
  });

  // ---------------------------------------------------------------------------
  // wildcard
  // ---------------------------------------------------------------------------

  describe('wildcard type:*', () => {
    it('should match any frame', () => {
      let matcher = SelectorCompiler.compile('type:*');
      assert.strictEqual(matcher(makeFrame({ type: 'UserMessage' })), true);
      assert.strictEqual(matcher(makeFrame({ type: 'ToolCall' })), true);
      assert.strictEqual(matcher(makeFrame({ type: 'anything' })), true);
    });

    it('should match frames with no type', () => {
      let matcher = SelectorCompiler.compile('type:*');
      assert.strictEqual(matcher(makeFrame({ type: undefined })), true);
    });

    it('should reject type:* with property matcher', () => {
      assert.throws(
        () => SelectorCompiler.compile('type:*[foo=bar]'),
        { message: /wildcard.*cannot have property matchers/i },
      );
    });
  });

  // ---------------------------------------------------------------------------
  // author selectors
  // ---------------------------------------------------------------------------

  describe('author selectors', () => {
    it('should match frame.authorType for author:agent', () => {
      let matcher = SelectorCompiler.compile('author:agent');
      assert.strictEqual(matcher(makeFrame({ authorType: 'agent' })), true);
      assert.strictEqual(matcher(makeFrame({ authorType: 'user' })), false);
    });

    it('should match frame.authorType for author:user', () => {
      let matcher = SelectorCompiler.compile('author:user');
      assert.strictEqual(matcher(makeFrame({ authorType: 'user' })), true);
      assert.strictEqual(matcher(makeFrame({ authorType: 'agent' })), false);
    });

    it('should match frame.authorType for author:system', () => {
      let matcher = SelectorCompiler.compile('author:system');
      assert.strictEqual(matcher(makeFrame({ authorType: 'system' })), true);
      assert.strictEqual(matcher(makeFrame({ authorType: 'user' })), false);
    });

    it('should return false when frame has no authorType', () => {
      let matcher = SelectorCompiler.compile('author:agent');
      assert.strictEqual(matcher(makeFrame({})), false);
    });

    it('should reject author selectors with property matchers', () => {
      assert.throws(
        () => SelectorCompiler.compile('author:agent[foo=bar]'),
        { message: /author selectors do not support property matchers/i },
      );
    });
  });

  // ---------------------------------------------------------------------------
  // property matchers
  // ---------------------------------------------------------------------------

  describe('property matchers [prop=value]', () => {
    it('should match type + content property', () => {
      let matcher = SelectorCompiler.compile('type:ToolCall[toolName=shell:execute]');
      let frame   = makeFrame({
        type:    'ToolCall',
        content: { toolName: 'shell:execute' },
      });
      assert.strictEqual(matcher(frame), true);
    });

    it('should reject when type matches but property does not', () => {
      let matcher = SelectorCompiler.compile('type:ToolCall[toolName=shell:execute]');
      let frame   = makeFrame({
        type:    'ToolCall',
        content: { toolName: 'web:fetch' },
      });
      assert.strictEqual(matcher(frame), false);
    });

    it('should reject when type does not match', () => {
      let matcher = SelectorCompiler.compile('type:ToolCall[toolName=shell:execute]');
      let frame   = makeFrame({
        type:    'UserMessage',
        content: { toolName: 'shell:execute' },
      });
      assert.strictEqual(matcher(frame), false);
    });

    it('should reject when content is null', () => {
      let matcher = SelectorCompiler.compile('type:ToolCall[toolName=shell:execute]');
      let frame   = makeFrame({ type: 'ToolCall', content: null });
      assert.strictEqual(matcher(frame), false);
    });

    it('should reject when content is undefined', () => {
      let matcher = SelectorCompiler.compile('type:ToolCall[toolName=shell:execute]');
      let frame   = makeFrame({ type: 'ToolCall', content: undefined });
      assert.strictEqual(matcher(frame), false);
    });

    it('should reject when content is a non-object', () => {
      let matcher = SelectorCompiler.compile('type:ToolCall[toolName=shell:execute]');
      let frame   = makeFrame({ type: 'ToolCall', content: 'string' });
      assert.strictEqual(matcher(frame), false);
    });

    it('should reject when content property is missing', () => {
      let matcher = SelectorCompiler.compile('type:ToolCall[toolName=shell:execute]');
      let frame   = makeFrame({ type: 'ToolCall', content: { other: 'value' } });
      assert.strictEqual(matcher(frame), false);
    });

    it('should handle colons in property values', () => {
      let matcher = SelectorCompiler.compile('type:ToolCall[toolName=shell:execute]');
      let frame   = makeFrame({
        type:    'ToolCall',
        content: { toolName: 'shell:execute' },
      });
      assert.strictEqual(matcher(frame), true);
    });
  });

  // ---------------------------------------------------------------------------
  // function predicates
  // ---------------------------------------------------------------------------

  describe('function predicates', () => {
    it('should pass through a function as-is', () => {
      let fn      = (frame) => frame.type === 'custom';
      let matcher = SelectorCompiler.compile(fn);
      assert.strictEqual(matcher, fn);
    });

    it('should work with the passed-through function', () => {
      let matcher = SelectorCompiler.compile((frame) => frame.id === 'target');
      assert.strictEqual(matcher(makeFrame({ id: 'target' })), true);
      assert.strictEqual(matcher(makeFrame({ id: 'other' })), false);
    });
  });

  // ---------------------------------------------------------------------------
  // invalid selectors
  // ---------------------------------------------------------------------------

  describe('invalid selectors', () => {
    it('should throw on empty string', () => {
      assert.throws(
        () => SelectorCompiler.compile(''),
        { message: /Invalid selector/ },
      );
    });

    it('should throw on null', () => {
      assert.throws(
        () => SelectorCompiler.compile(null),
        { message: /Invalid selector/ },
      );
    });

    it('should throw on undefined', () => {
      assert.throws(
        () => SelectorCompiler.compile(undefined),
        { message: /Invalid selector/ },
      );
    });

    it('should throw on number', () => {
      assert.throws(
        () => SelectorCompiler.compile(42),
        { message: /Invalid selector/ },
      );
    });

    it('should throw on boolean', () => {
      assert.throws(
        () => SelectorCompiler.compile(true),
        { message: /Invalid selector/ },
      );
    });

    it('should throw on malformed string (no dimension)', () => {
      assert.throws(
        () => SelectorCompiler.compile('UserMessage'),
        { message: /Invalid selector syntax/ },
      );
    });

    it('should throw on unknown dimension', () => {
      assert.throws(
        () => SelectorCompiler.compile('status:active'),
        { message: /Invalid selector syntax/ },
      );
    });

    it('should throw on empty dimension value', () => {
      assert.throws(
        () => SelectorCompiler.compile('type:'),
        { message: /Invalid selector syntax/ },
      );
    });
  });

  // ---------------------------------------------------------------------------
  // edge cases
  // ---------------------------------------------------------------------------

  describe('edge cases', () => {
    it('should return a new function each time (no shared state)', () => {
      let m1 = SelectorCompiler.compile('type:UserMessage');
      let m2 = SelectorCompiler.compile('type:UserMessage');
      assert.notStrictEqual(m1, m2);
    });

    it('should handle frame with missing type gracefully', () => {
      let matcher = SelectorCompiler.compile('type:UserMessage');
      assert.strictEqual(matcher({}), false);
      assert.strictEqual(matcher({ type: undefined }), false);
    });

    it('should handle frame with missing authorType gracefully', () => {
      let matcher = SelectorCompiler.compile('author:agent');
      assert.strictEqual(matcher({}), false);
    });
  });
});
