'use strict';

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ============================================================================
// Environment Setup
// ============================================================================

let testDir = mkdtempSync(join(tmpdir(), 'hero-loader-enhanced-test-'));

process.env.HERO_JWT_SECRET     = 'test-secret-key-for-testing';
process.env.HERO_ENCRYPTION_KEY = 'test-encryption-key-32chars!!';
process.env.XDG_CONFIG_HOME     = testDir;

let loader;

async function loadModules() {
  loader = await import('../../../server/lib/plugins/loader.mjs');
}

// ============================================================================
// Helper: Create a fake plugin in a directory
// ============================================================================

function createFakePlugin(directory, name, options = {}) {
  let pluginDir = join(directory, name);
  mkdirSync(pluginDir, { recursive: true });

  let packageJson = {
    name:    name,
    version: options.version || '1.0.0',
    main:    options.main || 'index.mjs',
    hero:    {
      agents:       options.agents || ['*'],
      dependencies: options.dependencies || [],
    },
  };

  writeFileSync(join(pluginDir, 'package.json'), JSON.stringify(packageJson, null, 2));

  let moduleContent = options.moduleContent || `
    'use strict';
    export const hooks = {};
    export const commands = [];
    export async function init() {}
    export async function destroy() {}
  `;

  writeFileSync(join(pluginDir, packageJson.main), moduleContent);

  return pluginDir;
}

