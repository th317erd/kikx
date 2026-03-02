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
    this._agentTypes     = new Map();
    this._hooks          = new Map(); // hookName -> handler[]
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
  // Agent Types
  // ---------------------------------------------------------------------------

  registerAgentType(id, AgentClass) {
    if (!id || typeof id !== 'string')
      throw new Error('Agent type id must be a non-empty string');

    if (!AgentClass || !(AgentClass.prototype instanceof PluginInterface))
      throw new Error(`Agent type "${id}" must extend PluginInterface`);

    if (this._agentTypes.has(id))
      console.warn(`Agent type "${id}" is being overridden`);

    this._agentTypes.set(id, AgentClass);
  }

  getAgentType(id) {
    return this._agentTypes.get(id) || null;
  }

  getAgentTypes() {
    return new Map(this._agentTypes);
  }

  // ---------------------------------------------------------------------------
  // Hooks
  // ---------------------------------------------------------------------------

  registerHook(hookName, handler) {
    if (!hookName || typeof hookName !== 'string')
      throw new Error('Hook name must be a non-empty string');

    if (typeof handler !== 'function')
      throw new Error(`Hook "${hookName}" handler must be a function`);

    if (!this._hooks.has(hookName))
      this._hooks.set(hookName, []);

    this._hooks.get(hookName).push(handler);
  }

  getHookHandlers(hookName) {
    return this._hooks.get(hookName) || [];
  }

  getHooks() {
    return new Map(this._hooks);
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
