'use strict';

import { describe, it, beforeEach, afterEach }  from 'node:test';
import assert                                    from 'node:assert/strict';
import { mkdir, writeFile, rm }                  from 'node:fs/promises';
import { join }                                  from 'node:path';
import { tmpdir }                                from 'node:os';

import {
  PluginLoader,
  PluginInterface,
  PluginRegistry,
  PluginProvider,
  InMemoryPluginProvider,
  FilesystemPluginProvider,
} from '../../src/core/plugin-loader/index.mjs';

import { AgentInterface } from '../../src/core/plugins/agent-interface.mjs';

// =============================================================================
// Helpers
// =============================================================================

function createTestToolClass(overrides) {
  let defaults = {
    pluginId:    'test-plugin',
    featureName: 'test-feature',
    displayName: 'Test Feature',
    description: 'A test tool',
    icon:        'wrench',
    version:     '1.0.0',
  };

  let merged = { ...defaults, ...overrides };

  class TestTool extends PluginInterface {
    static pluginId    = merged.pluginId;
    static featureName = merged.featureName;
    static displayName = merged.displayName;
    static description = merged.description;
    static icon        = merged.icon;
    static version     = merged.version;

    async _execute(params) {
      return { result: 'ok', params };
    }
  }

  return TestTool;
}

// =============================================================================
// PluginInterface
// =============================================================================

describe('PluginInterface', () => {
  it('should have null static metadata by default', () => {
    assert.equal(PluginInterface.pluginId, null);
    assert.equal(PluginInterface.featureName, null);
    assert.equal(PluginInterface.displayName, null);
    assert.equal(PluginInterface.description, null);
    assert.equal(PluginInterface.icon, null);
  });

  it('should have default version of 1.0.0', () => {
    assert.equal(PluginInterface.version, '1.0.0');
  });

  it('should have default riskLevel of high', () => {
    assert.equal(PluginInterface.riskLevel, 'high');
  });

  it('should store context on construction', () => {
    let context  = { foo: 'bar' };
    let instance = new PluginInterface(context);
    assert.equal(instance._context, context);
  });

  it('should throw on _execute if not overridden', async () => {
    let instance = new PluginInterface({});
    await assert.rejects(
      () => instance.execute({}),
      { message: 'PluginInterface._execute() not implemented' },
    );
  });

  it('should delegate execute to _execute', async () => {
    let TestTool = createTestToolClass();
    let instance = new TestTool({});
    let result   = await instance.execute({ x: 1 });
    assert.deepEqual(result, { result: 'ok', params: { x: 1 } });
  });

  it('should return help object from getHelp', () => {
    let TestTool = createTestToolClass({
      pluginId:    'my-plugin',
      featureName: 'search',
      displayName: 'Web Search',
      description: 'Searches the web',
      icon:        'magnifying-glass',
    });

    let instance = new TestTool({});
    let help     = instance.getHelp();

    assert.deepEqual(help, {
      name:        'my-plugin:search',
      displayName: 'Web Search',
      description: 'Searches the web',
      icon:        'magnifying-glass',
    });
  });

  it('should return null from getPermissionsClass by default', () => {
    let instance = new PluginInterface({});
    assert.equal(instance.getPermissionsClass(), null);
  });

  it('should format help name as pluginId:featureName', () => {
    let TestTool = createTestToolClass({
      pluginId:    'alpha',
      featureName: 'beta',
    });

    let instance = new TestTool({});
    assert.equal(instance.getHelp().name, 'alpha:beta');
  });

  it('should use subclass name in _execute error message', async () => {
    class MySpecialTool extends PluginInterface {}

    let instance = new MySpecialTool({});
    await assert.rejects(
      () => instance.execute({}),
      { message: 'MySpecialTool._execute() not implemented' },
    );
  });

  it('should allow subclasses to override static metadata', () => {
    let TestTool = createTestToolClass({
      pluginId:    'custom',
      featureName: 'custom-feature',
      version:     '2.5.0',
    });

    assert.equal(TestTool.pluginId, 'custom');
    assert.equal(TestTool.featureName, 'custom-feature');
    assert.equal(TestTool.version, '2.5.0');
  });
});

// =============================================================================
// PluginProvider (base class)
// =============================================================================

describe('PluginProvider', () => {
  it('should throw on discover if not overridden', async () => {
    let provider = new PluginProvider();
    await assert.rejects(
      () => provider.discover(),
      { message: 'PluginProvider.discover() not implemented' },
    );
  });

  it('should throw on load if not overridden', async () => {
    let provider = new PluginProvider();
    await assert.rejects(
      () => provider.load('test'),
      { message: 'PluginProvider.load() not implemented' },
    );
  });

  it('should have watch and unwatch stubs that do nothing', () => {
    let provider = new PluginProvider();
    // Should not throw
    provider.watch();
    provider.unwatch();
  });
});