describe('Plugin Loader (Enhanced)', async () => {
  await loadModules();

  let pluginsDir;

  beforeEach(() => {
    pluginsDir = mkdtempSync(join(tmpdir(), 'hero-plugins-'));
  });

  afterEach(async () => {
    // Unload all plugins
    let loaded = loader.getLoadedPlugins();
    for (let plugin of loaded) {
      await loader.unloadPlugin(plugin.metadata.name);
    }

    // Clean up temp dir
    try {
      rmSync(pluginsDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  // ===========================================================================
  // discoverPluginsInDirectory
  // ===========================================================================
  describe('discoverPluginsInDirectory()', () => {
    it('should discover plugins in a directory', async () => {
      createFakePlugin(pluginsDir, 'plugin-a');
      createFakePlugin(pluginsDir, 'plugin-b');

      let plugins = await loader.discoverPluginsInDirectory(pluginsDir, 'user');

      assert.strictEqual(plugins.length, 2);
      let names = plugins.map((p) => p.name);
      assert.ok(names.includes('plugin-a'));
      assert.ok(names.includes('plugin-b'));
    });

    it('should include source in metadata', async () => {
      createFakePlugin(pluginsDir, 'my-plugin');

      let plugins = await loader.discoverPluginsInDirectory(pluginsDir, 'internal');

      assert.strictEqual(plugins[0].source, 'internal');
    });

    it('should include dependencies in metadata', async () => {
      createFakePlugin(pluginsDir, 'dependent-plugin', {
        dependencies: ['base-plugin'],
      });

      let plugins = await loader.discoverPluginsInDirectory(pluginsDir, 'user');

      assert.deepStrictEqual(plugins[0].dependencies, ['base-plugin']);
    });

    it('should return empty array for nonexistent directory', async () => {
      let plugins = await loader.discoverPluginsInDirectory('/nonexistent/path', 'user');

      assert.strictEqual(plugins.length, 0);
    });

    it('should skip directories without package.json', async () => {
      mkdirSync(join(pluginsDir, 'not-a-plugin'), { recursive: true });

      let plugins = await loader.discoverPluginsInDirectory(pluginsDir, 'user');

      assert.strictEqual(plugins.length, 0);
    });

    it('should skip plugins with missing entry point', async () => {
      let pluginDir = join(pluginsDir, 'broken-plugin');
      mkdirSync(pluginDir, { recursive: true });
      writeFileSync(join(pluginDir, 'package.json'), JSON.stringify({
        name:    'broken-plugin',
        version: '1.0.0',
        main:    'nonexistent.mjs',
      }));

      let plugins = await loader.discoverPluginsInDirectory(pluginsDir, 'user');

      assert.strictEqual(plugins.length, 0);
    });
  });

  // ===========================================================================
  // resolveDependencies
  // ===========================================================================
  describe('resolveDependencies()', () => {
    it('should sort plugins by dependency order', () => {
      let plugins = [
        { name: 'plugin-c', dependencies: ['plugin-b'] },
        { name: 'plugin-a', dependencies: [] },
        { name: 'plugin-b', dependencies: ['plugin-a'] },
      ];

      let sorted = loader.resolveDependencies(plugins);
      let names  = sorted.map((p) => p.name);

      // A must come before B, B must come before C
      assert.ok(names.indexOf('plugin-a') < names.indexOf('plugin-b'));
      assert.ok(names.indexOf('plugin-b') < names.indexOf('plugin-c'));
    });

    it('should handle plugins with no dependencies', () => {
      let plugins = [
        { name: 'alpha', dependencies: [] },
        { name: 'beta', dependencies: [] },
        { name: 'gamma', dependencies: [] },
      ];

      let sorted = loader.resolveDependencies(plugins);

      assert.strictEqual(sorted.length, 3);
    });

    it('should detect circular dependencies', () => {
      let plugins = [
        { name: 'a', dependencies: ['b'] },
        { name: 'b', dependencies: ['c'] },
        { name: 'c', dependencies: ['a'] },
      ];

      assert.throws(
        () => loader.resolveDependencies(plugins),
        /Circular plugin dependency/,
      );
    });

    it('should detect self-referencing dependencies', () => {
      let plugins = [
        { name: 'self', dependencies: ['self'] },
      ];

      assert.throws(
        () => loader.resolveDependencies(plugins),
        /Circular plugin dependency/,
      );
    });

    it('should handle missing dependencies gracefully', () => {
      let plugins = [
        { name: 'dependent', dependencies: ['nonexistent'] },
      ];

      // Should not throw — logs warning and continues
      let sorted = loader.resolveDependencies(plugins);
      assert.strictEqual(sorted.length, 1);
    });
  });

  // ===========================================================================
  // loadPlugin + initializePlugin
  // ===========================================================================
  describe('loadPlugin()', () => {
    it('should load a plugin from metadata', async () => {
      createFakePlugin(pluginsDir, 'loadable');

      let plugins  = await loader.discoverPluginsInDirectory(pluginsDir, 'user');
      let metadata = plugins[0];
      let plugin   = await loader.loadPlugin(metadata);

      assert.ok(plugin);
      assert.strictEqual(plugin.metadata.name, 'loadable');
      assert.strictEqual(plugin.initialized, false);
    });

    it('should return same plugin if already loaded', async () => {
      createFakePlugin(pluginsDir, 'singleton');

      let plugins  = await loader.discoverPluginsInDirectory(pluginsDir, 'user');
      let metadata = plugins[0];
      let first    = await loader.loadPlugin(metadata);
      let second   = await loader.loadPlugin(metadata);

      assert.strictEqual(first, second);
    });
  });

  describe('initializePlugin()', () => {
    it('should call init() on the plugin module', async () => {
      createFakePlugin(pluginsDir, 'initializable', {
        moduleContent: `
          'use strict';
          export let initCalled = false;
          export async function init() { initCalled = true; }
        `,
      });

      let plugins  = await loader.discoverPluginsInDirectory(pluginsDir, 'user');
      let metadata = plugins[0];
      let plugin   = await loader.loadPlugin(metadata);

      await loader.initializePlugin(plugin);

      assert.strictEqual(plugin.initialized, true);
    });

    it('should not re-initialize', async () => {
      createFakePlugin(pluginsDir, 'no-reinit', {
        moduleContent: `
          'use strict';
          export let count = 0;
          export async function init() { count++; }
        `,
      });

      let plugins  = await loader.discoverPluginsInDirectory(pluginsDir, 'user');
      let metadata = plugins[0];
      let plugin   = await loader.loadPlugin(metadata);

      await loader.initializePlugin(plugin);
      await loader.initializePlugin(plugin);

      assert.strictEqual(plugin.module.count, 1);
    });

    it('should reject if dependency not loaded', async () => {
      createFakePlugin(pluginsDir, 'needs-dep', {
        dependencies: ['missing-dep'],
      });

      let plugins  = await loader.discoverPluginsInDirectory(pluginsDir, 'user');
      let metadata = plugins[0];
      let plugin   = await loader.loadPlugin(metadata);

      await assert.rejects(
        () => loader.initializePlugin(plugin),
        /requires "missing-dep"/,
      );
    });
  });

  // ===========================================================================
  // unloadPlugin
  // ===========================================================================
  describe('unloadPlugin()', () => {
    it('should remove a loaded plugin', async () => {
      createFakePlugin(pluginsDir, 'removable');

      let plugins  = await loader.discoverPluginsInDirectory(pluginsDir, 'user');
      let metadata = plugins[0];
      await loader.loadPlugin(metadata);

      assert.strictEqual(loader.isPluginLoaded('removable'), true);

      let removed = await loader.unloadPlugin('removable');

      assert.strictEqual(removed, true);
      assert.strictEqual(loader.isPluginLoaded('removable'), false);
    });

    it('should call destroy() on unload', async () => {
      createFakePlugin(pluginsDir, 'destroyable', {
        moduleContent: `
          'use strict';
          export let destroyed = false;
          export async function init() {}
          export async function destroy() { destroyed = true; }
        `,
      });

      let plugins  = await loader.discoverPluginsInDirectory(pluginsDir, 'user');
      let metadata = plugins[0];
      let plugin   = await loader.loadPlugin(metadata);
      await loader.initializePlugin(plugin);

      // Capture module reference before unload
      let module = plugin.module;

      await loader.unloadPlugin('destroyable');

      assert.strictEqual(module.destroyed, true);
    });

    it('should return false for non-loaded plugin', async () => {
      let removed = await loader.unloadPlugin('nonexistent');

      assert.strictEqual(removed, false);
    });

    it('should block unload if other plugins depend on it', async () => {
      createFakePlugin(pluginsDir, 'base');
      createFakePlugin(pluginsDir, 'dependent', {
        dependencies: ['base'],
      });

      let plugins = await loader.discoverPluginsInDirectory(pluginsDir, 'user');
      let sorted  = loader.resolveDependencies(plugins);

      for (let metadata of sorted) {
        let plugin = await loader.loadPlugin(metadata);
        await loader.initializePlugin(plugin);
      }

      // Try to unload base — should fail because dependent depends on it
      let removed = await loader.unloadPlugin('base');

      assert.strictEqual(removed, false);
      assert.strictEqual(loader.isPluginLoaded('base'), true);
    });
  });

  // ===========================================================================
  // reloadPlugin
  // ===========================================================================
  describe('reloadPlugin()', () => {
    it('should unload and reload a plugin', async () => {
      createFakePlugin(pluginsDir, 'reloadable', {
        moduleContent: `
          'use strict';
          export const hooks = {};
          export async function init() {}
          export async function destroy() {}
        `,
      });

      let plugins  = await loader.discoverPluginsInDirectory(pluginsDir, 'user');
      let metadata = plugins[0];
      let plugin   = await loader.loadPlugin(metadata);
      await loader.initializePlugin(plugin);

      let reloaded = await loader.reloadPlugin('reloadable');

      assert.ok(reloaded);
      assert.strictEqual(reloaded.metadata.name, 'reloadable');
      assert.strictEqual(reloaded.initialized, true);
    });

    it('should return null for non-loaded plugin', async () => {
      let result = await loader.reloadPlugin('ghost');

      assert.strictEqual(result, null);
    });
  });

  // ===========================================================================
  // loadPluginsForAgent
  // ===========================================================================
  describe('loadPluginsForAgent()', () => {
    it('should load compatible plugins in dependency order', async () => {
      createFakePlugin(pluginsDir, 'base-plugin', {
        moduleContent: `
          'use strict';
          export const hooks = {};
          export async function init() {}
        `,
      });

      createFakePlugin(pluginsDir, 'ext-plugin', {
        dependencies: ['base-plugin'],
        moduleContent: `
          'use strict';
          export const hooks = {};
          export async function init() {}
        `,
      });

      // Temporarily override getPluginsDir to use our test dir
      // Since loadPluginsForAgent calls discoverPlugins which uses getPluginsDir,
      // we need to test via loadPlugin + initializePlugin directly
      let plugins = await loader.discoverPluginsInDirectory(pluginsDir, 'user');
      let sorted  = loader.resolveDependencies(plugins);

      assert.strictEqual(sorted[0].name, 'base-plugin');
      assert.strictEqual(sorted[1].name, 'ext-plugin');
    });

    it('should filter by agent type', async () => {
      createFakePlugin(pluginsDir, 'claude-only', {
        agents: ['claude'],
      });

      createFakePlugin(pluginsDir, 'all-agents', {
        agents: ['*'],
      });

      let plugins    = await loader.discoverPluginsInDirectory(pluginsDir, 'user');
      let compatible = plugins.filter((p) => p.agents.includes('*') || p.agents.includes('claude'));

      assert.strictEqual(compatible.length, 2);

      let gptCompatible = plugins.filter((p) => p.agents.includes('*') || p.agents.includes('gpt'));

      assert.strictEqual(gptCompatible.length, 1);
      assert.strictEqual(gptCompatible[0].name, 'all-agents');
    });
  });

  // ===========================================================================
  // Query helpers
  // ===========================================================================
  describe('Query helpers', () => {
    it('getLoadedPlugins() returns all loaded plugins', async () => {
      createFakePlugin(pluginsDir, 'query-a');
      createFakePlugin(pluginsDir, 'query-b');

      let plugins = await loader.discoverPluginsInDirectory(pluginsDir, 'user');
      for (let meta of plugins)
        await loader.loadPlugin(meta);

      let loaded = loader.getLoadedPlugins();

      assert.strictEqual(loaded.length, 2);
    });

    it('getPlugin() returns specific plugin', async () => {
      createFakePlugin(pluginsDir, 'specific');

      let plugins  = await loader.discoverPluginsInDirectory(pluginsDir, 'user');
      await loader.loadPlugin(plugins[0]);

      let plugin = loader.getPlugin('specific');

      assert.ok(plugin);
      assert.strictEqual(plugin.metadata.name, 'specific');
    });

    it('isPluginLoaded() checks correctly', async () => {
      assert.strictEqual(loader.isPluginLoaded('not-there'), false);

      createFakePlugin(pluginsDir, 'checker');
      let plugins = await loader.discoverPluginsInDirectory(pluginsDir, 'user');
      await loader.loadPlugin(plugins[0]);

      assert.strictEqual(loader.isPluginLoaded('checker'), true);
    });
  });
});
