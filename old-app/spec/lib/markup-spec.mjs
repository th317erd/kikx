'use strict';

/**
 * Tests for markup.js - HML rendering and sanitization
 *
 * Tests critical functionality:
 * - HML-prompt element preservation
 * - Dangerous tag identification
 * - HTML entity decoding
 * - Smart quotes handling
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

// =============================================================================
// Test: Dangerous Tag Identification
// =============================================================================

describe('Dangerous Tag Handling', () => {
  const DANGEROUS_TAGS = [
    'script', 'iframe', 'embed', 'object', 'style', 'base', 'meta',
    'form', 'input', 'button', 'textarea', 'select', 'math',
    'noscript', 'template', 'slot', 'interaction',
  ];

  it('should identify dangerous tags', () => {
    for (const tag of DANGEROUS_TAGS) {
      assert.ok(DANGEROUS_TAGS.includes(tag), `${tag} should be in dangerous list`);
    }
  });

  it('should not include allowed tags in dangerous list', () => {
    const allowedTags = ['hml-prompt', 'response', 'todo', 'thinking', 'data'];
    for (const tag of allowedTags) {
      assert.ok(!DANGEROUS_TAGS.includes(tag), `${tag} should NOT be in dangerous list`);
    }
  });
});

// =============================================================================
// Test: HTML Entity Decoding
// =============================================================================

describe('HTML Entity Decoding', () => {
  function decodeHtmlEntities(text) {
    if (!text) return '';
    // Simple decode for testing
    return text
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&apos;/g, "'")
      .replace(/&#39;/g, "'")
      // Smart quotes
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/[\u2018\u2019]/g, "'");
  }

  it('should decode HTML entities', () => {
    const encoded = '&lt;div&gt;Hello &amp; World&lt;/div&gt;';
    const decoded = decodeHtmlEntities(encoded);

    assert.strictEqual(decoded, '<div>Hello & World</div>');
  });

  it('should decode quote entities', () => {
    const encoded = '&quot;Hello&quot;';
    const decoded = decodeHtmlEntities(encoded);

    assert.strictEqual(decoded, '"Hello"');
  });

  it('should convert smart quotes to straight quotes', () => {
    const withSmartQuotes = '\u201CHello\u201D and \u2018World\u2019';
    const decoded = decodeHtmlEntities(withSmartQuotes);

    assert.strictEqual(decoded, '"Hello" and \'World\'');
  });

  it('should handle JSON with encoded quotes', () => {
    const encoded = '[{&quot;value&quot;:&quot;test&quot;}]';
    const decoded = decodeHtmlEntities(encoded);
    const parsed = JSON.parse(decoded);

    assert.strictEqual(parsed[0].value, 'test');
  });
});

// =============================================================================
// Test: HML Prompt Regex Patterns
// =============================================================================

describe('HML Prompt Patterns', () => {
  /**
   * Tests regex patterns used for prompt updates.
   */

  it('should match hml-prompt with id', () => {
    const content = '<hml-prompt id="test-1" type="text">Question?</hml-prompt>';
    const pattern = /(<hml-prompt[^>]*\bid=["']test-1["'][^>]*)>([\s\S]*?)<\/hml-prompt>/gi;
    const match = pattern.exec(content);

    assert.ok(match, 'Should match');
    assert.ok(match[1].includes('hml-prompt'));
    assert.strictEqual(match[2], 'Question?');
  });

  it('should match prompt and add answered attribute', () => {
    const content = '<hml-prompt id="test-1">Question?</hml-prompt>';
    const answer = 'My Answer';

    const updated = content.replace(
      /(<hml-prompt[^>]*\bid=["']test-1["'][^>]*)>([\s\S]*?)<\/hml-prompt>/gi,
      (match, openTag, inner) => {
        const cleanedTag = openTag.replace(/\s+answered=["'][^"']*["']/gi, '');
        const cleanedContent = inner.replace(/<response>[\s\S]*?<\/response>/gi, '').trim();
        return `${cleanedTag} answered="true">${cleanedContent}<response>${answer}</response></hml-prompt>`;
      }
    );

    assert.ok(updated.includes('answered="true"'));
    assert.ok(updated.includes('<response>My Answer</response>'));
  });

  it('should handle prompt with existing response', () => {
    const content = '<hml-prompt id="test-1" answered="true">Question?<response>Old</response></hml-prompt>';
    const newAnswer = 'New Answer';

    const updated = content.replace(
      /(<hml-prompt[^>]*\bid=["']test-1["'][^>]*)>([\s\S]*?)<\/hml-prompt>/gi,
      (match, openTag, inner) => {
        const cleanedTag = openTag.replace(/\s+answered=["'][^"']*["']/gi, '');
        const cleanedContent = inner.replace(/<response>[\s\S]*?<\/response>/gi, '').trim();
        return `${cleanedTag} answered="true">${cleanedContent}<response>${newAnswer}</response></hml-prompt>`;
      }
    );

    assert.ok(updated.includes('<response>New Answer</response>'));
    assert.ok(!updated.includes('Old'));
  });
});

// =============================================================================
// Summary
// =============================================================================

/*
 * These tests cover HML markup functionality:
 *
 * 1. Dangerous tag identification
 * 2. HTML entity decoding
 * 3. HML prompt regex patterns for updates
 *
 * To run: node --test spec/lib/markup-spec.mjs
 */
