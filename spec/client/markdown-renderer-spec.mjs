'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { installDom } from './support/mini-dom.mjs';

import { markdownToHTML, markdownToRawHTML, renderMarkdownToElement } from '../../src/client/lib/markdown-renderer.mjs';

const { document } = installDom();

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

test('markdownToHTML renders bold containing inline code and italics', () => {
  let html = markdownToHTML("**The `if_content_hash` you're thinking of already exists — but on the *read* side.** `database-tools.mjs:131`");

  assert.match(html, /<strong>The <code>if_content_hash<\/code> you're thinking of already exists — but on the <em>read<\/em> side\.<\/strong> <code>database-tools\.mjs:131<\/code>/);
  assert.equal(html.includes('**'), false);
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
  assert.match(html, /<div class="kikx-markdown__table-scroll"><table><thead><tr><th>A<\/th><th>B<\/th><\/tr><\/thead><tbody><tr><td><strong>1<\/strong><\/td><td>2<\/td><\/tr><\/tbody><\/table><\/div>/);
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

test('renderMarkdownToElement keeps html-looking text inside inline code as code', () => {
  let element = renderMarkdownToElement(
    document,
    '`renderDescription` only builds a `<code>` when `codeText` is truthy; `codeText` is `data.code || \'\'`.',
  );

  let codes = [ ...element.querySelectorAll('code') ];
  assert.deepEqual(codes.map((code) => code.textContent), [
    'renderDescription',
    '<code>',
    'codeText',
    'codeText',
    'data.code || \'\'',
  ]);
  assert.equal(element.textContent.includes('`'), false);
  assert.equal(element.querySelector('strong'), null);
});

test('user-message markdown renders underscore italics and ordered lists', () => {
  let html = markdownToHTML([
    'FYI: the message is _from me_...',
    '',
    '1. The message is _hidden_...',
    '2. It should _appear_ seamless.',
  ].join('\n'));

  assert.match(html, /<em>from me<\/em>/);
  assert.match(html, /<em>hidden<\/em>/);
  assert.match(html, /<em>appear<\/em>/);
  assert.match(html, /<ol><li>/);
  assert.doesNotMatch(html, /snake_case/);
});

test('raw Markdown keeps delimiters while rendering their inline contents', () => {
  let html = markdownToRawHTML('**bold** and _italics_ are ~~cool~~ AWESOME!!!\n# Heading');

  assert.match(html, /\*\*<strong>bold<\/strong>\*\*/);
  assert.match(html, /_<em>italics<\/em>_/);
  assert.match(html, /~~<del>cool<\/del>~~/);
  assert.match(html, /# Heading/);
  assert.equal(html.includes('<h1>'), false, 'block syntax stays literal in raw mode');
});

test('raw Markdown escapes source HTML and protects inline code from emphasis', () => {
  let html = markdownToRawHTML('<script>alert("x")</script> `**not bold**`');

  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;alert\("x"\)&lt;\/script&gt;/);
  assert.match(html, /`<code>\*\*not bold\*\*<\/code>`/);
  assert.equal(html.includes('<strong>'), false, 'asterisks inside code stay literal');
});

test('renderMarkdownToElement applies raw mode as a class and text view', () => {
  let element = renderMarkdownToElement(document, '**bold** and _italics_', { rawMarkdown: true });

  assert.match(element.className, /kikx-markdown--raw/);
  assert.equal(element.textContent, '**bold** and _italics_');
  assert.equal(element.querySelector('strong')?.textContent, 'bold');
  assert.equal(element.querySelector('em')?.textContent, 'italics');
});
