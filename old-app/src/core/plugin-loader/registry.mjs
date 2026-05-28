'use strict';

// =============================================================================
// Plugin Registry
// =============================================================================
// In-memory registries for tools, commands, and custom elements.
// Extends ClassRegistry for universal class registration + stack-based override.
// Conflict policy: implicit override with console warning (not error).
// =============================================================================

import { PluginInterface } from './plugin-interface.mjs';
import { ClassRegistry }   from '../class-registry.mjs';

export class PluginRegistry extends ClassRegistry {
  constructor() {
    super();

    /** @type {Map<string, typeof PluginInterface>} */
    this._tools          = new Map();

    /** @type {Map<string, { handler: Function; help: string | null }>} */
    this._commands       = new Map();

    /** @type {Map<string, { name: string; handler: Function; schema: import('../types').JSONSchema | null; description: string | null; displayName: string | null; riskLevel: string; slashCommand: string | null; parseArgs: Function | null; examples: any }>} */
    this._capabilities   = new Map();

    /** @type {Set<string>} */
    this._customElements = new Set();

    /** @type {Map<string, typeof PluginInterface>} */
    this._agentTypes     = new Map();

    /** @type {Map<string, Function[]>} */
    this._hooks          = new Map();

    /** @type {Array<{ pluginName: string; content: string; priority: number }>} */
    this._instructions   = [];

    /** @type {Array<{ selector: string | Function; PluginClass: Function; pluginName: string | null }>} */
    this._selectors      = [];
  }

  // ---------------------------------------------------------------------------
  // Tools
  // ---------------------------------------------------------------------------

  /**
   * Register a tool class by name.
   * @param {string} name
   * @param {typeof PluginInterface} ToolClass
   * @returns {void}
   */
  registerTool(name, ToolClass) {
    if (!name || typeof name !== 'string')
      throw new Error('Tool name must be a non-empty string');

    if (!ToolClass || !(ToolClass.prototype instanceof PluginInterface))
      throw new Error(`Tool "${name}" must extend PluginInterface`);

    if (this._tools.has(name))
      console.warn(`Tool "${name}" is being overridden`);

    this._tools.set(name, ToolClass);
  }

  /**
   * @param {string} name
   * @returns {typeof PluginInterface | null}
   */
  getTool(name) {
    return this._tools.get(name) || null;
  }

  /**
   * @returns {Map<string, typeof PluginInterface>}
   */
  getTools() {
    return new Map(this._tools);
  }

  // ---------------------------------------------------------------------------
  // Commands
  // ---------------------------------------------------------------------------

  /**
   * Register a command handler.
   * @param {string} name
   * @param {Function} handler
   * @param {string} [help]
   * @returns {void}
   */
  registerCommand(name, handler, help) {
    if (!name || typeof name !== 'string')
      throw new Error('Command name must be a non-empty string');

    if (typeof handler !== 'function')
      throw new Error(`Command "${name}" handler must be a function`);

    if (this._commands.has(name))
      console.warn(`Command "${name}" is being overridden`);

    this._commands.set(name, { handler, help: help || null });
  }

  /**
   * @param {string} name
   * @returns {Function | null}
   */
  getCommand(name) {
    let entry = this._commands.get(name);
    return (entry) ? entry.handler : null;
  }

  /**
   * @param {string} name
   * @returns {string | null}
   */
  getCommandHelp(name) {
    let entry = this._commands.get(name);
    return (entry) ? entry.help : null;
  }

  /**
   * @returns {Map<string, { handler: Function; help: string | null }>}
   */
  getCommands() {
    return new Map(this._commands);
  }

  // ---------------------------------------------------------------------------
  // Capabilities (unified command + tool)
  // ---------------------------------------------------------------------------

  /**
   * Register a capability (unified command + tool).
   * @param {string} name
   * @param {{ handler: Function; schema?: import('../types').JSONSchema | null; description?: string | null; displayName?: string | null; riskLevel?: string; slashCommand?: string | null; parseArgs?: Function | null; examples?: any }} options
   * @returns {void}
   */
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

  /**
   * @param {string} name
   * @returns {Record<string, any> | null}
   */
  getCapability(name) {
    return this._capabilities.get(name) || null;
  }

