'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { markdownToHTML } from '../../src/client/lib/markdown-renderer.mjs';

test('markdownToHTML renders plain text without paragraph tags', () => {
  let html = markdownToHTML('Hello **world**\nSecond line\n\nNext block');

  assert.equal(html.includes('<p>'), false);
  assert.match(html, /^<div class="kikx-markdown__text">Hello <strong>world<\/strong><br>Second line<\/div>/);
  assert.match(html, /<div class="kikx-markdown__text">Next block<\/div>$/);
});

test('markdownToHTML renders structural markdown blocks', () => {
  let html = markdownToHTML([
    '## Plan',
    '- one',
    '- two',
    '',
    '> quote',
    '',
    '```js',
    'const x = 1 < 2;',
    '```',
  ].join('\n'));

  assert.match(html, /<h2>Plan<\/h2>/);
  assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
  assert.match(html, /<blockquote>quote<\/blockquote>/);
  assert.match(html, /<pre><code class="language-js">const x = 1 &lt; 2;<\/code><\/pre>/);
  assert.equal(html.includes('<p>'), false);
});

test('markdownToHTML renders links, inline code, tables, and safe inline html', () => {
  let html = markdownToHTML([
    'Use `code` and [docs](https://example.test/docs).',
    '',
    '| A | B |',
    '|---|---|',
    '| <strong>1</strong> | [2](javascript:alert(1)) |',
  ].join('\n'));

  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<a href="https:\/\/example.test\/docs" target="_blank" rel="noopener noreferrer">docs<\/a>/);
  assert.match(html, /<table><thead><tr><th>A<\/th><th>B<\/th><\/tr><\/thead><tbody><tr><td><strong>1<\/strong><\/td><td>2<\/td><\/tr><\/tbody><\/table>/);
  assert.equal(html.includes('javascript:'), false);
});

test('markdownToHTML autolinks bare safe URLs outside code and existing anchors', () => {
  let html = markdownToHTML([
    'Visit https://example.test/docs?x=1.',
    '`https://example.test/code`',
    '<a href="https://example.test/raw">https://example.test/raw</a>',
  ].join('\n'));

  assert.match(html, /Visit <a href="https:\/\/example.test\/docs\?x=1" target="_blank" rel="noopener noreferrer">https:\/\/example.test\/docs\?x=1<\/a>\./);
  assert.match(html, /<code>https:\/\/example.test\/code<\/code>/);
  assert.match(html, /<a href="https:\/\/example.test\/raw" target="_blank" rel="noopener noreferrer">https:\/\/example.test\/raw<\/a>/);
  assert.equal((html.match(/<a /g) || []).length, 2);
});

test('markdownToHTML strips paragraph tags and escapes dangerous html', () => {
  let html = markdownToHTML('<p>Hello</p> <script>alert("x")</script>');

  assert.match(html, /<div class="kikx-markdown__text">Hello &lt;script&gt;alert\("x"\)&lt;\/script&gt;<\/div>/);
  assert.equal(html.includes('<p>'), false);
  assert.equal(html.includes('<script>'), false);
});
