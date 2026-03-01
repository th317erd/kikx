'use strict';

// =============================================================================
// Plugin Loader — Main Entry Point
// =============================================================================
// Ties together providers, registry, and plugin lifecycle.
// Plugins export setup(context) which receives registerTool, registerCommand,
// PluginInterface, etc. setup() may return a teardown closure.
// =============================================================================

import { PluginInterface }          from './plugin-interface.mjs';
import { PluginRegistry }           from './registry.mjs';
import { PluginProvider }           from './providers/plugin-provider.mjs';
import { InMemoryPluginProvider }   from './providers/in-memory-provider.mjs';
import { FilesystemPluginProvider } from './providers/filesystem-provider.mjs';

export class PluginLoader {
  constructor(context, options) {
    this._context   = context || null;
    this._options   = options || {};
    this._providers = [];
    this._registry  = new PluginRegistry();
    this._teardowns = new Map(); // pluginName -> teardown closure
    this._loaded    = new Set(); // track loaded plugin names
  }

  // ---------------------------------------------------------------------------
  // Provider Management
  // ---------------------------------------------------------------------------

  addProvider(provider) {
    if (!(provider instanceof PluginProvider))
      throw new Error('Provider must be an instance of PluginProvider');

    this._providers.push(provider);
  }

  // ---------------------------------------------------------------------------
  // Loading
  // ---------------------------------------------------------------------------

  async loadAll() {
    let results = [];

    for (let provider of this._providers) {
      let names = await provider.discover();

      for (let name of names) {
        let module = await provider.load(name);
        await this.loadPlugin(name, module);
        results.push(name);
      }
    }

    return results;
  }

  async loadPlugin(name, module) {
    if (!name || typeof name !== 'string')
      throw new Error('Plugin name must be a non-empty string');

    if (!module || typeof module.setup !== 'function')
      throw new Error(`Plugin "${name}" must export a setup(context) function`);

    // If already loaded, unload first (implicit override)
    if (this._loaded.has(name)) {
      console.warn(`Plugin "${name}" is being overridden`);
      await this.unloadPlugin(name);
    }

    // Build the context object passed to setup()
    let pluginContext = this._buildPluginContext(name);

    // Call setup — may return a teardown closure
    let teardown = await module.setup(pluginContext);

    if (teardown != null && typeof teardown !== 'function')
      throw new Error(`Plugin "${name}" setup() must return a function or nothing`);

    if (typeof teardown === 'function')
      this._teardowns.set(name, teardown);

    this._loaded.add(name);
  }

  async unloadPlugin(name) {
    if (!this._loaded.has(name))
      return false;

    let teardown = this._teardowns.get(name);

    if (typeof teardown === 'function') {
      try {
        await teardown();
      } catch (error) {
        console.error(`Plugin "${name}" teardown error:`, error);
      }
    }

    this._teardowns.delete(name);
    this._loaded.delete(name);

    return true;
  }

  // ---------------------------------------------------------------------------
  // Context Builder
  // ---------------------------------------------------------------------------

  _buildPluginContext(pluginName) {
    let registry = this._registry;

    return {
      pluginName,
      context:              this._context,
      PluginInterface,
      registerTool:         (name, ToolClass) => registry.registerTool(name, ToolClass),
      registerCommand:      (name, handler)   => registry.registerCommand(name, handler),
      registerCustomElement: (tagName)         => registry.registerCustomElement(tagName),
    };
  }

  // ---------------------------------------------------------------------------
  // Accessors
  // ---------------------------------------------------------------------------

  getRegistry() {
    return this._registry;
  }

  getLoadedPlugins() {
    return new Set(this._loaded);
  }

  isLoaded(name) {
    return this._loaded.has(name);
  }
}

// =============================================================================
// Re-exports
// =============================================================================

export { PluginInterface }          from './plugin-interface.mjs';
export { PluginRegistry }           from './registry.mjs';
export { PluginProvider }           from './providers/plugin-provider.mjs';
export { InMemoryPluginProvider }   from './providers/in-memory-provider.mjs';
export { FilesystemPluginProvider } from './providers/filesystem-provider.mjs';
