'use strict';

// =============================================================================
// Plugin Loader — Main Entry Point
// =============================================================================
// Ties together providers, registry, and plugin lifecycle.
// Plugins export setup(provide) which receives a provide() function.
// The provide callback receives { registry, context } and registers classes
// and domain-specific tools/commands/selectors via the unified PluginRegistry.
// setup() may return a teardown closure.
// =============================================================================

import { PluginInterface }          from './plugin-interface.mjs';
import { AgentInterface }           from '../plugins/agent-interface.mjs';
import { PluginRegistry }           from './registry.mjs';
import { PluginProvider }           from './providers/plugin-provider.mjs';
import { InMemoryPluginProvider }   from './providers/in-memory-provider.mjs';
import { FilesystemPluginProvider } from './providers/filesystem-provider.mjs';

export class PluginLoader {
  constructor(context, options) {
    this._context    = context || null;
    this._options    = options || {};
    this._providers  = [];
    this._registry   = new PluginRegistry();
    this._teardowns  = new Map(); // pluginName -> teardown closure
    this._loaded     = new Set(); // track loaded plugin names
    this._failed     = new Map(); // pluginName -> error
    this._provideCallbacks = new Map(); // pluginName -> callback (for future hot-reload)
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
        if (this._options.disabled && this._options.disabled.has(name))
          continue;

        try {
          let module = await provider.load(name);
          await this.loadPlugin(name, module);
          results.push(name);
        } catch (error) {
          console.error(`Failed to load plugin "${name}":`, error.message);
          this._failed.set(name, error);
        }
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

    // Build the provide function for setup(provide) pattern
    let provideCallback = null;
    let registry = this._registry;
    let context  = this._context;

    let provide = (callback) => {
      if (typeof callback !== 'function')
        throw new Error(`Plugin "${name}" provide() argument must be a function`);

      provideCallback = callback;
    };

    // Call setup — may return a teardown closure
    let teardown = await module.setup(provide);

    // If a provide callback was registered, invoke it immediately
    if (provideCallback) {
      try {
        await provideCallback({ registry, context });
      } catch (error) {
        console.error(`Plugin "${name}" provide callback error:`, error.message);
        this._failed.set(name, error);
        return;
      }

      // Store for future hot-reload
      this._provideCallbacks.set(name, provideCallback);
    }

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
    this._provideCallbacks.delete(name);
    this._loaded.delete(name);

    return true;
  }

  // ---------------------------------------------------------------------------
  // Provide Callbacks (for future hot-reload)
  // ---------------------------------------------------------------------------

  getProvideCallbacks() {
    return new Map(this._provideCallbacks);
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

  getFailedPlugins() {
    return new Map(this._failed);
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
export { BasePluginClass }         from '../routing/base-plugin-class.mjs';