// =============================================================================
// InMemoryPluginProvider
// =============================================================================

describe('InMemoryPluginProvider', () => {
  it('should accept a plain object of plugins', async () => {
    let module   = { setup: () => {} };
    let provider = new InMemoryPluginProvider({ 'my-plugin': module });
    let names    = await provider.discover();
    assert.deepEqual(names, ['my-plugin']);
  });

  it('should accept a Map of plugins', async () => {
    let pluginsMap = new Map();
    pluginsMap.set('alpha', { setup: () => {} });
    pluginsMap.set('beta', { setup: () => {} });

    let provider = new InMemoryPluginProvider(pluginsMap);
    let names    = await provider.discover();
    assert.deepEqual(names, ['alpha', 'beta']);
  });

  it('should return empty array when no plugins provided', async () => {
    let provider = new InMemoryPluginProvider();
    let names    = await provider.discover();
    assert.deepEqual(names, []);
  });

  it('should load a registered plugin module', async () => {
    let module   = { setup: () => 'initialized' };
    let provider = new InMemoryPluginProvider({ 'test-plugin': module });
    let loaded   = await provider.load('test-plugin');
    assert.equal(loaded, module);
  });

  it('should throw when loading a non-existent plugin', async () => {
    let provider = new InMemoryPluginProvider({});
    await assert.rejects(
      () => provider.load('nope'),
      { message: 'Plugin "nope" not found in InMemoryPluginProvider' },
    );
  });

  it('should not mutate the original Map', async () => {
    let original = new Map([['a', { setup: () => {} }]]);
    let provider = new InMemoryPluginProvider(original);

    // Mutate original
    original.set('b', { setup: () => {} });

    let names = await provider.discover();
    assert.deepEqual(names, ['a']);
  });
});

// =============================================================================
// FilesystemPluginProvider
// =============================================================================

