'use strict';

// =============================================================================
// HelpIndex
// =============================================================================

/**
 * @typedef {object} HelpEntry
 * @property {string} category
 * @property {string} name
 * @property {string} [displayName]
 * @property {string|null} [description]
 * @property {string|null} [icon]
 * @property {string} [riskLevel]
 * @property {import('../types').JSONSchema|null} [inputSchema]
 * @property {string} [usage]
 * @property {any} [parameters]
 * @property {any} [examples]
 * @property {any} [schema]
 * @property {string|null} [slashCommand]
 */

export class HelpIndex {
  /**
   * @param {object} pluginRegistry
   */
  constructor(pluginRegistry) {
    if (!pluginRegistry)
      throw new Error('HelpIndex requires a PluginRegistry');

    /** @type {object} */
    this._registry = pluginRegistry;
  }

  /**
   * Build help entries from all registered tools and commands.
   * @returns {HelpEntry[]}
   */
  getEntries() {
    let entries = [];

    let tools = this._registry.getTools();
    for (let [name, ToolClass] of tools) {
      let entry = this._buildToolEntry(name, ToolClass);
      entries.push(entry);
    }

    let commands = this._registry.getCommands();
    for (let [name, commandEntry] of commands) {
      let entry = this._buildCommandEntry(name, commandEntry);
      entries.push(entry);
    }

    let capabilities = this._registry.getCapabilities();
    for (let [name, capability] of capabilities) {
      let entry = this._buildCapabilityEntry(name, capability);
      entries.push(entry);
    }

    return entries;
  }

  /**
   * Simple grep-style search across help entries.
   * @param {string} [query]
   * @returns {HelpEntry[]}
   */
  search(query) {
    let entries = this.getEntries();

    if (!query || typeof query !== 'string')
      return entries;

    let lower = query.toLowerCase();

    return entries.filter((entry) => {
      return (entry.name && entry.name.toLowerCase().includes(lower))
        || (entry.displayName && entry.displayName.toLowerCase().includes(lower))
        || (entry.description && entry.description.toLowerCase().includes(lower))
        || (entry.usage && entry.usage.toLowerCase().includes(lower))
        || (entry.category && entry.category.toLowerCase().includes(lower));
    });
  }

  /**
   * @param {string} name
   * @param {Function} ToolClass
   * @returns {HelpEntry}
   */
  _buildToolEntry(name, ToolClass) {
    let base = {
      category:    'tool',
      name,
      displayName: ToolClass.displayName || name,
      description: ToolClass.description || null,
      icon:        ToolClass.icon || null,
      riskLevel:   ToolClass.riskLevel || 'high',
      inputSchema: ToolClass.inputSchema || null,
    };

    if (typeof ToolClass.prototype.getHelp === 'function') {
      let helpData = ToolClass.prototype.getHelp.call({ constructor: ToolClass });
      return { ...base, ...helpData, category: 'tool', name };
    }

    return base;
  }

  /**
   * @param {string} name
   * @param {object} commandEntry
   * @returns {HelpEntry}
   */
  _buildCommandEntry(name, commandEntry) {
    let help = commandEntry.help || {};

    return {
      category:    'command',
      name:        `/${name}`,
      displayName: help.displayName || `/${name}`,
      description: help.description || null,
      usage:       help.usage || `/${name}`,
      parameters:  help.parameters || null,
      examples:    help.examples || null,
    };
  }

  /**
   * @param {string} name
   * @param {object} capability
   * @returns {HelpEntry}
   */
  _buildCapabilityEntry(name, capability) {
    let entry = {
      category:     'capability',
      name,
      displayName:  capability.displayName || name,
      description:  capability.description || null,
      riskLevel:    capability.riskLevel || 'high',
      schema:       capability.schema || null,
      slashCommand: capability.slashCommand || null,
      examples:     capability.examples || null,
    };

    if (capability.slashCommand)
      entry.usage = `/${capability.slashCommand}`;

    return entry;
  }
}
