'use strict';

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { PluginLoader }       from '../../src/core/plugin-loader/index.mjs';
import { PluginInterface }    from '../../src/core/plugin-loader/plugin-interface.mjs';
import { PluginRegistry }     from '../../src/core/plugin-loader/registry.mjs';
import { InMemoryPluginProvider } from '../../src/core/plugin-loader/providers/in-memory-provider.mjs';
import { ClassRegistry }      from '../../src/core/class-registry.mjs';

// =============================================================================
// PluginLoader — provide() Pattern Tests
// =============================================================================

describe('PluginLoader provide() pattern', () => {
  let loader;
  let mockContext;

  beforeEach(() => {
    mockContext = {
      type: 'test-context',
      getProperty: () => null,
    };

    loader = new PluginLoader(mockContext);
  });

  // ---------------------------------------------------------------------------
  // Happy paths
  // ---------------------------------------------------------------------------

  it('setup(provide) signature works', async () => {
    let provideCalled = false;

    let module = {
      setup: (provide) => {
        assert.equal(typeof provide, 'function', 'provide should be a function');
        provideCalled = true;
      },
    };

    await loader.loadPlugin('test', module);
    assert.ok(provideCalled);
    assert.ok(loader.isLoaded('test'));
  });

  it('provide callback receives { registry, context }', async () => {
    let receivedRegistry = null;
    let receivedContext = null;

    let module = {
      setup: (provide) => {
        provide(({ registry, context }) => {
          receivedRegistry = registry;
          receivedContext = context;
        });
      },
    };

    await loader.loadPlugin('test', module);

    assert.ok(receivedRegistry, 'registry should be provided');
    assert.ok(receivedRegistry instanceof PluginRegistry, 'registry should be a PluginRegistry');
    assert.equal(receivedContext, mockContext, 'context should be the core context');
  });

  it('registry has registerClass and getClass (ClassRegistry methods)', async () => {
    let receivedRegistry = null;

    let module = {
      setup: (provide) => {
        provide(({ registry }) => {
          receivedRegistry = registry;
        });
      },
    };

    await loader.loadPlugin('test', module);

    assert.equal(typeof receivedRegistry.registerClass, 'function');
    assert.equal(typeof receivedRegistry.getClass, 'function');
    assert.equal(typeof receivedRegistry.hasClass, 'function');
  });

  it('registry has registerTool and getTool (backward compat)', async () => {
    let receivedRegistry = null;

    let module = {
      setup: (provide) => {
        provide(({ registry }) => {
          receivedRegistry = registry;
        });
      },
    };

    await loader.loadPlugin('test', module);

    assert.equal(typeof receivedRegistry.registerTool, 'function');
    assert.equal(typeof receivedRegistry.getTool, 'function');
    assert.equal(typeof receivedRegistry.registerCommand, 'function');
    assert.equal(typeof receivedRegistry.getCommand, 'function');
  });

  it('PluginRegistry extends ClassRegistry', () => {
    let registry = new PluginRegistry();
    assert.ok(registry instanceof ClassRegistry, 'PluginRegistry should extend ClassRegistry');
  });

  it('plugin registers a tool via new pattern', async () => {
    // Pre-register PluginInterface so tools can extend it
    let registry = loader.getRegistry();
    registry.registerClass(PluginInterface, { pluginName: 'core' });

    class MyTool extends PluginInterface {
      static pluginID = 'test';
      static featureName = 'myTool';
      async _execute() { return 'ok'; }
    }

    let module = {
      setup: (provide) => {
        provide(({ registry }) => {
          registry.registerTool('test:myTool', MyTool);
        });
      },
    };

    await loader.loadPlugin('my-plugin', module);

    assert.equal(registry.getTool('test:myTool'), MyTool);
  });

  it('plugin registers a class', async () => {
    class MyService {
      static serviceName = 'custom';
    }

    let module = {
      setup: (provide) => {
        provide(({ registry }) => {
          registry.registerClass(MyService);
        });
      },
    };

    await loader.loadPlugin('svc-plugin', module);

    let registry = loader.getRegistry();
    assert.equal(registry.getClass('MyService'), MyService);
  });

  it('multiple plugins load in order', async () => {
    let loadOrder = [];

    let pluginA = {
      setup: (provide) => {
        provide(({ registry }) => {
          loadOrder.push('A');
          registry.registerClass(class ClassA {});
        });
      },
    };

    let pluginB = {
      setup: (provide) => {
        provide(({ registry }) => {
          loadOrder.push('B');
          registry.registerClass(class ClassB {});
        });
      },
    };

    await loader.loadPlugin('plugin-a', pluginA);
    await loader.loadPlugin('plugin-b', pluginB);

    assert.deepEqual(loadOrder, ['A', 'B']);

    let registry = loader.getRegistry();
    assert.ok(registry.hasClass('ClassA'));
    assert.ok(registry.hasClass('ClassB'));
  });

  it('plugin can extend a class from registry', async () => {
    let registry = loader.getRegistry();
    registry.registerClass(PluginInterface, { pluginName: 'core' });

    let module = {
      setup: (provide) => {
        provide(({ registry }) => {
          let Base = registry.getClass('PluginInterface');

          class ExtendedTool extends Base {
            static pluginID = 'ext';
            static featureName = 'tool';
            async _execute() { return 'extended'; }
          }

          registry.registerTool('ext:tool', ExtendedTool);
        });
      },
    };

    await loader.loadPlugin('ext-plugin', module);

    let ToolClass = registry.getTool('ext:tool');
    assert.ok(ToolClass);
    assert.ok(ToolClass.prototype instanceof PluginInterface);
  });

  it('provide callbacks stored for future hot-reload', async () => {
    let module = {
      setup: (provide) => {
        provide(({ registry }) => {
          registry.registerClass(class Reloadable {});
        });
      },
    };

    await loader.loadPlugin('reload-test', module);

    let callbacks = loader.getProvideCallbacks();
    assert.equal(callbacks.size, 1);
    assert.ok(callbacks.has('reload-test'));
    assert.equal(typeof callbacks.get('reload-test'), 'function');
  });

  it('loadAll works with provide pattern via InMemoryPluginProvider', async () => {
    let registry = loader.getRegistry();
    registry.registerClass(PluginInterface, { pluginName: 'core' });

    class ToolA extends PluginInterface {
      static pluginID = 'a';
      static featureName = 'tool';
      async _execute() { return 'a'; }
    }

    let modules = {
      'plugin-a': {
        setup: (provide) => {
          provide(({ registry }) => {
            registry.registerTool('a:tool', ToolA);
          });
        },
      },
    };

    let provider = new InMemoryPluginProvider(modules);
    loader.addProvider(provider);

    let loaded = await loader.loadAll();
    assert.deepEqual(loaded, ['plugin-a']);
    assert.equal(registry.getTool('a:tool'), ToolA);
  });

  // ---------------------------------------------------------------------------
  // Sad paths
  // ---------------------------------------------------------------------------

  it('setup() without calling provide registers nothing and does not error', async () => {
    let module = {
      setup: (provide) => {
        // Intentionally do not call provide
      },
    };

    await loader.loadPlugin('empty-plugin', module);
    assert.ok(loader.isLoaded('empty-plugin'));

    let callbacks = loader.getProvideCallbacks();
    assert.equal(callbacks.size, 0, 'No provide callbacks should be stored');
  });

  it('provide callback throws — error logged, plugin marked as failed', async () => {
    let errors = [];
    let originalError = console.error;
    console.error = (...args) => errors.push(args.join(' '));

    let module = {
      setup: (provide) => {
        provide(() => {
          throw new Error('provide boom');
        });
      },
    };

    await loader.loadPlugin('fail-plugin', module);

    console.error = originalError;

    assert.ok(!loader.isLoaded('fail-plugin'), 'Plugin should not be marked as loaded');
    assert.ok(loader.getFailedPlugins().has('fail-plugin'), 'Plugin should be marked as failed');
    assert.ok(errors.some(e => e.includes('provide boom')), 'Error should be logged');
  });

  it('provide with non-function argument throws', async () => {
    let module = {
      setup: (provide) => {
        provide('not a function');
      },
    };

    await assert.rejects(
      () => loader.loadPlugin('bad-provide', module),
      { message: /provide\(\) argument must be a function/ },
    );
  });

  it('unloadPlugin removes provide callback', async () => {
    let module = {
      setup: (provide) => {
        provide(({ registry }) => {
          registry.registerClass(class Temp {});
        });
        return () => {};
      },
    };

    await loader.loadPlugin('temp-plugin', module);
    assert.equal(loader.getProvideCallbacks().size, 1);

    await loader.unloadPlugin('temp-plugin');
    assert.equal(loader.getProvideCallbacks().size, 0);
  });

  it('setup returning a teardown still works with provide pattern', async () => {
    let tornDown = false;

    let module = {
      setup: (provide) => {
        provide(({ registry }) => {
          registry.registerClass(class WithTeardown {});
        });
        return () => { tornDown = true; };
      },
    };

    await loader.loadPlugin('td-plugin', module);
    assert.ok(loader.isLoaded('td-plugin'));

    await loader.unloadPlugin('td-plugin');
    assert.ok(tornDown, 'Teardown should have been called');
  });
});
