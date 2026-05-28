'use strict';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { MarkdownConverter, createMarkdownConverter } from '../../src/core/lib/markdown-converter.mjs';
import { ContentSanitizer } from '../../src/core/lib/content-sanitizer.mjs';

// =============================================================================
// MarkdownConverter Tests
// =============================================================================

describe('MarkdownConverter', () => {

  // ---------------------------------------------------------------------------
  // Constructor & Factory
  // ---------------------------------------------------------------------------

  describe('constructor', () => {
    it('should create an instance without a sanitizer', () => {
      let converter = new MarkdownConverter();
      assert.ok(converter);
    });

    it('should create an instance with a sanitizer', () => {
      let sanitizer = new ContentSanitizer();
      let converter = new MarkdownConverter(sanitizer);
      assert.ok(converter);
    });
  });

  describe('createMarkdownConverter', () => {
    it('should return a MarkdownConverter instance', () => {
      let converter = createMarkdownConverter();
      assert.ok(converter instanceof MarkdownConverter);
    });

    it('should pass sanitizer to the instance', () => {
      let sanitizer = new ContentSanitizer();
      let converter = createMarkdownConverter(sanitizer);
      assert.ok(converter instanceof MarkdownConverter);
    });
  });

  // ---------------------------------------------------------------------------
  // Basic Conversions
  // ---------------------------------------------------------------------------

  describe('convert', () => {

    function createConverter() {
      let sanitizer = new ContentSanitizer();
      return new MarkdownConverter(sanitizer);
    }

    // -- Input validation --

    it('should return empty string for null', () => {
      let converter = createConverter();
      assert.equal(converter.convert(null), '');
    });

    it('should return empty string for undefined', () => {
      let converter = createConverter();
      assert.equal(converter.convert(undefined), '');
    });

    it('should return empty string for empty string', () => {
      let converter = createConverter();
      assert.equal(converter.convert(''), '');
    });

    it('should return empty string for non-string input', () => {
      let converter = createConverter();
      assert.equal(converter.convert(42), '');
      assert.equal(converter.convert({}), '');
      assert.equal(converter.convert([]), '');
    });

    // -- Inline formatting --

    it('should convert bold text', () => {
      let converter = createConverter();
      let result = converter.convert('**bold**');
      assert.ok(result.includes('<strong>bold</strong>'));
    });

    it('should convert italic text', () => {
      let converter = createConverter();
      let result = converter.convert('*italic*');
      assert.ok(result.includes('<em>italic</em>'));
    });

    it('should convert inline code', () => {
      let converter = createConverter();
      let result = converter.convert('`code`');
      assert.ok(result.includes('<code>code</code>'));
    });

    it('should convert strikethrough', () => {
      let converter = createConverter();
      let result = converter.convert('~~deleted~~');
      assert.ok(result.includes('deleted'));
    });

    // -- Block elements --

    it('should convert paragraphs', () => {
      let converter = createConverter();
      let result = converter.convert('Hello world');
      assert.ok(result.includes('<p>'));
      assert.ok(result.includes('Hello world'));
    });

    it('should convert headings', () => {
      let converter = createConverter();
      assert.ok(converter.convert('# Heading 1').includes('<h1>'));
      assert.ok(converter.convert('## Heading 2').includes('<h2>'));
      assert.ok(converter.convert('### Heading 3').includes('<h3>'));
    });

    it('should convert unordered lists', () => {
      let converter = createConverter();
      let result = converter.convert('- item 1\n- item 2');
      assert.ok(result.includes('<ul>'));
      assert.ok(result.includes('<li>'));
      assert.ok(result.includes('item 1'));
      assert.ok(result.includes('item 2'));
    });

    it('should convert ordered lists', () => {
      let converter = createConverter();
      let result = converter.convert('1. first\n2. second');
      assert.ok(result.includes('<ol>'));
      assert.ok(result.includes('<li>'));
    });

    it('should convert code blocks', () => {
      let converter = createConverter();
      let result = converter.convert('```\nconst x = 1;\n```');
      assert.ok(result.includes('<pre>'));
      assert.ok(result.includes('<code>'));
    });

    it('should convert blockquotes', () => {
      let converter = createConverter();
      let result = converter.convert('> quoted text');
      assert.ok(result.includes('<blockquote>'));
      assert.ok(result.includes('quoted text'));
    });

    it('should convert horizontal rules', () => {
      let converter = createConverter();
      let result = converter.convert('---');
      assert.ok(result.includes('<hr'));
    });

    // -- Links and images --

    it('should convert links', () => {
      let converter = createConverter();
      let result = converter.convert('[link](https://example.com)');
      assert.ok(result.includes('<a'));
      assert.ok(result.includes('href="https://example.com"'));
      assert.ok(result.includes('link'));
    });

    it('should convert images', () => {
      let converter = createConverter();
      let result = converter.convert('![alt](https://example.com/img.png)');
      assert.ok(result.includes('<img'));
      assert.ok(result.includes('src="https://example.com/img.png"'));
    });

    // -- Tables --

    it('should convert tables', () => {
      let converter = createConverter();
      let result = converter.convert('| A | B |\n|---|---|\n| 1 | 2 |');
      assert.ok(result.includes('<table>'));
      assert.ok(result.includes('<th>'));
      assert.ok(result.includes('<td>'));
    });

    // -- Line breaks --

    it('should convert line breaks with breaks: true', () => {
      let converter = createConverter();
      let result = converter.convert('line one\nline two');
      assert.ok(result.includes('<br'));
    });

    // -- Multi-paragraph --

    it('should handle multiple paragraphs', () => {
      let converter = createConverter();
      let result = converter.convert('Paragraph one.\n\nParagraph two.');
      let paragraphs = result.match(/<p>/g);
      assert.ok(paragraphs && paragraphs.length >= 2);
    });
  });

  // ---------------------------------------------------------------------------
  // Sanitization
  // ---------------------------------------------------------------------------

  describe('sanitization', () => {

    function createConverter() {
      let sanitizer = new ContentSanitizer();
      return new MarkdownConverter(sanitizer);
    }

    it('should strip script tags from markdown HTML output', () => {
      let converter = createConverter();
      // Markdown with embedded HTML script tags
      let result = converter.convert('Hello <script>alert("xss")</script> world');
      assert.ok(!result.includes('<script>'));
      assert.ok(!result.includes('alert'));
    });

    it('should strip event handlers from HTML in markdown', () => {
      let converter = createConverter();
      let result = converter.convert('<img src="x" onerror="alert(1)">');
      assert.ok(!result.includes('onerror'));
    });

    it('should strip javascript: URIs from links', () => {
      let converter = createConverter();
      let result = converter.convert('[click](javascript:alert(1))');
      assert.ok(!result.includes('javascript:'));
    });

    it('should strip iframe tags', () => {
      let converter = createConverter();
      let result = converter.convert('Before <iframe src="http://evil.com"></iframe> after');
      assert.ok(!result.includes('<iframe'));
    });

    it('should strip form tags', () => {
      let converter = createConverter();
      let result = converter.convert('Before <form action="/steal"><input></form> after');
      assert.ok(!result.includes('<form'));
      assert.ok(!result.includes('<input'));
    });

    it('should preserve safe formatting through sanitization', () => {
      let converter = createConverter();
      let result = converter.convert('**bold** and *italic* and `code`');
      assert.ok(result.includes('<strong>'));
      assert.ok(result.includes('<em>'));
      assert.ok(result.includes('<code>'));
    });
  });

  // ---------------------------------------------------------------------------
  // Without sanitizer
  // ---------------------------------------------------------------------------

  describe('without sanitizer', () => {
    it('should convert markdown to HTML without sanitizing', () => {
      let converter = new MarkdownConverter(null);
      let result = converter.convert('**bold**');
      assert.ok(result.includes('<strong>bold</strong>'));
    });

    it('should pass through HTML as-is without sanitizer', () => {
      let converter = new MarkdownConverter(null);
      let result = converter.convert('<script>alert(1)</script>');
      // Without sanitizer, script tags pass through
      assert.ok(result.includes('<script>'));
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  describe('edge cases', () => {

    function createConverter() {
      let sanitizer = new ContentSanitizer();
      return new MarkdownConverter(sanitizer);
    }

    it('should handle plain text without markdown syntax', () => {
      let converter = createConverter();
      let result = converter.convert('Just plain text');
      assert.ok(result.includes('Just plain text'));
      assert.ok(result.includes('<p>'));
    });

    it('should handle very long input', () => {
      let converter = createConverter();
      let longText = 'word '.repeat(10000);
      let result = converter.convert(longText);
      assert.ok(result.length > 0);
    });

    it('should handle mixed markdown and HTML', () => {
      let converter = createConverter();
      let result = converter.convert('**bold** and <em>italic HTML</em>');
      assert.ok(result.includes('<strong>'));
      assert.ok(result.includes('<em>'));
    });

    it('should handle nested formatting', () => {
      let converter = createConverter();
      let result = converter.convert('**bold and *italic***');
      assert.ok(result.includes('<strong>'));
      assert.ok(result.includes('<em>'));
    });

    it('should handle code blocks with language hints', () => {
      let converter = createConverter();
      let result = converter.convert('```javascript\nconst x = 1;\n```');
      assert.ok(result.includes('<pre>'));
      assert.ok(result.includes('<code'));
    });

    it('should handle unicode content', () => {
      let converter = createConverter();
      let result = converter.convert('Hello 世界 **bolded 日本語**');
      assert.ok(result.includes('世界'));
      assert.ok(result.includes('<strong>'));
    });

    it('should handle whitespace-only input', () => {
      let converter = createConverter();
      let result = converter.convert('   \n\n   ');
      // Should return something (even if just whitespace/empty paragraphs)
      assert.equal(typeof result, 'string');
    });
  });
});
