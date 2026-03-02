'use strict';

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { htmlToMarkdown } from '../../../../src/core/internal-plugins/websearch/html-to-markdown.mjs';
import { createKikxCore } from '../../../../src/core/index.mjs';

// =============================================================================
// htmlToMarkdown
// =============================================================================

describe('htmlToMarkdown', () => {
  it('should convert basic HTML to markdown', () => {
    let result = htmlToMarkdown('<p>Hello world</p>');
    assert.ok(result.includes('Hello world'));
  });

  it('should convert headings', () => {
    let result = htmlToMarkdown('<h1>Title</h1><h2>Subtitle</h2>');
    assert.ok(result.includes('# Title'));
    assert.ok(result.includes('## Subtitle'));
  });

  it('should convert links', () => {
    let result = htmlToMarkdown('<a href="https://example.com">Click here</a>');
    assert.ok(result.includes('[Click here](https://example.com)'));
  });

  it('should convert code blocks', () => {
    let result = htmlToMarkdown('<pre><code>const x = 1;</code></pre>');
    assert.ok(result.includes('const x = 1;'));
  });

  it('should strip script tags', () => {
    let result = htmlToMarkdown('<p>Content</p><script>alert("xss")</script>');
    assert.ok(result.includes('Content'));
    assert.ok(!result.includes('alert'));
  });

  it('should strip style tags', () => {
    let result = htmlToMarkdown('<p>Content</p><style>body { color: red; }</style>');
    assert.ok(result.includes('Content'));
    assert.ok(!result.includes('color: red'));
  });

  it('should strip nav tags', () => {
    let result = htmlToMarkdown('<nav>Navigation</nav><p>Content</p>');
    assert.ok(result.includes('Content'));
    assert.ok(!result.includes('Navigation'));
  });

  it('should strip footer and header tags', () => {
    let result = htmlToMarkdown('<header>Head</header><p>Body</p><footer>Foot</footer>');
    assert.ok(result.includes('Body'));
    assert.ok(!result.includes('Head'));
    assert.ok(!result.includes('Foot'));
  });

  it('should strip aside tags', () => {
    let result = htmlToMarkdown('<aside>Sidebar</aside><p>Main</p>');
    assert.ok(result.includes('Main'));
    assert.ok(!result.includes('Sidebar'));
  });

  it('should return empty string for null input', () => {
    assert.equal(htmlToMarkdown(null), '');
    assert.equal(htmlToMarkdown(undefined), '');
    assert.equal(htmlToMarkdown(''), '');
  });

  it('should convert bold and italic', () => {
    let result = htmlToMarkdown('<strong>bold</strong> and <em>italic</em>');
    assert.ok(result.includes('**bold**'));
    assert.ok(result.includes('_italic_') || result.includes('*italic*'));
  });

  it('should convert unordered lists', () => {
    let result = htmlToMarkdown('<ul><li>Item 1</li><li>Item 2</li></ul>');
    assert.ok(result.includes('Item 1'));
    assert.ok(result.includes('Item 2'));
    assert.ok(result.includes('-')); // Uses dash bullet marker
  });
});

// =============================================================================
// WebsearchTool registration
// =============================================================================

describe('WebsearchTool', () => {
  let core;

  beforeEach(async () => {
    core = createKikxCore();
    await core.start();
  });

  afterEach(async () => {
    if (core && core.isStarted())
      await core.stop();
  });

  it('should register as websearch:fetch tool', () => {
    let registry  = core.getPluginRegistry();
    let ToolClass = registry.getTool('websearch:fetch');
    assert.ok(ToolClass, 'websearch:fetch should be registered');
  });

  it('should throw if url is missing', async () => {
    let registry  = core.getPluginRegistry();
    let ToolClass = registry.getTool('websearch:fetch');
    let tool      = new ToolClass(core.getContext());

    await assert.rejects(
      () => tool.execute({}),
      { message: 'url is required' },
    );
  });

  it('should provide help information', () => {
    let registry  = core.getPluginRegistry();
    let ToolClass = registry.getTool('websearch:fetch');
    let tool      = new ToolClass(core.getContext());
    let help      = tool.getHelp();

    assert.equal(help.name, 'websearch:fetch');
    assert.equal(help.displayName, 'Web Search');
    assert.ok(help.description);
  });
});