  /**
   * @returns {Map<string, Record<string, any>>}
   */
  getCapabilities() {
    return new Map(this._capabilities);
  }

  /**
   * Find a capability by its slash command name.
   * @param {string} commandName
   * @returns {Record<string, any> | null}
   */
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

  /**
   * Register an agent type class.
   * @param {string} id
   * @param {typeof PluginInterface} AgentClass
   * @returns {void}
   */
  registerAgentType(id, AgentClass) {
    if (!id || typeof id !== 'string')
      throw new Error('Agent type id must be a non-empty string');

    if (!AgentClass || !(AgentClass.prototype instanceof PluginInterface))
      throw new Error(`Agent type "${id}" must extend PluginInterface`);

    if (this._agentTypes.has(id))
      console.warn(`Agent type "${id}" is being overridden`);

    this._agentTypes.set(id, AgentClass);
  }

  /**
   * @param {string} id
   * @returns {typeof PluginInterface | null}
   */
  getAgentType(id) {
    return this._agentTypes.get(id) || null;
  }

  /**
   * @returns {Map<string, typeof PluginInterface>}
   */
  getAgentTypes() {
    return new Map(this._agentTypes);
  }

  // ---------------------------------------------------------------------------
  // Hooks
  // ---------------------------------------------------------------------------

  /**
   * Register a hook handler.
   * @param {string} hookName
   * @param {Function} handler
   * @returns {void}
   */
  registerHook(hookName, handler) {
    if (!hookName || typeof hookName !== 'string')
      throw new Error('Hook name must be a non-empty string');

    if (typeof handler !== 'function')
      throw new Error(`Hook "${hookName}" handler must be a function`);

    if (!this._hooks.has(hookName))
      this._hooks.set(hookName, []);

    this._hooks.get(hookName).push(handler);
  }

  /**
   * @param {string} hookName
   * @returns {Function[]}
   */
  getHookHandlers(hookName) {
    return this._hooks.get(hookName) || [];
  }

  /**
   * @returns {Map<string, Function[]>}
   */
  getHooks() {
    return new Map(this._hooks);
  }

  // ---------------------------------------------------------------------------
  // Custom Elements
  // ---------------------------------------------------------------------------

  /**
   * Register a custom element tag name.
   * @param {string} tagName
   * @returns {void}
   */
  registerCustomElement(tagName) {
    if (!tagName || typeof tagName !== 'string')
      throw new Error('Custom element tag name must be a non-empty string');

    this._customElements.add(tagName);
  }

  /**
   * @returns {Set<string>}
   */
  getCustomElements() {
    return new Set(this._customElements);
  }

  // ---------------------------------------------------------------------------
  // Instructions
  // ---------------------------------------------------------------------------

  /**
   * Register plugin instructions with optional priority.
   * @param {string} pluginName
   * @param {string} content
   * @param {{ priority?: number }} [options]
   * @returns {void}
   */
  registerInstructions(pluginName, content, options = {}) {
    if (!content || typeof content !== 'string')
      throw new Error('Instruction content must be a non-empty string');

    let priority = (options.priority !== undefined) ? options.priority : 100;
    this._instructions.push({ pluginName, content, priority });
  }

  /**
   * Get all instructions sorted by priority (ascending).
   * @returns {Array<{ pluginName: string; content: string; priority: number }>}
   */
  getInstructions() {
    return [...this._instructions].sort((a, b) => a.priority - b.priority);
  }

  // ---------------------------------------------------------------------------
  // Selectors (Frame Event Router)
  // ---------------------------------------------------------------------------

  /**
   * Register a frame event selector with its plugin class.
   * @param {string | Function} selector
   * @param {Function} PluginClass
   * @param {string} [pluginName]
   * @returns {void}
   */
  registerSelector(selector, PluginClass, pluginName) {
    if (!selector)
      throw new Error('Selector must be a non-empty string or function');

    if (!PluginClass || typeof PluginClass !== 'function')
      throw new Error('PluginClass must be a constructor function');

    this._selectors.push({ selector, PluginClass, pluginName: pluginName || null });
  }

  /**
   * @returns {Array<{ selector: string | Function; PluginClass: Function; pluginName: string | null }>}
   */
  getSelectors() {
    return [...this._selectors];
  }
}
