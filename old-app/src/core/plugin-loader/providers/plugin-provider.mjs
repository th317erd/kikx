'use strict';

// =============================================================================
// PluginProvider — Base Class
// =============================================================================
// Abstract base for plugin discovery and loading strategies.
// Subclasses: InMemoryPluginProvider, FilesystemPluginProvider.
// =============================================================================

export class PluginProvider {
  /**
   * Discover available plugin names.
   * @returns {Promise<string[]>}
   */
  async discover() {
    throw new Error(`${this.constructor.name}.discover() not implemented`);
  }

  /**
   * Load a specific plugin module by name.
   * @param {string} name
   * @returns {Promise<{ setup: Function }>}
   */
  async load(name) {
    throw new Error(`${this.constructor.name}.load() not implemented`);
  }

  /**
   * Hot-reload support — stub for now.
   * @returns {void}
   */
  watch() {}

  /**
   * Hot-reload support — stub for now.
   * @returns {void}
   */
  unwatch() {}
}
