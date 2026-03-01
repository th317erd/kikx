'use strict';

// =============================================================================
// PluginProvider — Base Class
// =============================================================================
// Abstract base for plugin discovery and loading strategies.
// Subclasses: InMemoryPluginProvider, FilesystemPluginProvider.
// =============================================================================

export class PluginProvider {
  // Discover available plugin names. Returns array of strings.
  async discover() {
    throw new Error(`${this.constructor.name}.discover() not implemented`);
  }

  // Load a specific plugin module by name. Returns the module.
  async load(name) {
    throw new Error(`${this.constructor.name}.load() not implemented`);
  }

  // Hot-reload support — stubs for now.
  watch() {}
  unwatch() {}
}
