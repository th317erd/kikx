'use strict';

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { htmlToMarkdown } from '../../../../src/core/internal-plugins/websearch/html-to-markdown.mjs';
import { createKikxCore } from '../../../../src/core/index.mjs';

// =============================================================================
// Helpers
// =============================================================================

/** Create a tool instance that bypasses permission checks. */
function createBypassedTool(ToolClass, core) {
  let tool = new ToolClass(core.getContext());
  tool._checkPermissions = async () => {}; // bypass permissions in unit tests
  return tool;
}

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
// websearch:fetch registration and behavior
// =============================================================================

describe('websearch:fetch', () => {
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
    let tool      = createBypassedTool(ToolClass, core);

    await assert.rejects(
      () => tool._execute({}),
      { message: 'url is required' },
    );
  });

  it('should throw if url is not a string', async () => {
    let registry  = core.getPluginRegistry();
    let ToolClass = registry.getTool('websearch:fetch');
    let tool      = createBypassedTool(ToolClass, core);

    await assert.rejects(
      () => tool._execute({ url: 123 }),
      { message: 'url is required' },
    );
  });

  it('should provide help information', () => {
    let registry  = core.getPluginRegistry();
    let ToolClass = registry.getTool('websearch:fetch');
    let tool      = createBypassedTool(ToolClass, core);
    let help      = tool.getHelp();

    assert.equal(help.name, 'websearch:fetch');
    assert.equal(help.displayName, 'Fetch Page');
    assert.ok(help.description);
    assert.ok(help.inputSchema);
    assert.ok(help.usage);
    assert.ok(help.examples);
    assert.ok(help.examples.length > 0);
  });
});

// =============================================================================
// websearch:search registration and behavior
// =============================================================================

describe('websearch:search', () => {
  let core;

  beforeEach(async () => {
    core = createKikxCore();
    await core.start();
  });

  afterEach(async () => {
    if (core && core.isStarted())
      await core.stop();
  });

  it('should register as websearch:search tool', () => {
    let registry  = core.getPluginRegistry();
    let ToolClass = registry.getTool('websearch:search');
    assert.ok(ToolClass, 'websearch:search should be registered');
  });

  it('should throw if query is missing', async () => {
    let registry  = core.getPluginRegistry();
    let ToolClass = registry.getTool('websearch:search');
    let tool      = createBypassedTool(ToolClass, core);

    await assert.rejects(
      () => tool._execute({}),
      { message: 'query is required' },
    );
  });

  it('should throw if query is not a string', async () => {
    let registry  = core.getPluginRegistry();
    let ToolClass = registry.getTool('websearch:search');
    let tool      = createBypassedTool(ToolClass, core);

    await assert.rejects(
      () => tool._execute({ query: 42 }),
      { message: 'query is required' },
    );
  });

  it('should throw when puppeteer plugin is not installed', async () => {
    let registry  = core.getPluginRegistry();
    let ToolClass = registry.getTool('websearch:search');
    let tool      = createBypassedTool(ToolClass, core);

    await assert.rejects(
      () => tool._execute({ query: 'test' }),
      (error) => {
        assert.ok(error.message.includes('kikx-plugin-puppeteer'));
        return true;
      },
    );
  });

  it('should provide help information', () => {
    let registry  = core.getPluginRegistry();
    let ToolClass = registry.getTool('websearch:search');
    let tool      = createBypassedTool(ToolClass, core);
    let help      = tool.getHelp();

    assert.equal(help.name, 'websearch:search');
    assert.equal(help.displayName, 'Web Search');
    assert.ok(help.description);
    assert.ok(help.inputSchema);
    assert.ok(help.usage);
    assert.ok(help.examples);
    assert.ok(help.examples.length > 0);
  });

  it('should have correct input schema', () => {
    let registry  = core.getPluginRegistry();
    let ToolClass = registry.getTool('websearch:search');

    assert.equal(ToolClass.inputSchema.type, 'object');
    assert.ok(ToolClass.inputSchema.properties.query);
    assert.ok(ToolClass.inputSchema.properties.limit);
    assert.deepEqual(ToolClass.inputSchema.required, ['query']);
  });

  it('should use executeInBrowser hook when puppeteer plugin is loaded', async () => {
    let registry = core.getPluginRegistry();
    let hookCalled = false;

    // Simulate puppeteer plugin registering its hook
    registry.registerHook('websearch:executeInBrowser', async (callback) => {
      hookCalled = true;

      // Return mock search results
      return [
        { title: 'Mock Result', url: 'https://example.com', snippet: 'A mock result' },
      ];
    });

    let ToolClass = registry.getTool('websearch:search');
    let tool      = createBypassedTool(ToolClass, core);
    let result    = await tool._execute({ query: 'test query' });

    assert.ok(hookCalled, 'hook should have been called');
    assert.equal(result.query, 'test query');
    assert.equal(result.resultCount, 1);
    assert.equal(result.results[0].title, 'Mock Result');
    assert.ok(result.content.includes('Mock Result'));
    assert.ok(result.content.includes('https://example.com'));
  });
});

// =============================================================================
// websearch:fetch rendering strategy
// =============================================================================

describe('websearch:fetch rendering strategy', () => {
  let core;

  beforeEach(async () => {
    core = createKikxCore();
    await core.start();
  });

  afterEach(async () => {
    if (core && core.isStarted())
      await core.stop();
  });

  it('should use renderPage hook when available and markdown negotiation fails', async () => {
    let registry   = core.getPluginRegistry();
    let hookCalled = false;

    // Simulate puppeteer plugin registering its hook
    registry.registerHook('websearch:renderPage', async ({ url, timeout }) => {
      hookCalled = true;
      return { html: '<p>Rendered content</p>', title: 'Test Page', url };
    });

    let ToolClass = registry.getTool('websearch:fetch');
    let tool      = createBypassedTool(ToolClass, core);

    // Use a URL that will fail markdown negotiation (no server)
    // but the hook should still be called as fallback
    let result = await tool._execute({ url: 'http://localhost:99999/test' });

    assert.ok(hookCalled, 'renderPage hook should have been called');
    assert.equal(result.title, 'Test Page');
    assert.ok(result.markdown.includes('Rendered content'));
  });
});