describe('FilesystemPluginProvider', () => {
  let tempDirectory;

  beforeEach(async () => {
    tempDirectory = join(tmpdir(), `kikx-plugin-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(tempDirectory, { recursive: true });
  });

  afterEach(async () => {
    try {
      await rm(tempDirectory, { recursive: true, force: true });
    } catch (_error) {
      // Ignore cleanup errors
    }
  });

  it('should discover plugins with index.mjs in subdirectories', async () => {
    // Create plugin-a/index.mjs
    let pluginDirectory = join(tempDirectory, 'plugin-a');
    await mkdir(pluginDirectory);
    await writeFile(
      join(pluginDirectory, 'index.mjs'),
      'export function setup() { return () => {}; }',
    );

    let provider = new FilesystemPluginProvider([tempDirectory]);
    let names    = await provider.discover();

    assert.deepEqual(names, ['plugin-a']);
  });

  it('should discover multiple plugins', async () => {
    for (let name of ['alpha', 'beta', 'gamma']) {
      let directory = join(tempDirectory, name);
      await mkdir(directory);
      await writeFile(
        join(directory, 'index.mjs'),
        'export function setup() {}',
      );
    }

    let provider = new FilesystemPluginProvider([tempDirectory]);
    let names    = await provider.discover();

    assert.equal(names.length, 3);
    assert.ok(names.includes('alpha'));
    assert.ok(names.includes('beta'));
    assert.ok(names.includes('gamma'));
  });

  it('should skip directories without index.mjs', async () => {
    // Has index.mjs
    let validDirectory = join(tempDirectory, 'valid');
    await mkdir(validDirectory);
    await writeFile(join(validDirectory, 'index.mjs'), 'export function setup() {}');

    // No index.mjs
    let emptyDirectory = join(tempDirectory, 'empty');
    await mkdir(emptyDirectory);

    let provider = new FilesystemPluginProvider([tempDirectory]);
    let names    = await provider.discover();

    assert.deepEqual(names, ['valid']);
  });

  it('should skip non-directory entries', async () => {
    // Create a regular file at root level (not a directory)
    await writeFile(join(tempDirectory, 'not-a-plugin.mjs'), 'export default {}');

    let provider = new FilesystemPluginProvider([tempDirectory]);
    let names    = await provider.discover();

    assert.deepEqual(names, []);
  });

  it('should handle empty directory', async () => {
    let provider = new FilesystemPluginProvider([tempDirectory]);
    let names    = await provider.discover();
    assert.deepEqual(names, []);
  });

  it('should handle non-existent directory gracefully', async () => {
    let provider = new FilesystemPluginProvider(['/tmp/kikx-nonexistent-dir-xyz123']);
    let names    = await provider.discover();
    assert.deepEqual(names, []);
  });

  it('should scan multiple directories', async () => {
    let directory1 = join(tempDirectory, 'dir1');
    let directory2 = join(tempDirectory, 'dir2');
    await mkdir(directory1);
    await mkdir(directory2);

    let plugin1 = join(directory1, 'plugin-x');
    let plugin2 = join(directory2, 'plugin-y');
    await mkdir(plugin1);
    await mkdir(plugin2);
    await writeFile(join(plugin1, 'index.mjs'), 'export function setup() {}');
    await writeFile(join(plugin2, 'index.mjs'), 'export function setup() {}');

    let provider = new FilesystemPluginProvider([directory1, directory2]);
    let names    = await provider.discover();

    assert.equal(names.length, 2);
    assert.ok(names.includes('plugin-x'));
    assert.ok(names.includes('plugin-y'));
  });

  it('should load a discovered plugin', async () => {
    let pluginDirectory = join(tempDirectory, 'loadable');
    await mkdir(pluginDirectory);
    await writeFile(
      join(pluginDirectory, 'index.mjs'),
      'export function setup(context) { return () => {}; }',
    );

    let provider = new FilesystemPluginProvider([tempDirectory]);
    await provider.discover();

    let module = await provider.load('loadable');
    assert.equal(typeof module.setup, 'function');
  });

  it('should throw when loading a plugin not discovered', async () => {
    let provider = new FilesystemPluginProvider([tempDirectory]);
    await provider.discover();

    await assert.rejects(
      () => provider.load('missing'),
      { message: 'Plugin "missing" not found in FilesystemPluginProvider' },
    );
  });

  it('should have watch and unwatch stubs', () => {
    let provider = new FilesystemPluginProvider([]);
    // Should not throw
    provider.watch();
    provider.unwatch();
  });
});

// =============================================================================
// PluginRegistry
// =============================================================================

describe('PluginRegistry', () => {
  let registry;

  beforeEach(() => {
    registry = new PluginRegistry();
  });

  // ---- Tools ----

  describe('registerTool', () => {
    it('should register a valid tool class', () => {
      let TestTool = createTestToolClass();
      registry.registerTool('my-tool', TestTool);
      assert.equal(registry.getTool('my-tool'), TestTool);
    });

    it('should throw if name is empty', () => {
      let TestTool = createTestToolClass();
      assert.throws(
        () => registry.registerTool('', TestTool),
        { message: 'Tool name must be a non-empty string' },
      );
    });

    it('should throw if name is not a string', () => {
      let TestTool = createTestToolClass();
      assert.throws(
        () => registry.registerTool(123, TestTool),
        { message: 'Tool name must be a non-empty string' },
      );
    });

    it('should throw if class does not extend PluginInterface', () => {
      class NotATool {}
      assert.throws(
        () => registry.registerTool('bad-tool', NotATool),
        { message: 'Tool "bad-tool" must extend PluginInterface' },
      );
    });

    it('should override existing tool with warning', () => {
      let warnings = [];
      let original = console.warn;
      console.warn = (...args) => warnings.push(args.join(' '));

      try {
        let ToolA = createTestToolClass({ featureName: 'a' });
        let ToolB = createTestToolClass({ featureName: 'b' });

        registry.registerTool('shared-name', ToolA);
        registry.registerTool('shared-name', ToolB);

        assert.equal(registry.getTool('shared-name'), ToolB);
        assert.equal(warnings.length, 1);
        assert.ok(warnings[0].includes('shared-name'));
        assert.ok(warnings[0].includes('overridden'));
      } finally {
        console.warn = original;
      }
    });

    it('should return null for unregistered tool', () => {
      assert.equal(registry.getTool('nope'), null);
    });

    it('should return all registered tools via getTools', () => {
      let ToolA = createTestToolClass({ featureName: 'a' });
      let ToolB = createTestToolClass({ featureName: 'b' });

      registry.registerTool('tool-a', ToolA);
      registry.registerTool('tool-b', ToolB);

      let tools = registry.getTools();
      assert.ok(tools instanceof Map);
      assert.equal(tools.size, 2);
      assert.equal(tools.get('tool-a'), ToolA);
      assert.equal(tools.get('tool-b'), ToolB);
    });

    it('should return a copy from getTools (not the internal map)', () => {
      let TestTool = createTestToolClass();
      registry.registerTool('t1', TestTool);

      let tools = registry.getTools();
      tools.delete('t1');

      // Internal map should still have it
      assert.equal(registry.getTool('t1'), TestTool);
    });
  });

  // ---- Commands ----

  describe('registerCommand', () => {
    it('should register a command handler', () => {
      let handler = () => 'hello';
      registry.registerCommand('greet', handler);
      assert.equal(registry.getCommand('greet'), handler);
    });

    it('should throw if name is empty', () => {
      assert.throws(
        () => registry.registerCommand('', () => {}),
        { message: 'Command name must be a non-empty string' },
      );
    });

    it('should throw if handler is not a function', () => {
      assert.throws(
        () => registry.registerCommand('bad', 'not-a-function'),
        { message: 'Command "bad" handler must be a function' },
      );
    });

    it('should override existing command with warning', () => {
      let warnings = [];
      let original = console.warn;
      console.warn = (...args) => warnings.push(args.join(' '));

      try {
        registry.registerCommand('cmd', () => 'v1');
        registry.registerCommand('cmd', () => 'v2');

        assert.equal(warnings.length, 1);
        assert.ok(warnings[0].includes('cmd'));
      } finally {
        console.warn = original;
      }
    });

    it('should return null for unregistered command', () => {
      assert.equal(registry.getCommand('missing'), null);
    });

    it('should return all commands via getCommands', () => {
      let handlerA = () => 'a';
      let handlerB = () => 'b';

      registry.registerCommand('cmd-a', handlerA);
      registry.registerCommand('cmd-b', handlerB, { description: 'Command B' });

      let commands = registry.getCommands();
      assert.ok(commands instanceof Map);
      assert.equal(commands.size, 2);
      assert.equal(commands.get('cmd-a').handler, handlerA);
      assert.equal(commands.get('cmd-a').help, null);
      assert.equal(commands.get('cmd-b').handler, handlerB);
      assert.equal(commands.get('cmd-b').help.description, 'Command B');
    });

    it('should return command help via getCommandHelp', () => {
      let help = { description: 'Test command', usage: '/test' };
      registry.registerCommand('test-cmd', () => {}, help);

      assert.deepStrictEqual(registry.getCommandHelp('test-cmd'), help);
      assert.equal(registry.getCommandHelp('missing'), null);
    });
  });

  // ---- Agent Types ----

  describe('registerAgentType', () => {
    it('should register and retrieve an agent type class', () => {
      class TestAgent extends AgentInterface {
        static pluginId = 'test-agent';
      }

      registry.registerAgentType('test', TestAgent);
      assert.equal(registry.getAgentType('test'), TestAgent);
    });

    it('should warn on override (not throw)', () => {
      let warnings = [];
      let original = console.warn;
      console.warn = (...args) => warnings.push(args.join(' '));

      try {
        class AgentA extends AgentInterface {}
        class AgentB extends AgentInterface {}

        registry.registerAgentType('dup', AgentA);
        registry.registerAgentType('dup', AgentB);

        assert.equal(registry.getAgentType('dup'), AgentB);
        assert.equal(warnings.length, 1);
        assert.ok(warnings[0].includes('dup'));
        assert.ok(warnings[0].includes('overridden'));
      } finally {
        console.warn = original;
      }
    });

    it('should throw if id is not a non-empty string', () => {
      class TestAgent extends AgentInterface {}

      assert.throws(
        () => registry.registerAgentType('', TestAgent),
        { message: 'Agent type id must be a non-empty string' },
      );

      assert.throws(
        () => registry.registerAgentType(123, TestAgent),
        { message: 'Agent type id must be a non-empty string' },
      );
    });

    it('should throw if class does not extend PluginInterface', () => {
      class NotAnAgent {}

      assert.throws(
        () => registry.registerAgentType('bad', NotAnAgent),
        { message: 'Agent type "bad" must extend PluginInterface' },
      );
    });

    it('should return null for unknown id', () => {
      assert.equal(registry.getAgentType('unknown'), null);
    });

    it('should return a defensive copy from getAgentTypes()', () => {
      class TestAgent extends AgentInterface {}

      registry.registerAgentType('copy-test', TestAgent);
      let types = registry.getAgentTypes();
      types.delete('copy-test');

      // Internal map should still have it
      assert.equal(registry.getAgentType('copy-test'), TestAgent);
    });
  });

  // ---- Hooks ----

  describe('registerHook', () => {
    it('should register a hook handler', () => {
      let handler = () => {};
      registry.registerHook('prepareMessage', handler);
      let handlers = registry.getHookHandlers('prepareMessage');
      assert.equal(handlers.length, 1);
      assert.equal(handlers[0], handler);
    });

    it('should allow multiple handlers per hook', () => {
      let handlerA = () => 'a';
      let handlerB = () => 'b';
      registry.registerHook('prepareMessage', handlerA);
      registry.registerHook('prepareMessage', handlerB);
      let handlers = registry.getHookHandlers('prepareMessage');
      assert.equal(handlers.length, 2);
      assert.equal(handlers[0], handlerA);
      assert.equal(handlers[1], handlerB);
    });

    it('should throw if hook name is empty', () => {
      assert.throws(
        () => registry.registerHook('', () => {}),
        { message: 'Hook name must be a non-empty string' },
      );
    });

    it('should throw if hook name is not a string', () => {
      assert.throws(
        () => registry.registerHook(123, () => {}),
        { message: 'Hook name must be a non-empty string' },
      );
    });

    it('should throw if handler is not a function', () => {
      assert.throws(
        () => registry.registerHook('prepareMessage', 'not-a-function'),
        { message: 'Hook "prepareMessage" handler must be a function' },
      );
    });

    it('should return empty array for unregistered hook', () => {
      let handlers = registry.getHookHandlers('unknown');
      assert.deepEqual(handlers, []);
    });

    it('should return a defensive copy from getHooks()', () => {
      registry.registerHook('test-hook', () => {});
      let hooks = registry.getHooks();
      hooks.delete('test-hook');
      // Internal map should still have it
      assert.equal(registry.getHookHandlers('test-hook').length, 1);
    });

    it('should return all hooks via getHooks()', () => {
      registry.registerHook('hookA', () => {});
      registry.registerHook('hookB', () => {});
      let hooks = registry.getHooks();
      assert.ok(hooks instanceof Map);
      assert.equal(hooks.size, 2);
      assert.ok(hooks.has('hookA'));
      assert.ok(hooks.has('hookB'));
    });
  });

  // ---- Custom Elements ----

  describe('registerCustomElement', () => {
    it('should register a custom element tag name', () => {
      registry.registerCustomElement('kikx-hml-prompt');
      let elements = registry.getCustomElements();
      assert.ok(elements.has('kikx-hml-prompt'));
    });

    it('should return a Set of registered elements', () => {
      registry.registerCustomElement('kikx-card');
      registry.registerCustomElement('kikx-chart');
      let elements = registry.getCustomElements();
      assert.ok(elements instanceof Set);
      assert.equal(elements.size, 2);
    });

    it('should throw if tag name is empty', () => {
      assert.throws(
        () => registry.registerCustomElement(''),
        { message: 'Custom element tag name must be a non-empty string' },
      );
    });

    it('should not duplicate tags (Set behavior)', () => {
      registry.registerCustomElement('kikx-tag');
      registry.registerCustomElement('kikx-tag');
      let elements = registry.getCustomElements();
      assert.equal(elements.size, 1);
    });

    it('should return a copy from getCustomElements', () => {
      registry.registerCustomElement('kikx-test');
      let elements = registry.getCustomElements();
      elements.delete('kikx-test');

      // Internal set should still have it
      assert.ok(registry.getCustomElements().has('kikx-test'));
    });
  });
});

// =============================================================================
// PluginLoader
// =============================================================================

describe('PluginLoader', () => {
  let loader;

  beforeEach(() => {
    loader = new PluginLoader({ type: 'test-context' });
  });

  afterEach(async () => {
    // Unload all plugins to clean up
    let loaded = loader.getLoadedPlugins();
    for (let name of loaded)
      await loader.unloadPlugin(name);

    loader = null;
  });

  // ---- Construction ----

  it('should construct with context and options', () => {
    let context = { foo: 'bar' };
    let options = { debug: true };
    let instance = new PluginLoader(context, options);
    assert.ok(instance);
    assert.ok(instance.getRegistry() instanceof PluginRegistry);
  });

  it('should construct with no arguments', () => {
    let instance = new PluginLoader();
    assert.ok(instance);
    assert.ok(instance.getRegistry() instanceof PluginRegistry);
  });

  // ---- addProvider ----

  it('should add a valid provider', () => {
    let provider = new InMemoryPluginProvider({});
    // Should not throw
    loader.addProvider(provider);
  });

  it('should throw when adding a non-PluginProvider', () => {
    assert.throws(
      () => loader.addProvider({ discover: () => [], load: () => {} }),
      { message: 'Provider must be an instance of PluginProvider' },
    );
  });

  // ---- loadPlugin ----

  it('should load a plugin via setup()', async () => {
    let setupCalled = false;

    let module = {
      setup: (context) => {
        setupCalled = true;
        assert.ok(context.pluginName);
        assert.ok(context.registerTool);
        assert.ok(context.registerCommand);
        assert.ok(context.registerCustomElement);
        assert.ok(context.registerAgentType);
        assert.equal(context.PluginInterface, PluginInterface);
      },
    };

    await loader.loadPlugin('test-plugin', module);
    assert.ok(setupCalled);
    assert.ok(loader.isLoaded('test-plugin'));
  });

  it('should pass the core context through to plugin context', async () => {
    let receivedContext = null;
    let coreContext     = { type: 'core-context', value: 42 };

    let instance = new PluginLoader(coreContext);
    let module   = {
      setup: (context) => {
        receivedContext = context.context;
      },
    };

    await instance.loadPlugin('ctx-test', module);
    assert.equal(receivedContext, coreContext);
  });

  it('should store teardown closure from setup', async () => {
    let tornDown = false;

    let module = {
      setup: () => {
        return () => { tornDown = true; };
      },
    };

    await loader.loadPlugin('teardown-test', module);
    assert.ok(loader.isLoaded('teardown-test'));

    await loader.unloadPlugin('teardown-test');
    assert.ok(tornDown);
    assert.ok(!loader.isLoaded('teardown-test'));
  });

  it('should accept plugins that return nothing from setup', async () => {
    let module = { setup: () => {} };
    await loader.loadPlugin('no-teardown', module);
    assert.ok(loader.isLoaded('no-teardown'));

    // unload should succeed without error
    let result = await loader.unloadPlugin('no-teardown');
    assert.ok(result);
  });

  it('should throw if plugin module has no setup function', async () => {
    await assert.rejects(
      () => loader.loadPlugin('bad-plugin', {}),
      { message: 'Plugin "bad-plugin" must export a setup(context) function' },
    );
  });

  it('should throw if plugin name is empty', async () => {
    await assert.rejects(
      () => loader.loadPlugin('', { setup: () => {} }),
      { message: 'Plugin name must be a non-empty string' },
    );
  });

  it('should throw if setup returns a non-function truthy value', async () => {
    let module = { setup: () => 'not-a-function' };
    await assert.rejects(
      () => loader.loadPlugin('bad-setup', module),
      { message: 'Plugin "bad-setup" setup() must return a function or nothing' },
    );
  });

  it('should allow plugin to register tools via context', async () => {
    let TestTool = createTestToolClass();

    let module = {
      setup: (context) => {
        context.registerTool('my-tool', TestTool);
      },
    };

    await loader.loadPlugin('tool-plugin', module);

    let registry = loader.getRegistry();
    assert.equal(registry.getTool('my-tool'), TestTool);
  });

  it('should allow plugin to register commands via context', async () => {
    let handler = () => 'hello';

    let module = {
      setup: (context) => {
        context.registerCommand('greet', handler);
      },
    };

    await loader.loadPlugin('cmd-plugin', module);

    let registry = loader.getRegistry();
    assert.equal(registry.getCommand('greet'), handler);
  });

  it('should allow plugin to register custom elements via context', async () => {
    let module = {
      setup: (context) => {
        context.registerCustomElement('kikx-chart');
      },
    };

    await loader.loadPlugin('element-plugin', module);

    let registry = loader.getRegistry();
    assert.ok(registry.getCustomElements().has('kikx-chart'));
  });

  it('should allow plugin to register agent types via context', async () => {
    class TestAgent extends AgentInterface {
      static pluginId = 'test-agent';
    }

    let module = {
      setup: (context) => {
        context.registerAgentType('test', TestAgent);
      },
    };

    await loader.loadPlugin('agent-plugin', module);

    let registry = loader.getRegistry();
    assert.equal(registry.getAgentType('test'), TestAgent);
  });

  it('should set pluginName on context passed to setup', async () => {
    let receivedName = null;

    let module = {
      setup: (context) => {
        receivedName = context.pluginName;
      },
    };

    await loader.loadPlugin('named-plugin', module);
    assert.equal(receivedName, 'named-plugin');
  });

  // ---- unloadPlugin ----

  it('should return false when unloading a plugin that is not loaded', async () => {
    let result = await loader.unloadPlugin('nonexistent');
    assert.equal(result, false);
  });

  it('should call teardown and mark as unloaded', async () => {
    let tornDown = false;

    let module = {
      setup: () => () => { tornDown = true; },
    };

    await loader.loadPlugin('unload-test', module);
    assert.ok(loader.isLoaded('unload-test'));

    await loader.unloadPlugin('unload-test');
    assert.ok(tornDown);
    assert.ok(!loader.isLoaded('unload-test'));
  });

  it('should handle teardown errors gracefully', async () => {
    let errors  = [];
    let original = console.error;
    console.error = (...args) => errors.push(args.join(' '));

    try {
      let module = {
        setup: () => () => { throw new Error('teardown boom'); },
      };

      await loader.loadPlugin('error-teardown', module);
      await loader.unloadPlugin('error-teardown');

      assert.ok(!loader.isLoaded('error-teardown'));
      assert.ok(errors.some((message) => message.includes('teardown boom')));
    } finally {
      console.error = original;
    }
  });

  // ---- Override behavior ----

  it('should override a loaded plugin with warning', async () => {
    let warnings = [];
    let original = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));

    try {
      let firstTornDown = false;

      let moduleA = {
        setup: () => () => { firstTornDown = true; },
      };

      let moduleB = {
        setup: () => () => {},
      };

      await loader.loadPlugin('override-test', moduleA);
      await loader.loadPlugin('override-test', moduleB);

      assert.ok(firstTornDown, 'first plugin should be torn down');
      assert.ok(loader.isLoaded('override-test'));
      assert.ok(warnings.some((message) => message.includes('override-test')));
    } finally {
      console.warn = original;
    }
  });

  // ---- registerHook via context ----

  it('should allow plugin to register hooks via context', async () => {
    let handler = () => ({ action: 'pass' });

    let module = {
      setup: (context) => {
        context.registerHook('prepareMessage', handler);
      },
    };

    await loader.loadPlugin('hook-plugin', module);

    let registry = loader.getRegistry();
    let handlers = registry.getHookHandlers('prepareMessage');
    assert.equal(handlers.length, 1);
    assert.equal(handlers[0], handler);
  });

  it('should expose registerHook in plugin context', async () => {
    let receivedContext = null;

    let module = {
      setup: (context) => {
        receivedContext = context;
      },
    };

    await loader.loadPlugin('ctx-hook-test', module);
    assert.ok(typeof receivedContext.registerHook === 'function');
  });

  // ---- loadAll resilience ----

  it('should continue loading after one plugin fails', async () => {
    let errors  = [];
    let original = console.error;
    console.error = (...args) => errors.push(args.join(' '));

    try {
      let provider = new InMemoryPluginProvider({
        'good-plugin': { setup: () => {} },
        'bad-plugin': { setup: () => { throw new Error('setup boom'); } },
        'another-good': { setup: () => {} },
      });

      loader.addProvider(provider);
      let loaded = await loader.loadAll();

      // The good plugins should load
      assert.ok(loaded.includes('good-plugin'));
      assert.ok(loaded.includes('another-good'));
      assert.ok(!loaded.includes('bad-plugin'));

      assert.ok(loader.isLoaded('good-plugin'));
      assert.ok(loader.isLoaded('another-good'));
      assert.ok(!loader.isLoaded('bad-plugin'));
    } finally {
      console.error = original;
    }
  });

  it('should record failed plugins in getFailedPlugins()', async () => {
    let errors  = [];
    let original = console.error;
    console.error = (...args) => errors.push(args.join(' '));

    try {
      let provider = new InMemoryPluginProvider({
        'ok-plugin': { setup: () => {} },
        'fail-plugin': { setup: () => { throw new Error('kaboom'); } },
      });

      loader.addProvider(provider);
      await loader.loadAll();

      let failed = loader.getFailedPlugins();
      assert.ok(failed instanceof Map);
      assert.equal(failed.size, 1);
      assert.ok(failed.has('fail-plugin'));
      assert.equal(failed.get('fail-plugin').message, 'kaboom');
    } finally {
      console.error = original;
    }
  });

  it('should not include failed plugins in loaded set', async () => {
    let errors  = [];
    let original = console.error;
    console.error = (...args) => errors.push(args.join(' '));

    try {
      let provider = new InMemoryPluginProvider({
        'fail-plugin': { setup: () => { throw new Error('fail'); } },
      });

      loader.addProvider(provider);
      let loaded = await loader.loadAll();

      assert.deepEqual(loaded, []);
      assert.equal(loader.getLoadedPlugins().size, 0);
    } finally {
      console.error = original;
    }
  });

  it('should return empty map from getFailedPlugins when all succeed', async () => {
    let provider = new InMemoryPluginProvider({
      'plugin-a': { setup: () => {} },
    });

    loader.addProvider(provider);
    await loader.loadAll();

    let failed = loader.getFailedPlugins();
    assert.equal(failed.size, 0);
  });

  // ---- loadAll (original tests) ----

  it('should load all plugins from all providers', async () => {
    let setupOrder = [];

    let provider = new InMemoryPluginProvider({
      'plugin-a': {
        setup: () => { setupOrder.push('a'); },
      },
      'plugin-b': {
        setup: () => { setupOrder.push('b'); },
      },
    });

    loader.addProvider(provider);

    let loaded = await loader.loadAll();

    assert.equal(loaded.length, 2);
    assert.ok(loaded.includes('plugin-a'));
    assert.ok(loaded.includes('plugin-b'));
    assert.ok(loader.isLoaded('plugin-a'));
    assert.ok(loader.isLoaded('plugin-b'));
    assert.deepEqual(setupOrder, ['a', 'b']);
  });

  it('should load from multiple providers', async () => {
    let providerA = new InMemoryPluginProvider({
      'from-a': { setup: () => {} },
    });

    let providerB = new InMemoryPluginProvider({
      'from-b': { setup: () => {} },
    });

    loader.addProvider(providerA);
    loader.addProvider(providerB);

    let loaded = await loader.loadAll();

    assert.equal(loaded.length, 2);
    assert.ok(loader.isLoaded('from-a'));
    assert.ok(loader.isLoaded('from-b'));
  });

  it('should return empty array when no providers', async () => {
    let loaded = await loader.loadAll();
    assert.deepEqual(loaded, []);
  });

  it('should skip plugins in disabled set during loadAll', async () => {
    let disabledLoader = new PluginLoader(null, { disabled: new Set(['skip-me']) });
    let provider       = new InMemoryPluginProvider({
      'skip-me':  { setup: () => {} },
      'load-me':  { setup: () => {} },
    });

    disabledLoader.addProvider(provider);
    let loaded = await disabledLoader.loadAll();

    assert.deepEqual(loaded, ['load-me']);
    assert.ok(!disabledLoader.isLoaded('skip-me'));
    assert.ok(disabledLoader.isLoaded('load-me'));
  });

  it('should load all plugins when disabled set is empty', async () => {
    let disabledLoader = new PluginLoader(null, { disabled: new Set() });
    let provider       = new InMemoryPluginProvider({
      'alpha': { setup: () => {} },
      'beta':  { setup: () => {} },
    });

    disabledLoader.addProvider(provider);
    let loaded = await disabledLoader.loadAll();

    assert.equal(loaded.length, 2);
    assert.ok(disabledLoader.isLoaded('alpha'));
    assert.ok(disabledLoader.isLoaded('beta'));
  });

  // ---- getLoadedPlugins ----

  it('should return a Set of loaded plugin names', async () => {
    let module = { setup: () => {} };
    await loader.loadPlugin('p1', module);
    await loader.loadPlugin('p2', { setup: () => {} });

    let loaded = loader.getLoadedPlugins();
    assert.ok(loaded instanceof Set);
    assert.equal(loaded.size, 2);
    assert.ok(loaded.has('p1'));
    assert.ok(loaded.has('p2'));
  });

  it('should return a copy of the loaded set', async () => {
    await loader.loadPlugin('p1', { setup: () => {} });

    let loaded = loader.getLoadedPlugins();
    loaded.delete('p1');

    // Internal should still have it
    assert.ok(loader.isLoaded('p1'));
  });

  // ---- isLoaded ----

  it('should return false for a plugin not loaded', () => {
    assert.equal(loader.isLoaded('nope'), false);
  });

  // ---- FilesystemPluginProvider integration ----

  describe('filesystem integration', () => {
    let tempDirectory;

    beforeEach(async () => {
      tempDirectory = join(tmpdir(), `kikx-fs-plugin-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      await mkdir(tempDirectory, { recursive: true });
    });

    afterEach(async () => {
      try {
        await rm(tempDirectory, { recursive: true, force: true });
      } catch (_error) {
        // Ignore cleanup errors
      }
    });

    it('should load plugins from filesystem via loadAll', async () => {
      let pluginDirectory = join(tempDirectory, 'fs-plugin');
      await mkdir(pluginDirectory);
      await writeFile(
        join(pluginDirectory, 'index.mjs'),
        `
          export function setup(context) {
            context.registerCommand('fs-cmd', () => 'from-fs');
            return () => {};
          }
        `,
      );

      let provider = new FilesystemPluginProvider([tempDirectory]);
      loader.addProvider(provider);

      let loaded = await loader.loadAll();
      assert.deepEqual(loaded, ['fs-plugin']);
      assert.ok(loader.isLoaded('fs-plugin'));

      let registry = loader.getRegistry();
      let handler  = registry.getCommand('fs-cmd');
      assert.equal(typeof handler, 'function');
      assert.equal(handler(), 'from-fs');
    });
  });
});
