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

  it('should return empty entries when no tools or commands registered', () => {
    let index   = new HelpIndex(registry);
    let entries = index.getEntries();
    assert.ok(Array.isArray(entries));
    assert.equal(entries.length, 0);
  });

  it('should enumerate all registered tools', () => {
    class ToolA extends PluginInterface {
      static pluginID    = 'toolA';
      static featureName = 'run';
      static displayName = 'Tool A';
      static description = 'First tool';
    }

    class ToolB extends PluginInterface {
      static pluginID    = 'toolB';
      static featureName = 'execute';
      static displayName = 'Tool B';
      static description = 'Second tool';
    }

    registry.registerTool('toolA:run', ToolA);
    registry.registerTool('toolB:execute', ToolB);

    let index   = new HelpIndex(registry);
    let entries = index.getEntries();
    let tools   = entries.filter((e) => e.category === 'tool');

    assert.equal(tools.length, 2);
    assert.ok(tools.some((e) => e.name === 'toolA:run'));
    assert.ok(tools.some((e) => e.name === 'toolB:execute'));
  });

  it('should enumerate registered commands', () => {
    registry.registerCommand('reload', () => {}, {
      description: 'Reload instructions',
      usage:       '/reload',
    });

    let index    = new HelpIndex(registry);
    let entries  = index.getEntries();
    let commands = entries.filter((e) => e.category === 'command');

    assert.equal(commands.length, 1);
    assert.equal(commands[0].name, '/reload');
    assert.equal(commands[0].description, 'Reload instructions');
  });

  it('should include both tools and commands in entries', () => {
    class ToolA extends PluginInterface {
      static pluginID    = 'toolA';
      static featureName = 'run';
      static displayName = 'Tool A';
      static description = 'A tool';
    }

    registry.registerTool('toolA:run', ToolA);
    registry.registerCommand('help', () => {}, { description: 'Show help' });

    let index   = new HelpIndex(registry);
    let entries = index.getEntries();

    assert.equal(entries.length, 2);
    assert.ok(entries.some((e) => e.category === 'tool' && e.name === 'toolA:run'));
    assert.ok(entries.some((e) => e.category === 'command' && e.name === '/help'));
  });

  it('should include help metadata from getHelp()', () => {
    class ToolC extends PluginInterface {
      static pluginID    = 'toolC';
      static featureName = 'action';
      static displayName = 'Tool C';
      static description = 'A test tool';
      static icon        = 'wrench';
    }

    registry.registerTool('toolC:action', ToolC);

    let index   = new HelpIndex(registry);
    let entries = index.getEntries();
    let tools   = entries.filter((e) => e.category === 'tool');

    assert.equal(tools.length, 1);
    assert.equal(tools[0].displayName, 'Tool C');
    assert.equal(tools[0].description, 'A test tool');
    assert.equal(tools[0].icon, 'wrench');
  });

  // -------------------------------------------------------------------------
  // Capabilities
  // -------------------------------------------------------------------------

  it('should include registered capabilities in entries', () => {
    registry.registerCapability('invite', {
      handler:      async () => {},
      description:  'Invite an agent',
      displayName:  'Invite Agent',
      riskLevel:    'high',
      slashCommand: 'invite',
      schema:       { type: 'object', properties: { agentName: { type: 'string' } } },
    });

    let index   = new HelpIndex(registry);
    let entries = index.getEntries();
    let caps    = entries.filter((e) => e.category === 'capability');

    assert.equal(caps.length, 1);
    assert.equal(caps[0].name, 'invite');
    assert.equal(caps[0].description, 'Invite an agent');
    assert.equal(caps[0].displayName, 'Invite Agent');
    assert.equal(caps[0].riskLevel, 'high');
    assert.equal(caps[0].slashCommand, 'invite');
    assert.ok(caps[0].schema);
  });

  it('should include capabilities alongside tools and commands', () => {
    class ToolA extends PluginInterface {
      static pluginID    = 'toolA';
      static featureName = 'run';
      static displayName = 'Tool A';
      static description = 'A tool';
    }

    registry.registerTool('toolA:run', ToolA);
    registry.registerCommand('help', () => {}, { description: 'Show help' });
    registry.registerCapability('invite', {
      handler:     async () => {},
      description: 'Invite agent',
    });

    let index   = new HelpIndex(registry);
    let entries = index.getEntries();

    assert.equal(entries.length, 3);
    assert.ok(entries.some((e) => e.category === 'tool'));
    assert.ok(entries.some((e) => e.category === 'command'));
    assert.ok(entries.some((e) => e.category === 'capability'));
  });

  it('should search across capabilities', () => {
    registry.registerCapability('invite', {
      handler:      async () => {},
      description:  'Invite an agent to the session',
      displayName:  'Invite Agent',
      slashCommand: 'invite',
    });

    let index   = new HelpIndex(registry);
    let results = index.search('invite');

    assert.ok(results.length >= 1);
    assert.ok(results.some((e) => e.name === 'invite' && e.category === 'capability'));
  });

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------

  describe('search', () => {
    beforeEach(() => {
      class ShellTool extends PluginInterface {
        static pluginID    = 'shell';
        static featureName = 'execute';
        static displayName = 'Shell';
        static description = 'Execute shell commands';
      }

      class WebTool extends PluginInterface {
        static pluginID    = 'websearch';
        static featureName = 'fetch';
        static displayName = 'Web Search';
        static description = 'Fetch and render web pages';
      }

      class HelpToolClass extends PluginInterface {
        static pluginID    = 'help';
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
      assert.equal(results[0].name, 'shell:execute');
    });

    it('should search by display name', () => {
      let index   = new HelpIndex(registry);
      let results = index.search('Web Search');

      assert.equal(results.length, 1);
      assert.equal(results[0].name, 'websearch:fetch');
    });

    it('should search by description', () => {
      let index   = new HelpIndex(registry);
      let results = index.search('web pages');

      assert.equal(results.length, 1);
      assert.equal(results[0].name, 'websearch:fetch');
    });

    it('should be case-insensitive', () => {
      let index   = new HelpIndex(registry);
      let results = index.search('SHELL');

      assert.equal(results.length, 1);
      assert.equal(results[0].name, 'shell:execute');
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
      assert.ok(results.some((e) => e.name === 'shell:execute'));
    });

    it('should search across commands too', () => {
      registry.registerCommand('reload', () => {}, {
        description: 'Reload the agent instructions',
      });

      let index   = new HelpIndex(registry);
      let results = index.search('reload');

      assert.ok(results.length >= 1);
      assert.ok(results.some((e) => e.name === '/reload' && e.category === 'command'));
    });

    it('should search by category', () => {
      registry.registerCommand('mytest', () => {}, {
        description: 'A test action',
      });

      let index   = new HelpIndex(registry);
      let results = index.search('command');

      // "command" matches the category field of commands, and also
      // tool descriptions containing "command" (e.g., "Execute shell commands")
      assert.ok(results.length >= 1);
      assert.ok(results.some((e) => e.category === 'command'));
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

  it('should return all tools and commands when no query', async () => {
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
    assert.ok(result.entries.some((e) => e.name === 'shell:execute'));
  });
});
