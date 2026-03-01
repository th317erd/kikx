'use strict';

// =============================================================================
// InMemoryPluginProvider
// =============================================================================
// Loads plugins from an in-memory map. Useful for testing and embedded use.
// Constructor takes a Map (or plain object) of pluginName -> pluginModule.
// =============================================================================

import { PluginProvider } from './plugin-provider.mjs';

export class InMemoryPluginProvider extends PluginProvider {
  constructor(plugins) {
    super();

    // Accept Map or plain object
    if (plugins instanceof Map)
      this._plugins = new Map(plugins);
    else if (plugins && typeof plugins === 'object')
      this._plugins = new Map(Object.entries(plugins));
    else
      this._plugins = new Map();
  }

  async discover() {
    return Array.from(this._plugins.keys());
  }

  async load(name) {
    let module = this._plugins.get(name);

    if (!module)
      throw new Error(`Plugin "${name}" not found in InMemoryPluginProvider`);

    return module;
  }
}
