'use strict';

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { HelpIndex } from '../../../src/core/help/help-index.mjs';
import { PluginRegistry } from '../../../src/core/plugin-loader/registry.mjs';
import { PluginInterface } from '../../../src/core/plugin-loader/plugin-interface.mjs';
import { createKikxCore } from '../../../src/core/index.mjs';

// =============================================================================
// HelpIndex — with mock registry
// =============================================================================

describe('HelpIndex', () => {
  let registry;

  beforeEach(() => {
    registry = new PluginRegistry();
  });

  it('should throw if constructed without registry', () => {
    assert.throws(
      () => new HelpIndex(),
      { message: 'HelpIndex requires a PluginRegistry' },
    );
  });

  it('should return empty entries when no tools registered', () => {
    let index   = new HelpIndex(registry);
    let entries = index.getEntries();
    assert.ok(Array.isArray(entries));
    assert.equal(entries.length, 0);
  });

  it('should enumerate all registered tools', () => {
    class ToolA extends PluginInterface {
      static pluginId    = 'toolA';
      static featureName = 'run';
      static displayName = 'Tool A';
      static description = 'First tool';
    }

    class ToolB extends PluginInterface {
      static pluginId    = 'toolB';
      static featureName = 'execute';
      static displayName = 'Tool B';
      static description = 'Second tool';
    }

    registry.registerTool('toolA:run', ToolA);
    registry.registerTool('toolB:execute', ToolB);

    let index   = new HelpIndex(registry);
    let entries = index.getEntries();

    assert.equal(entries.length, 2);
    assert.ok(entries.some((e) => e.toolName === 'toolA:run'));
    assert.ok(entries.some((e) => e.toolName === 'toolB:execute'));
  });

  it('should include help metadata from getHelp()', () => {
    class ToolC extends PluginInterface {
      static pluginId    = 'toolC';
      static featureName = 'action';
      static displayName = 'Tool C';
      static description = 'A test tool';
      static icon        = 'wrench';
    }

    registry.registerTool('toolC:action', ToolC);

    let index   = new HelpIndex(registry);
    let entries = index.getEntries();

    assert.equal(entries.length, 1);
    assert.equal(entries[0].displayName, 'Tool C');
    assert.equal(entries[0].description, 'A test tool');
    assert.equal(entries[0].icon, 'wrench');
  });

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------

  describe('search', () => {
    beforeEach(() => {
      class ShellTool extends PluginInterface {
        static pluginId    = 'shell';
        static featureName = 'execute';
        static displayName = 'Shell';
        static description = 'Execute shell commands';
      }

      class WebTool extends PluginInterface {
        static pluginId    = 'websearch';
        static featureName = 'fetch';
        static displayName = 'Web Search';
        static description = 'Fetch and render web pages';
      }

      class HelpToolClass extends PluginInterface {
        static pluginId    = 'help';
        static featureName = 'search';
        static displayName = 'Help';
        static description = 'Search available tools';
      }

      registry.registerTool('shell:execute', ShellTool);
      registry.registerTool('websearch:fetch', WebTool);
      registry.registerTool('help:search', HelpToolClass);
    });

    it('should search by tool name', () => {
      let index   = new HelpIndex(registry);
      let results = index.search('shell');

      assert.equal(results.length, 1);
      assert.equal(results[0].toolName, 'shell:execute');
    });

    it('should search by display name', () => {
      let index   = new HelpIndex(registry);
      let results = index.search('Web Search');

      assert.equal(results.length, 1);
      assert.equal(results[0].toolName, 'websearch:fetch');
    });

    it('should search by description', () => {
      let index   = new HelpIndex(registry);
      let results = index.search('web pages');

      assert.equal(results.length, 1);
      assert.equal(results[0].toolName, 'websearch:fetch');
    });

    it('should be case-insensitive', () => {
      let index   = new HelpIndex(registry);
      let results = index.search('SHELL');

      assert.equal(results.length, 1);
      assert.equal(results[0].toolName, 'shell:execute');
    });

    it('should return all entries for empty query', () => {
      let index   = new HelpIndex(registry);
      let results = index.search('');

      assert.equal(results.length, 3);
    });

    it('should return all entries for null query', () => {
      let index   = new HelpIndex(registry);
      let results = index.search(null);

      assert.equal(results.length, 3);
    });

    it('should return empty array when no results match', () => {
      let index   = new HelpIndex(registry);
      let results = index.search('nonexistent');

      assert.equal(results.length, 0);
    });

    it('should match partial tool names', () => {
      let index   = new HelpIndex(registry);
      let results = index.search('execute');

      assert.ok(results.length >= 1);
      assert.ok(results.some((e) => e.toolName === 'shell:execute'));
    });
  });
});

// =============================================================================
// HelpTool integration — needs core.start() (DB-dependent)
// =============================================================================

describe('HelpTool integration', () => {
  let core;

  beforeEach(async () => {
    core = createKikxCore();
    await core.start();
  });

  afterEach(async () => {
    if (core && core.isStarted())
      await core.stop();
  });

  it('should register help:search tool', () => {
    let registry  = core.getPluginRegistry();
    let ToolClass = registry.getTool('help:search');
    assert.ok(ToolClass, 'help:search should be registered');
  });

  it('should return all tools when no query', async () => {
    let registry  = core.getPluginRegistry();
    let ToolClass = registry.getTool('help:search');
    let tool      = new ToolClass(core.getContext());
    let result    = await tool.execute({});

    assert.ok(result.entries);
    assert.ok(Array.isArray(result.entries));
    assert.ok(result.entries.length >= 3); // shell, websearch, help at minimum
  });

  it('should search tools by query', async () => {
    let registry  = core.getPluginRegistry();
    let ToolClass = registry.getTool('help:search');
    let tool      = new ToolClass(core.getContext());
    let result    = await tool.execute({ query: 'shell' });

    assert.ok(result.entries);
    assert.ok(result.entries.length >= 1);
    assert.ok(result.entries.some((e) => e.toolName === 'shell:execute'));
  });
});
