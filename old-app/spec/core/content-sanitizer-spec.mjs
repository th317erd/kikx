'use strict';

import { describe, it }  from 'node:test';
import assert             from 'node:assert/strict';

import {
  ContentSanitizer,
  createSanitizer,
  DEFAULT_ALLOWED_TAGS,
  DANGEROUS_TAGS,
} from '../../src/core/lib/content-sanitizer.mjs';

describe('ContentSanitizer', () => {

  // ===========================================================================
  // Basic sanitization
  // ===========================================================================

  describe('basic sanitization', () => {
    it('should return empty string for null input', () => {
      let sanitizer = new ContentSanitizer();
      assert.equal(sanitizer.sanitize(null), '');
    });

    it('should return empty string for undefined input', () => {
      let sanitizer = new ContentSanitizer();
      assert.equal(sanitizer.sanitize(undefined), '');
    });

    it('should return empty string for non-string input', () => {
      let sanitizer = new ContentSanitizer();
      assert.equal(sanitizer.sanitize(42), '');
      assert.equal(sanitizer.sanitize({}), '');
      assert.equal(sanitizer.sanitize([]), '');
      assert.equal(sanitizer.sanitize(true), '');
    });

    it('should return empty string for empty string input', () => {
      let sanitizer = new ContentSanitizer();
      assert.equal(sanitizer.sanitize(''), '');
    });

    it('should pass through plain text unchanged', () => {
      let sanitizer = new ContentSanitizer();
      assert.equal(sanitizer.sanitize('Hello, world!'), 'Hello, world!');
    });

    it('should allow safe HTML formatting tags', () => {
      let sanitizer = new ContentSanitizer();
      let input     = '<b>bold</b> <i>italic</i> <em>emphasis</em> <strong>strong</strong>';
      let result    = sanitizer.sanitize(input);

      assert.ok(result.includes('<b>bold</b>'));
      assert.ok(result.includes('<i>italic</i>'));
      assert.ok(result.includes('<em>emphasis</em>'));
      assert.ok(result.includes('<strong>strong</strong>'));
    });

    it('should allow code and pre tags with class attribute', () => {
      let sanitizer = new ContentSanitizer();
      let input     = '<pre class="language-js"><code class="highlight">let x = 1;</code></pre>';
      let result    = sanitizer.sanitize(input);

      assert.ok(result.includes('<pre class="language-js">'));
      assert.ok(result.includes('<code class="highlight">'));
    });

    it('should allow headings h1-h6 with id and class attributes', () => {
      let sanitizer = new ContentSanitizer();
      let input     = '<h1 id="title" class="main">Title</h1><h2 class="sub">Sub</h2><h3>H3</h3><h4>H4</h4><h5>H5</h5><h6>H6</h6>';
      let result    = sanitizer.sanitize(input);

      assert.ok(result.includes('<h1 id="title" class="main">'));
      assert.ok(result.includes('<h2 class="sub">'));
      assert.ok(result.includes('<h3>'));
      assert.ok(result.includes('<h6>'));
    });

    it('should allow block elements (p, div, span, blockquote, br, hr)', () => {
      let sanitizer = new ContentSanitizer();
      let input     = '<p class="intro">Text</p><div id="main" class="container">Content</div><span class="highlight">word</span><blockquote class="quote">Quote</blockquote><br><hr>';
      let result    = sanitizer.sanitize(input);

      assert.ok(result.includes('<p class="intro">'));
      assert.ok(result.includes('<div id="main" class="container">'));
      assert.ok(result.includes('<span class="highlight">'));
      assert.ok(result.includes('<blockquote class="quote">'));
      assert.ok(result.includes('<br'));
      assert.ok(result.includes('<hr'));
    });
  });

  // ===========================================================================
  // Dangerous tag removal
  // ===========================================================================

  describe('dangerous tag removal', () => {
    it('should strip script tags AND their content', () => {
      let sanitizer = new ContentSanitizer();
      let input     = 'Hello <script>alert("xss")</script> World';
      let result    = sanitizer.sanitize(input);

      assert.equal(result, 'Hello  World');
      assert.ok(!result.includes('script'));
      assert.ok(!result.includes('alert'));
    });

    it('should strip iframe tags AND their content', () => {
      let sanitizer = new ContentSanitizer();
      let input     = 'Before <iframe src="evil.com">inside</iframe> After';
      let result    = sanitizer.sanitize(input);

      assert.equal(result, 'Before  After');
    });

    it('should strip style tags AND their content', () => {
      let sanitizer = new ContentSanitizer();
      let input     = 'Before <style>body { display: none; }</style> After';
      let result    = sanitizer.sanitize(input);

      assert.equal(result, 'Before  After');
    });

    it('should strip object, embed, and applet tags AND their content', () => {
      let sanitizer = new ContentSanitizer();

      assert.equal(sanitizer.sanitize('X<object data="evil.swf">inside</object>Y'), 'XY');
      assert.equal(sanitizer.sanitize('X<embed src="evil.swf">Y'), 'XY');
      assert.equal(sanitizer.sanitize('X<applet code="Evil.class">inside</applet>Y'), 'XY');
    });

    it('should strip form-related tags AND their content', () => {
      let sanitizer = new ContentSanitizer();

      assert.equal(sanitizer.sanitize('X<form action="/steal">inside</form>Y'), 'XY');
      assert.equal(sanitizer.sanitize('X<input type="hidden" value="evil">Y'), 'XY');
      assert.equal(sanitizer.sanitize('X<textarea>evil</textarea>Y'), 'XY');
      assert.equal(sanitizer.sanitize('X<select><option>evil</option></select>Y'), 'XY');
      assert.equal(sanitizer.sanitize('X<button onclick="evil()">click</button>Y'), 'XY');
    });

    it('should handle nested script tags', () => {
      let sanitizer = new ContentSanitizer();
      let input     = 'Before <script>var x = "<script>nested</script>";</script> After';
      let result    = sanitizer.sanitize(input);

      // The non-greedy match will consume up to the first </script>
      // and the leftover `";</script>` will be removed on the second pass
      assert.ok(!result.includes('script'));
      assert.ok(!result.includes('var x'));
    });
  });

  // ===========================================================================
  // Attribute sanitization
  // ===========================================================================

  describe('attribute sanitization', () => {
    it('should allow whitelisted attributes', () => {
      let sanitizer = new ContentSanitizer();
      let input     = '<a href="https://example.com" title="Example" class="link">click</a>';
      let result    = sanitizer.sanitize(input);

      assert.ok(result.includes('href="https://example.com"'));
      assert.ok(result.includes('title="Example"'));
      assert.ok(result.includes('class="link"'));
    });

    it('should strip non-whitelisted attributes', () => {
      let sanitizer = new ContentSanitizer();
      let input     = '<div class="ok" data-custom="bad" style="color:red">text</div>';
      let result    = sanitizer.sanitize(input);

      assert.ok(result.includes('class="ok"'));
      assert.ok(!result.includes('data-custom'));
      assert.ok(!result.includes('style'));
    });

    it('should strip event handler attributes (onclick, onload, onerror, onmouseover)', () => {
      let sanitizer = new ContentSanitizer();
      let input     = '<div class="ok" onclick="evil()" onload="evil()" onerror="evil()" onmouseover="evil()">text</div>';
      let result    = sanitizer.sanitize(input);

      assert.ok(result.includes('class="ok"'));
      assert.ok(!result.includes('onclick'));
      assert.ok(!result.includes('onload'));
      assert.ok(!result.includes('onerror'));
      assert.ok(!result.includes('onmouseover'));
    });

    it('should strip javascript: URIs in href', () => {
      let sanitizer = new ContentSanitizer();
      let input     = '<a href="javascript:alert(1)">click</a>';
      let result    = sanitizer.sanitize(input);

      assert.ok(!result.includes('javascript'));
      assert.ok(result.includes('<a>'));
    });

    it('should strip javascript: URIs in src', () => {
      let sanitizer = new ContentSanitizer();
      let input     = '<img src="javascript:alert(1)" alt="test">';
      let result    = sanitizer.sanitize(input);

      assert.ok(!result.includes('javascript'));
      assert.ok(result.includes('alt="test"'));
    });

    it('should strip javascript: URIs with whitespace and mixed case', () => {
      let sanitizer = new ContentSanitizer();

      assert.ok(!sanitizer.sanitize('<a href="  javascript:alert(1)">x</a>').includes('javascript'));
      assert.ok(!sanitizer.sanitize('<a href="JavaScript:alert(1)">x</a>').includes('JavaScript'));
      assert.ok(!sanitizer.sanitize('<a href="JAVASCRIPT:alert(1)">x</a>').includes('JAVASCRIPT'));
    });

    it('should escape attribute values (quotes and ampersands)', () => {
      let sanitizer = new ContentSanitizer();

      // Test ampersand escaping
      let result1 = sanitizer.sanitize('<div class="a&b">text</div>');
      assert.ok(result1.includes('class="a&amp;b"'));

      // Test quote escaping in href
      let result2 = sanitizer.sanitize('<a href="https://example.com?x=1&y=2">link</a>');
      assert.ok(result2.includes('href="https://example.com?x=1&amp;y=2"'));

      // Test single quote escaping
      let result3 = sanitizer.sanitize("<div class=\"it's\">text</div>");
      assert.ok(result3.includes('&#x27;'));
    });
  });

  // ===========================================================================
  // Link sanitization
  // ===========================================================================

  describe('link sanitization', () => {
    it('should allow normal href values', () => {
      let sanitizer = new ContentSanitizer();
      let input     = '<a href="https://example.com/path?q=1#hash">link</a>';
      let result    = sanitizer.sanitize(input);

      assert.ok(result.includes('href="https://example.com/path?q=1#hash"'));
    });

    it('should strip javascript: href but keep the tag', () => {
      let sanitizer = new ContentSanitizer();
      let input     = '<a href="javascript:void(0)" class="btn">click</a>';
      let result    = sanitizer.sanitize(input);

      assert.ok(!result.includes('javascript'));
      assert.ok(result.includes('class="btn"'));
      assert.ok(result.includes('<a'));
    });

    it('should allow target and rel attributes on links', () => {
      let sanitizer = new ContentSanitizer();
      let input     = '<a href="https://example.com" target="_blank" rel="noopener noreferrer">link</a>';
      let result    = sanitizer.sanitize(input);

      assert.ok(result.includes('target="_blank"'));
      assert.ok(result.includes('rel="noopener noreferrer"'));
    });
  });

  // ===========================================================================
  // Image sanitization
  // ===========================================================================

  describe('image sanitization', () => {
    it('should allow src, alt, title, width, height on img', () => {
      let sanitizer = new ContentSanitizer();
      let input     = '<img src="photo.jpg" alt="A photo" title="My photo" width="100" height="50">';
      let result    = sanitizer.sanitize(input);

      assert.ok(result.includes('src="photo.jpg"'));
      assert.ok(result.includes('alt="A photo"'));
      assert.ok(result.includes('title="My photo"'));
      assert.ok(result.includes('width="100"'));
      assert.ok(result.includes('height="50"'));
    });

    it('should strip javascript: in img src', () => {
      let sanitizer = new ContentSanitizer();
      let input     = '<img src="javascript:alert(1)" alt="xss">';
      let result    = sanitizer.sanitize(input);

      assert.ok(!result.includes('javascript'));
      assert.ok(result.includes('alt="xss"'));
    });
  });

  // ===========================================================================
  // Custom elements
  // ===========================================================================

  describe('custom elements', () => {
    it('should allow kikx-hml-prompt with its attributes', () => {
      let sanitizer = new ContentSanitizer();
      let input     = '<kikx-hml-prompt type="text" name="query" label="Search" placeholder="Type here" required="true"></kikx-hml-prompt>';
      let result    = sanitizer.sanitize(input);

      assert.ok(result.includes('<kikx-hml-prompt'));
      assert.ok(result.includes('type="text"'));
      assert.ok(result.includes('name="query"'));
      assert.ok(result.includes('label="Search"'));
      assert.ok(result.includes('placeholder="Type here"'));
      assert.ok(result.includes('required="true"'));
    });

    it('should preserve readonly and value on answered kikx-hml-prompt', () => {
      let sanitizer = new ContentSanitizer();
      let input     = '<kikx-hml-prompt type="text" name="city" label="City" value="Portland" readonly=""></kikx-hml-prompt>';
      let result    = sanitizer.sanitize(input);

      assert.ok(result.includes('value="Portland"'), 'should preserve value');
      assert.ok(result.includes('readonly=""'), 'should preserve readonly');
    });

    it('should allow kikx-hml-option with its attributes', () => {
      let sanitizer = new ContentSanitizer();
      let input     = '<kikx-hml-option value="opt1" label="Option 1" selected="true"></kikx-hml-option>';
      let result    = sanitizer.sanitize(input);

      assert.ok(result.includes('<kikx-hml-option'));
      assert.ok(result.includes('value="opt1"'));
      assert.ok(result.includes('label="Option 1"'));
      assert.ok(result.includes('selected="true"'));
    });

    it('should support registerCustomElement to add new allowed tags', () => {
      let sanitizer = new ContentSanitizer();
      sanitizer.registerCustomElement('my-widget', ['data-id', 'class']);

      let input  = '<my-widget data-id="123" class="fancy">content</my-widget>';
      let result = sanitizer.sanitize(input);

      assert.ok(result.includes('<my-widget'));
      assert.ok(result.includes('data-id="123"'));
      assert.ok(result.includes('class="fancy"'));
    });

    it('should support unregisterCustomElement for plugin-added tags', () => {
      let sanitizer = new ContentSanitizer();
      sanitizer.registerCustomElement('my-widget', ['class']);

      // Verify it's allowed
      assert.ok(sanitizer.sanitize('<my-widget class="x">hi</my-widget>').includes('<my-widget'));

      // Unregister
      let removed = sanitizer.unregisterCustomElement('my-widget');
      assert.equal(removed, true);

      // Now it should be stripped
      let result = sanitizer.sanitize('<my-widget class="x">hi</my-widget>');
      assert.ok(!result.includes('<my-widget'));
      assert.ok(result.includes('hi'));
    });

    it('should not allow unregistering default/standard tags', () => {
      let sanitizer = new ContentSanitizer();
      let removed   = sanitizer.unregisterCustomElement('div');

      assert.equal(removed, false);

      // div should still be allowed
      assert.ok(sanitizer.sanitize('<div>text</div>').includes('<div>'));
    });
  });

  // ===========================================================================
  // Tag stripping
  // ===========================================================================

  describe('tag stripping', () => {
    it('should remove unallowed tags but preserve their text content', () => {
      let sanitizer = new ContentSanitizer();
      let input     = '<custom-tag>Keep this text</custom-tag>';
      let result    = sanitizer.sanitize(input);

      assert.equal(result, 'Keep this text');
    });

    it('should handle nested disallowed tags', () => {
      let sanitizer = new ContentSanitizer();
      let input     = '<unknown><another>inner text</another></unknown>';
      let result    = sanitizer.sanitize(input);

      assert.equal(result, 'inner text');
    });

    it('should handle self-closing tags', () => {
      let sanitizer = new ContentSanitizer();
      let input     = '<br /><hr /><img src="test.jpg" />';
      let result    = sanitizer.sanitize(input);

      assert.ok(result.includes('<br'));
      assert.ok(result.includes('<hr'));
      assert.ok(result.includes('<img'));
    });
  });

  // ===========================================================================
  // Edge cases
  // ===========================================================================

  describe('edge cases', () => {
    it('should handle malformed HTML gracefully (does not crash)', () => {
      let sanitizer = new ContentSanitizer();

      // Should not throw
      assert.doesNotThrow(() => sanitizer.sanitize('<div><p>unclosed'));
      assert.doesNotThrow(() => sanitizer.sanitize('<<<>>>'));
      assert.doesNotThrow(() => sanitizer.sanitize('<div class=>text</div>'));
      assert.doesNotThrow(() => sanitizer.sanitize('<div class=""">text</div>'));
      assert.doesNotThrow(() => sanitizer.sanitize('< div >'));
    });

    it('should handle tags with no attributes', () => {
      let sanitizer = new ContentSanitizer();
      let input     = '<p>text</p>';
      let result    = sanitizer.sanitize(input);

      assert.equal(result, '<p>text</p>');
    });

    it('should handle mixed case tag names', () => {
      let sanitizer = new ContentSanitizer();
      let input     = '<DIV class="x">text</DIV>';
      let result    = sanitizer.sanitize(input);

      assert.ok(result.includes('<div'));
      assert.ok(result.includes('</div>'));
      assert.ok(result.includes('class="x"'));
    });

    it('should handle mixed case dangerous tag names', () => {
      let sanitizer = new ContentSanitizer();
      let input     = '<SCRIPT>alert(1)</SCRIPT>';
      let result    = sanitizer.sanitize(input);

      assert.ok(!result.includes('SCRIPT'));
      assert.ok(!result.includes('script'));
      assert.ok(!result.includes('alert'));
    });

    it('should handle multiple dangerous tags in sequence', () => {
      let sanitizer = new ContentSanitizer();
      let input     = '<script>a</script><iframe>b</iframe><style>c</style>Safe';
      let result    = sanitizer.sanitize(input);

      assert.equal(result, 'Safe');
    });

    it('should preserve allowed tags inside stripped non-dangerous tags', () => {
      let sanitizer = new ContentSanitizer();
      let input     = '<section><p>paragraph</p></section>';
      let result    = sanitizer.sanitize(input);

      // section is stripped but p is kept
      assert.ok(!result.includes('section'));
      assert.ok(result.includes('<p>paragraph</p>'));
    });
  });

  // ===========================================================================
  // Table elements
  // ===========================================================================

  describe('table elements', () => {
    it('should allow table structure with colspan and rowspan', () => {
      let sanitizer = new ContentSanitizer();
      let input     = '<table class="data"><thead><tr><th colspan="2" class="header">Title</th></tr></thead><tbody><tr><td rowspan="2" class="cell">Content</td><td>More</td></tr></tbody></table>';
      let result    = sanitizer.sanitize(input);

      assert.ok(result.includes('<table class="data">'));
      assert.ok(result.includes('<thead>'));
      assert.ok(result.includes('<tbody>'));
      assert.ok(result.includes('<tr>'));
      assert.ok(result.includes('colspan="2"'));
      assert.ok(result.includes('rowspan="2"'));
    });
  });

  // ===========================================================================
  // List elements
  // ===========================================================================

  describe('list elements', () => {
    it('should allow ul, ol, and li with their attributes', () => {
      let sanitizer = new ContentSanitizer();
      let input     = '<ul class="items"><li class="item">One</li></ul><ol class="numbered" start="5" type="a"><li>Two</li></ol>';
      let result    = sanitizer.sanitize(input);

      assert.ok(result.includes('<ul class="items">'));
      assert.ok(result.includes('<li class="item">'));
      assert.ok(result.includes('<ol class="numbered" start="5" type="a">'));
    });
  });

  // ===========================================================================
  // createSanitizer convenience function
  // ===========================================================================

  describe('createSanitizer', () => {
    it('should create a ContentSanitizer instance', () => {
      let sanitizer = createSanitizer();
      assert.ok(sanitizer instanceof ContentSanitizer);
    });

    it('should pass options to the constructor', () => {
      let sanitizer = createSanitizer({
        allowedTags: { 'custom-el': ['data-foo'] },
      });
      let result = sanitizer.sanitize('<custom-el data-foo="bar">text</custom-el>');

      assert.ok(result.includes('<custom-el'));
      assert.ok(result.includes('data-foo="bar"'));
    });
  });

  // ===========================================================================
  // Export verification
  // ===========================================================================

  describe('exports', () => {
    it('should export DEFAULT_ALLOWED_TAGS with expected tags', () => {
      assert.ok(DEFAULT_ALLOWED_TAGS['b'] !== undefined);
      assert.ok(DEFAULT_ALLOWED_TAGS['div'] !== undefined);
      assert.ok(DEFAULT_ALLOWED_TAGS['a'] !== undefined);
      assert.ok(DEFAULT_ALLOWED_TAGS['kikx-hml-prompt'] !== undefined);
    });

    it('should export DANGEROUS_TAGS as a Set with expected entries', () => {
      assert.ok(DANGEROUS_TAGS instanceof Set);
      assert.ok(DANGEROUS_TAGS.has('script'));
      assert.ok(DANGEROUS_TAGS.has('iframe'));
      assert.ok(DANGEROUS_TAGS.has('style'));
      assert.ok(DANGEROUS_TAGS.has('form'));
    });
  });

  // ===========================================================================
  // Double-encoding prevention
  // ===========================================================================

  describe('double-encoding prevention', () => {
    it('should not double-encode &quot; entities in attribute values', () => {
      let sanitizer = new ContentSanitizer();
      let html      = '<kikx-hml-prompt type="textarea" label="Thoughts" value="Why does the &quot;Productivity Today&quot; not have a &quot;1000%&quot; option?"></kikx-hml-prompt>';
      let result    = sanitizer.sanitize(html);

      // Should contain &quot; (single-encoded), NOT &amp;quot; (double-encoded)
      assert.ok(result.includes('&quot;Productivity Today&quot;'), `Expected &quot; but got: ${result}`);
      assert.ok(!result.includes('&amp;quot;'), `Found double-encoded &amp;quot; in: ${result}`);
    });

    it('should not double-encode &amp; entities in attribute values', () => {
      let sanitizer = new ContentSanitizer();
      let html      = '<a href="https://example.com?x=1&amp;y=2">link</a>';
      let result    = sanitizer.sanitize(html);

      assert.ok(result.includes('x=1&amp;y=2'));
      assert.ok(!result.includes('&amp;amp;'));
    });

    it('should not double-encode &lt; and &gt; entities in attribute values', () => {
      let sanitizer = new ContentSanitizer();
      let html      = '<kikx-hml-prompt type="text" label="Code" value="x &lt; 10 &amp;&amp; y &gt; 5"></kikx-hml-prompt>';
      let result    = sanitizer.sanitize(html);

      assert.ok(result.includes('&lt;'));
      assert.ok(result.includes('&gt;'));
      assert.ok(!result.includes('&amp;lt;'));
      assert.ok(!result.includes('&amp;gt;'));
    });

    it('should still encode raw special characters in attribute values', () => {
      let sanitizer = new ContentSanitizer();
      // Raw & (not an entity) should still be encoded
      let html   = '<div class="a&b">text</div>';
      let result = sanitizer.sanitize(html);

      assert.ok(result.includes('class="a&amp;b"'));
    });
  });
});
