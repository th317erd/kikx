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
    this._capabilities   = new Map();
    this._customElements = new Set();
    this._agentTypes     = new Map();
    this._hooks          = new Map(); // hookName -> handler[]
    this._instructions   = [];        // { pluginName, content, priority }
    this._selectors      = [];        // { selector, PluginClass, pluginName }
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

  registerCommand(name, handler, help) {
    if (!name || typeof name !== 'string')
      throw new Error('Command name must be a non-empty string');

    if (typeof handler !== 'function')
      throw new Error(`Command "${name}" handler must be a function`);

    if (this._commands.has(name))
      console.warn(`Command "${name}" is being overridden`);

    this._commands.set(name, { handler, help: help || null });
  }

  getCommand(name) {
    let entry = this._commands.get(name);
    return (entry) ? entry.handler : null;
  }

  getCommandHelp(name) {
    let entry = this._commands.get(name);
    return (entry) ? entry.help : null;
  }

  getCommands() {
    return new Map(this._commands);
  }

  // ---------------------------------------------------------------------------
  // Capabilities (unified command + tool)
  // ---------------------------------------------------------------------------

  registerCapability(name, options) {
    if (!name || typeof name !== 'string')
      throw new Error('Capability name must be a non-empty string');

    if (!options || typeof options.handler !== 'function')
      throw new Error(`Capability "${name}" handler must be a function`);

    if (this._capabilities.has(name))
      console.warn(`Capability "${name}" is being overridden`);

    this._capabilities.set(name, {
      name,
      handler:      options.handler,
      schema:       options.schema || null,
      description:  options.description || null,
      displayName:  options.displayName || null,
      riskLevel:    options.riskLevel || 'high',
      slashCommand: options.slashCommand || null,
      parseArgs:    options.parseArgs || null,
      examples:     options.examples || null,
    });
  }

  getCapability(name) {
    return this._capabilities.get(name) || null;
  }

  getCapabilities() {
    return new Map(this._capabilities);
  }

  getCapabilityBySlashCommand(commandName) {
    for (let [, capability] of this._capabilities) {
      if (capability.slashCommand === commandName)
        return capability;
    }

    return null;
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

  // ---------------------------------------------------------------------------
  // Instructions
  // ---------------------------------------------------------------------------

  registerInstructions(pluginName, content, options = {}) {
    if (!content || typeof content !== 'string')
      throw new Error('Instruction content must be a non-empty string');

    let priority = (options.priority !== undefined) ? options.priority : 100;
    this._instructions.push({ pluginName, content, priority });
  }

  getInstructions() {
    return [...this._instructions].sort((a, b) => a.priority - b.priority);
  }

  // ---------------------------------------------------------------------------
  // Selectors (Frame Event Router)
  // ---------------------------------------------------------------------------

  registerSelector(selector, PluginClass, pluginName) {
    if (!selector)
      throw new Error('Selector must be a non-empty string or function');

    if (!PluginClass || typeof PluginClass !== 'function')
      throw new Error('PluginClass must be a constructor function');

    this._selectors.push({ selector, PluginClass, pluginName: pluginName || null });
  }

  getSelectors() {
    return [...this._selectors];
  }
}
