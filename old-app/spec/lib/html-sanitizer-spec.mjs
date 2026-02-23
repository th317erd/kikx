'use strict';

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';

// Will import the sanitizer once implemented
// import { sanitizeHtml } from '../../server/lib/html-sanitizer.mjs';

// Placeholder until implementation
let sanitizeHtml;

describe('HTML Sanitizer', () => {
  beforeEach(async () => {
    // Dynamic import to pick up implementation changes
    try {
      const module = await import('../../server/lib/html-sanitizer.mjs');
      sanitizeHtml = module.sanitizeHtml;
    } catch (e) {
      // Not implemented yet - tests will fail as expected
      sanitizeHtml = () => { throw new Error('Not implemented'); };
    }
  });

  // ===========================================================================
  // Allowed Tags - Should Pass Through
  // ===========================================================================

  describe('Allowed Tags', () => {
    it('should pass through paragraph tags', () => {
      let input = '<p>Hello world</p>';
      assert.strictEqual(sanitizeHtml(input), '<p>Hello world</p>');
    });

    it('should pass through div and span tags', () => {
      let input = '<div><span>Content</span></div>';
      assert.strictEqual(sanitizeHtml(input), '<div><span>Content</span></div>');
    });

    it('should pass through all heading levels', () => {
      let input = '<h1>One</h1><h2>Two</h2><h3>Three</h3><h4>Four</h4><h5>Five</h5><h6>Six</h6>';
      assert.strictEqual(sanitizeHtml(input), input);
    });

    it('should pass through inline formatting tags', () => {
      let input = '<b>bold</b> <strong>strong</strong> <i>italic</i> <em>emphasis</em>';
      assert.strictEqual(sanitizeHtml(input), input);
    });

    it('should pass through additional inline tags', () => {
      let input = '<u>underline</u> <s>strike</s> <mark>highlight</mark> <code>code</code>';
      assert.strictEqual(sanitizeHtml(input), input);
    });

    it('should pass through sub and sup tags', () => {
      let input = 'H<sub>2</sub>O and x<sup>2</sup>';
      assert.strictEqual(sanitizeHtml(input), input);
    });

    it('should pass through block elements', () => {
      let input = '<pre>code block</pre><blockquote>quote</blockquote>';
      assert.strictEqual(sanitizeHtml(input), input);
    });

    it('should pass through unordered lists', () => {
      let input = '<ul><li>Item 1</li><li>Item 2</li></ul>';
      assert.strictEqual(sanitizeHtml(input), input);
    });

    it('should pass through ordered lists', () => {
      let input = '<ol><li>First</li><li>Second</li></ol>';
      assert.strictEqual(sanitizeHtml(input), input);
    });

    it('should pass through links with href', () => {
      let input = '<a href="https://example.com">Link</a>';
      assert.strictEqual(sanitizeHtml(input), input);
    });

    it('should pass through links with target and rel', () => {
      let input = '<a href="https://example.com" target="_blank" rel="noopener">Link</a>';
      assert.strictEqual(sanitizeHtml(input), input);
    });

    it('should pass through images with src and alt', () => {
      let input = '<img src="image.png" alt="Description">';
      assert.strictEqual(sanitizeHtml(input), '<img src="image.png" alt="Description">');
    });

    it('should pass through images with dimensions', () => {
      let input = '<img src="img.png" alt="Test" width="100" height="50">';
      assert.strictEqual(sanitizeHtml(input), input);
    });

    it('should pass through basic tables', () => {
      let input = '<table><thead><tr><th>Header</th></tr></thead><tbody><tr><td>Cell</td></tr></tbody></table>';
      assert.strictEqual(sanitizeHtml(input), input);
    });

    it('should pass through table cells with colspan and rowspan', () => {
      let input = '<table><tr><td colspan="2" rowspan="3">Merged</td></tr></table>';
      // Note: JSDOM (like browsers) auto-inserts <tbody> for implicit table structure
      let expected = '<table><tbody><tr><td colspan="2" rowspan="3">Merged</td></tr></tbody></table>';
      assert.strictEqual(sanitizeHtml(input), expected);
    });

    it('should pass through br and hr tags', () => {
      let input = 'Line 1<br>Line 2<hr>Section';
      assert.strictEqual(sanitizeHtml(input), input);
    });

    it('should pass through hml-prompt custom element', () => {
      let input = '<hml-prompt id="test-1" type="text">Question?</hml-prompt>';
      assert.strictEqual(sanitizeHtml(input), input);
    });

    it('should pass through hml-prompt with all attributes', () => {
      let input = '<hml-prompt id="num-1" type="number" min="0" max="100" step="5" default="50">Pick a number</hml-prompt>';
      assert.strictEqual(sanitizeHtml(input), input);
    });

    it('should pass through hml-prompt with answered attribute', () => {
      let input = '<hml-prompt id="q1" answered="true">Question<response>Answer</response></hml-prompt>';
      assert.strictEqual(sanitizeHtml(input), input);
    });

    it('should pass through hml-prompt with data child', () => {
      let input = '<hml-prompt id="choice" type="radio">Pick one<data>[{"value":"a","label":"A"}]</data></hml-prompt>';
      assert.strictEqual(sanitizeHtml(input), input);
    });

    it('should pass through hml-thinking element', () => {
      let input = '<hml-thinking title="Reasoning">I am thinking about this...</hml-thinking>';
      assert.strictEqual(sanitizeHtml(input), input);
    });

    it('should pass through response element', () => {
      let input = '<response>User answer here</response>';
      assert.strictEqual(sanitizeHtml(input), input);
    });

    it('should pass through data element', () => {
      let input = '<data>{"key": "value"}</data>';
      assert.strictEqual(sanitizeHtml(input), input);
    });

    it('should preserve class and id attributes on any allowed tag', () => {
      let input = '<div id="main" class="container"><p class="intro">Text</p></div>';
      assert.strictEqual(sanitizeHtml(input), input);
    });

    it('should preserve title attribute', () => {
      let input = '<span title="Tooltip text">Hover me</span>';
      assert.strictEqual(sanitizeHtml(input), input);
    });
  });

  // ===========================================================================
  // Unknown Tags - Strip Tag, Keep Content
  // ===========================================================================

  describe('Unknown Tags', () => {
    it('should strip unknown tags but keep content', () => {
      let input = '<custom>Keep this text</custom>';
      assert.strictEqual(sanitizeHtml(input), 'Keep this text');
    });

    it('should strip nested unknown tags', () => {
      let input = '<outer><inner>Content</inner></outer>';
      assert.strictEqual(sanitizeHtml(input), 'Content');
    });

    it('should strip unknown tags inside allowed tags', () => {
      let input = '<p>Start <unknown>middle</unknown> end</p>';
      assert.strictEqual(sanitizeHtml(input), '<p>Start middle end</p>');
    });

    it('should handle multiple unknown tags', () => {
      let input = '<foo>One</foo> <bar>Two</bar> <baz>Three</baz>';
      assert.strictEqual(sanitizeHtml(input), 'One Two Three');
    });

    it('should strip unknown self-closing tags', () => {
      let input = '<p>Before <unknown/> After</p>';
      assert.strictEqual(sanitizeHtml(input), '<p>Before  After</p>');
    });
  });

  // ===========================================================================
  // Dangerous Tags - Remove Completely (Tag AND Content)
  // ===========================================================================

  describe('Dangerous Tags', () => {
    it('should remove script tags completely', () => {
      let input = '<p>Safe</p><script>alert("xss")</script><p>Also safe</p>';
      assert.strictEqual(sanitizeHtml(input), '<p>Safe</p><p>Also safe</p>');
    });

    it('should remove script tags with attributes', () => {
      let input = '<script src="evil.js" type="text/javascript"></script>';
      assert.strictEqual(sanitizeHtml(input), '');
    });

    it('should remove iframe tags completely', () => {
      let input = '<iframe src="https://evil.com"></iframe>';
      assert.strictEqual(sanitizeHtml(input), '');
    });

    it('should remove style tags completely', () => {
      let input = '<style>body { display: none; }</style><p>Content</p>';
      assert.strictEqual(sanitizeHtml(input), '<p>Content</p>');
    });

    it('should remove embed tags completely', () => {
      let input = '<embed src="malware.swf">';
      assert.strictEqual(sanitizeHtml(input), '');
    });

    it('should remove object tags completely', () => {
      let input = '<object data="malware.swf"><param name="x" value="y"></object>';
      assert.strictEqual(sanitizeHtml(input), '');
    });

    it('should remove form tags completely', () => {
      let input = '<form action="https://evil.com"><input type="text"></form>';
      assert.strictEqual(sanitizeHtml(input), '');
    });

    it('should remove input tags', () => {
      let input = '<p>Enter data: <input type="text" value="trap"></p>';
      assert.strictEqual(sanitizeHtml(input), '<p>Enter data: </p>');
    });

    it('should remove button tags', () => {
      let input = '<button onclick="evil()">Click me</button>';
      assert.strictEqual(sanitizeHtml(input), '');
    });

    it('should remove textarea tags', () => {
      let input = '<textarea>Phishing content</textarea>';
      assert.strictEqual(sanitizeHtml(input), '');
    });

    it('should remove select tags', () => {
      let input = '<select><option>Trap</option></select>';
      assert.strictEqual(sanitizeHtml(input), '');
    });

    it('should remove base tags', () => {
      let input = '<base href="https://evil.com/"><a href="/page">Link</a>';
      assert.strictEqual(sanitizeHtml(input), '<a href="/page">Link</a>');
    });

    it('should remove meta tags', () => {
      let input = '<meta http-equiv="refresh" content="0;url=evil.com"><p>Content</p>';
      assert.strictEqual(sanitizeHtml(input), '<p>Content</p>');
    });

    it('should remove noscript tags', () => {
      let input = '<noscript><img src="tracker.gif"></noscript>';
      assert.strictEqual(sanitizeHtml(input), '');
    });

    it('should remove template tags', () => {
      let input = '<template><script>evil()</script></template>';
      assert.strictEqual(sanitizeHtml(input), '');
    });

    it('should remove math tags', () => {
      let input = '<math><maction actiontype="statusline">XSS</maction></math>';
      assert.strictEqual(sanitizeHtml(input), '');
    });

    it('should remove interaction tags (protocol)', () => {
      let input = '<p>Response</p><interaction>{"target":"@system"}</interaction>';
      assert.strictEqual(sanitizeHtml(input), '<p>Response</p>');
    });

    it('should remove nested dangerous tags', () => {
      let input = '<div><script><script>double nested</script></script></div>';
      assert.strictEqual(sanitizeHtml(input), '<div></div>');
    });

    it('should be case-insensitive for dangerous tags', () => {
      let input = '<SCRIPT>evil()</SCRIPT><Script>also evil()</Script>';
      assert.strictEqual(sanitizeHtml(input), '');
    });
  });

  // ===========================================================================
  // Dangerous Attributes - Strip from Tags
  // ===========================================================================

  describe('Dangerous Attributes', () => {
    it('should strip onclick handlers', () => {
      let input = '<p onclick="evil()">Click me</p>';
      assert.strictEqual(sanitizeHtml(input), '<p>Click me</p>');
    });

    it('should strip all event handlers', () => {
      let input = '<div onmouseover="x()" onmouseout="y()" onfocus="z()">Content</div>';
      assert.strictEqual(sanitizeHtml(input), '<div>Content</div>');
    });

    it('should strip onerror from images', () => {
      let input = '<img src="x" onerror="alert(1)" alt="test">';
      assert.strictEqual(sanitizeHtml(input), '<img src="x" alt="test">');
    });

    it('should strip onload from images', () => {
      let input = '<img src="x.png" onload="evil()" alt="test">';
      assert.strictEqual(sanitizeHtml(input), '<img src="x.png" alt="test">');
    });

    it('should strip formaction attribute', () => {
      let input = '<button formaction="https://evil.com">Submit</button>';
      // button is dangerous, so removed entirely
      assert.strictEqual(sanitizeHtml(input), '');
    });

    it('should strip style attribute (inline CSS)', () => {
      let input = '<p style="background:url(javascript:evil())">Text</p>';
      assert.strictEqual(sanitizeHtml(input), '<p>Text</p>');
    });

    it('should be case-insensitive for attribute names', () => {
      let input = '<p ONCLICK="x()" OnMouseOver="y()">Text</p>';
      assert.strictEqual(sanitizeHtml(input), '<p>Text</p>');
    });

    it('should handle attributes with various quote styles', () => {
      let input = "<p onclick='evil()' onmouseover=\"bad()\">Text</p>";
      assert.strictEqual(sanitizeHtml(input), '<p>Text</p>');
    });
  });

  // ===========================================================================
  // Dangerous URLs - Neutralize
  // ===========================================================================

  describe('Dangerous URLs', () => {
    it('should neutralize javascript: URLs in href', () => {
      let input = '<a href="javascript:alert(1)">Click</a>';
      let result = sanitizeHtml(input);
      assert.ok(!result.includes('javascript:'), 'Should not contain javascript:');
      assert.ok(result.includes('>Click</a>'), 'Should preserve link text');
    });

    it('should neutralize javascript: URLs with whitespace', () => {
      let input = '<a href="  javascript:alert(1)">Click</a>';
      let result = sanitizeHtml(input);
      assert.ok(!result.includes('javascript:'));
    });

    it('should neutralize javascript: URLs case-insensitively', () => {
      let input = '<a href="JAVASCRIPT:alert(1)">Click</a>';
      let result = sanitizeHtml(input);
      assert.ok(!result.toLowerCase().includes('javascript:'));
    });

    it('should neutralize data:text/html URLs', () => {
      let input = '<a href="data:text/html,<script>alert(1)</script>">Click</a>';
      let result = sanitizeHtml(input);
      assert.ok(!result.includes('data:text/html'));
    });

    it('should allow safe data: URLs (images)', () => {
      let input = '<img src="data:image/png;base64,abc123" alt="test">';
      let result = sanitizeHtml(input);
      assert.ok(result.includes('data:image/png'));
    });

    it('should neutralize javascript: in img src', () => {
      let input = '<img src="javascript:alert(1)" alt="test">';
      let result = sanitizeHtml(input);
      assert.ok(!result.includes('javascript:'));
    });

    it('should allow normal https URLs', () => {
      let input = '<a href="https://example.com/page?q=1">Link</a>';
      assert.strictEqual(sanitizeHtml(input), input);
    });

    it('should allow relative URLs', () => {
      let input = '<a href="/page/path">Link</a>';
      assert.strictEqual(sanitizeHtml(input), input);
    });

    it('should allow anchor URLs', () => {
      let input = '<a href="#section">Jump</a>';
      assert.strictEqual(sanitizeHtml(input), input);
    });
  });

  // ===========================================================================
  // Edge Cases
  // ===========================================================================

  describe('Edge Cases', () => {
    it('should handle empty string', () => {
      assert.strictEqual(sanitizeHtml(''), '');
    });

    it('should handle null input', () => {
      assert.strictEqual(sanitizeHtml(null), '');
    });

    it('should handle undefined input', () => {
      assert.strictEqual(sanitizeHtml(undefined), '');
    });

    it('should handle plain text without tags', () => {
      let input = 'Just plain text with no HTML';
      assert.strictEqual(sanitizeHtml(input), input);
    });

    it('should handle text with angle brackets that are not tags', () => {
      let input = '5 < 10 and 10 > 5';
      // This depends on how the parser handles it - may need escaping
      let result = sanitizeHtml(input);
      assert.ok(result.includes('5') && result.includes('10'));
    });

    it('should handle unclosed tags gracefully', () => {
      let input = '<p>Unclosed paragraph<div>And div';
      let result = sanitizeHtml(input);
      // Should not throw, content should be preserved
      assert.ok(result.includes('Unclosed paragraph'));
      assert.ok(result.includes('And div'));
    });

    it('should handle mismatched tags', () => {
      let input = '<p>Start</div></p>';
      let result = sanitizeHtml(input);
      assert.ok(result.includes('Start'));
    });

    it('should handle deeply nested content', () => {
      let input = '<div><div><div><p><span><b>Deep</b></span></p></div></div></div>';
      assert.strictEqual(sanitizeHtml(input), input);
    });

    it('should handle mixed content correctly', () => {
      let input = 'Text <b>bold</b> more text <script>evil()</script> final text';
      assert.strictEqual(sanitizeHtml(input), 'Text <b>bold</b> more text  final text');
    });

    it('should preserve whitespace in content', () => {
      let input = '<pre>  indented\n    more indent</pre>';
      assert.strictEqual(sanitizeHtml(input), input);
    });

    it('should handle self-closing syntax variations', () => {
      let input1 = '<br>';
      let input2 = '<br/>';
      let input3 = '<br />';
      // All should work
      assert.ok(sanitizeHtml(input1).includes('br'));
      assert.ok(sanitizeHtml(input2).includes('br'));
      assert.ok(sanitizeHtml(input3).includes('br'));
    });

    it('should handle comments (remove them)', () => {
      let input = '<p>Before</p><!-- comment --><p>After</p>';
      let result = sanitizeHtml(input);
      assert.ok(!result.includes('comment'));
      assert.ok(result.includes('Before'));
      assert.ok(result.includes('After'));
    });

    it('should handle CDATA sections (remove them)', () => {
      let input = '<![CDATA[Some content]]>';
      let result = sanitizeHtml(input);
      assert.ok(!result.includes('CDATA'));
    });

    it('should handle HTML entities', () => {
      let input = '<p>&lt;script&gt;not actually a tag&lt;/script&gt;</p>';
      assert.strictEqual(sanitizeHtml(input), input);
    });

    it('should handle unicode content', () => {
      let input = '<p>Hello 世界 🌍 émojis</p>';
      assert.strictEqual(sanitizeHtml(input), input);
    });
  });

  // ===========================================================================
  // Real-World Examples
  // ===========================================================================

  describe('Real-World Examples', () => {
    it('should sanitize a typical agent response', () => {
      let input = `
<p>Here's what I found:</p>
<h2>Results</h2>
<ul>
  <li><b>Item 1</b> - Description</li>
  <li><b>Item 2</b> - Another description</li>
</ul>
<p>Would you like more details?</p>
<hml-prompt id="more-info" type="radio">
  Select an option
  <data>[{"value":"yes","label":"Yes, tell me more"},{"value":"no","label":"No thanks"}]</data>
</hml-prompt>
`.trim();
      let result = sanitizeHtml(input);
      // Should preserve all the safe content
      assert.ok(result.includes('<h2>Results</h2>'));
      assert.ok(result.includes('<li><b>Item 1</b>'));
      assert.ok(result.includes('hml-prompt'));
    });

    it('should strip XSS attempt in otherwise valid content', () => {
      let input = '<p>Normal content</p><img src="x" onerror="alert(document.cookie)"><p>More content</p>';
      let result = sanitizeHtml(input);
      assert.ok(result.includes('Normal content'));
      assert.ok(result.includes('More content'));
      assert.ok(!result.includes('onerror'));
      assert.ok(!result.includes('alert'));
    });

    it('should handle thinking blocks', () => {
      let input = '<hml-thinking title="Analysis">Let me think about this step by step...</hml-thinking>';
      assert.strictEqual(sanitizeHtml(input), input);
    });

    it('should strip interaction tags from display', () => {
      let input = `
<p>I'll search for that information.</p>
<interaction>[{"interaction_id":"ws-1","target_id":"@system","target_property":"websearch","payload":{"query":"test"}}]</interaction>
<p>Searching now...</p>
`.trim();
      let result = sanitizeHtml(input);
      assert.ok(result.includes("I'll search"));
      assert.ok(result.includes('Searching now'));
      assert.ok(!result.includes('interaction'));
      assert.ok(!result.includes('websearch'));
    });
  });

  // ===========================================================================
  // Security Edge Cases - Attack Vectors
  // ===========================================================================

  describe('Security Edge Cases', () => {
    // Nested malicious content
    it('should handle nested script tags', () => {
      let input = '<script><script>alert(1)</script></script>';
      assert.strictEqual(sanitizeHtml(input), '');
    });

    it('should handle script inside allowed tags', () => {
      let input = '<p><script>alert(1)</script>Safe text</p>';
      let result = sanitizeHtml(input);
      assert.ok(!result.includes('script'));
      assert.ok(result.includes('Safe text'));
    });

    it('should handle deeply nested dangerous tags', () => {
      let input = '<div><p><span><script>evil()</script></span></p></div>';
      let result = sanitizeHtml(input);
      assert.ok(!result.includes('script'));
      assert.ok(!result.includes('evil'));
    });

    it('should handle iframe inside allowed content', () => {
      let input = '<p>Text<iframe src="evil.com"></iframe>More text</p>';
      let result = sanitizeHtml(input);
      assert.ok(!result.includes('iframe'));
      assert.ok(result.includes('Text'));
      assert.ok(result.includes('More text'));
    });

    // Encoding attacks
    it('should handle HTML entity encoded script tags', () => {
      // This tests that entities are properly decoded before sanitization
      let input = '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>';
      let result = sanitizeHtml(input);
      // Entities should remain as entities (they're safe as text)
      assert.ok(result.includes('&lt;script&gt;'));
    });

    it('should handle mixed case tag names', () => {
      let input = '<ScRiPt>alert(1)</sCrIpT>';
      assert.strictEqual(sanitizeHtml(input), '');
    });

    it('should handle null bytes in tags', () => {
      // Note: JSDOM parses null bytes differently than browsers
      // The important thing is the sanitizer doesn't crash
      let input = '<scr\x00ipt>alert(1)</script>';
      let result = sanitizeHtml(input);
      // Should not throw, should return a string
      assert.strictEqual(typeof result, 'string');
    });

    it('should handle unicode in attribute values', () => {
      let input = '<a href="javascript\u003aalert(1)">Click</a>';
      let result = sanitizeHtml(input);
      // The unicode colon might be decoded, so check for javascript protocol
      assert.ok(!result.toLowerCase().includes('javascript:alert') || result.includes('#'));
    });

    // Attribute injection
    it('should handle newlines in attributes', () => {
      let input = '<p on\nmouseover="alert(1)">Text</p>';
      let result = sanitizeHtml(input);
      assert.ok(!result.includes('alert'));
    });

    it('should handle tabs in attributes', () => {
      let input = '<p on\tmouseover="alert(1)">Text</p>';
      let result = sanitizeHtml(input);
      assert.ok(!result.includes('alert'));
    });

    it('should handle event handlers with varying whitespace', () => {
      let input = '<div onclick = "alert(1)" >Content</div>';
      let result = sanitizeHtml(input);
      assert.ok(!result.includes('onclick'));
      assert.ok(!result.includes('alert'));
    });

    it('should strip data- attributes (not in whitelist)', () => {
      let input = '<p data-evil="payload">Text</p>';
      let result = sanitizeHtml(input);
      assert.ok(!result.includes('data-evil'));
      assert.ok(result.includes('Text'));
    });

    // SVG/MathML attacks
    it('should remove svg tags', () => {
      let input = '<svg onload="alert(1)"><circle r="50"/></svg>';
      let result = sanitizeHtml(input);
      assert.ok(!result.includes('svg'));
      assert.ok(!result.includes('onload'));
    });

    it('should remove math tags', () => {
      let input = '<math><mi>x</mi></math>';
      assert.strictEqual(sanitizeHtml(input), '');
    });

    // Protocol handler attacks
    it('should neutralize vbscript: URLs', () => {
      let input = '<a href="vbscript:msgbox(1)">Click</a>';
      let result = sanitizeHtml(input);
      assert.ok(!result.includes('vbscript:'));
    });

    it('should neutralize data:text/html with base64', () => {
      let input = '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">Click</a>';
      let result = sanitizeHtml(input);
      assert.ok(!result.includes('data:text/html'));
    });

    // Stress tests
    it('should handle very deeply nested tags (50 levels)', () => {
      let depth = 50;
      let open = '<div>'.repeat(depth);
      let close = '</div>'.repeat(depth);
      let input = open + 'Content' + close;
      let result = sanitizeHtml(input);
      assert.ok(result.includes('Content'));
    });

    it('should handle many attributes on one element', () => {
      let attrs = Array.from({ length: 100 }, (_, i) => `data-attr${i}="value${i}"`).join(' ');
      let input = `<p ${attrs}>Text</p>`;
      let result = sanitizeHtml(input);
      // All data- attributes should be stripped
      assert.ok(!result.includes('data-attr'));
      assert.ok(result.includes('Text'));
    });

    it('should handle malformed closing tags', () => {
      let input = '<p>Text</p </p>';
      let result = sanitizeHtml(input);
      assert.ok(result.includes('Text'));
    });

    it('should handle tags with no closing bracket', () => {
      let input = '<p>Start <script alert(1) <p>End</p>';
      let result = sanitizeHtml(input);
      // Should not crash, content should be partially preserved
      assert.ok(typeof result === 'string');
    });
  });
});
