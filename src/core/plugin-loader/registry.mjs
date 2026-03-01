'use strict';

// =============================================================================
// Plugin Registry
// =============================================================================
// In-memory registries for tools, commands, and custom elements.
// Conflict policy: implicit override with console warning (not error).
// =============================================================================

import { PluginInterface } from './plugin-interface.mjs';

export class PluginRegistry {
  constructor() {
    this._tools          = new Map();
    this._commands       = new Map();
    this._customElements = new Set();
  }

  // ---------------------------------------------------------------------------
  // Tools
  // ---------------------------------------------------------------------------

  registerTool(name, ToolClass) {
    if (!name || typeof name !== 'string')
      throw new Error('Tool name must be a non-empty string');

    if (!ToolClass || !(ToolClass.prototype instanceof PluginInterface))
      throw new Error(`Tool "${name}" must extend PluginInterface`);

    if (this._tools.has(name))
      console.warn(`Tool "${name}" is being overridden`);

    this._tools.set(name, ToolClass);
  }

  getTool(name) {
    return this._tools.get(name) || null;
  }

  getTools() {
    return new Map(this._tools);
  }

  // ---------------------------------------------------------------------------
  // Commands
  // ---------------------------------------------------------------------------

  registerCommand(name, handler) {
    if (!name || typeof name !== 'string')
      throw new Error('Command name must be a non-empty string');

    if (typeof handler !== 'function')
      throw new Error(`Command "${name}" handler must be a function`);

    if (this._commands.has(name))
      console.warn(`Command "${name}" is being overridden`);

    this._commands.set(name, handler);
  }

  getCommand(name) {
    return this._commands.get(name) || null;
  }

  getCommands() {
    return new Map(this._commands);
  }

  // ---------------------------------------------------------------------------
  // Custom Elements
  // ---------------------------------------------------------------------------

  registerCustomElement(tagName) {
    if (!tagName || typeof tagName !== 'string')
      throw new Error('Custom element tag name must be a non-empty string');

    this._customElements.add(tagName);
  }

  getCustomElements() {
    return new Set(this._customElements);
  }
}
