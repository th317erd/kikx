'use strict';

// =============================================================================
// HelpIndex
// =============================================================================
// Aggregates help entries from all registered plugins in the PluginRegistry.
// Includes both tools (for agent use) and commands (for user slash commands).
// Provides grep-style search across names, display names, descriptions.
// =============================================================================

export class HelpIndex {
  constructor(pluginRegistry) {
    if (!pluginRegistry)
      throw new Error('HelpIndex requires a PluginRegistry');

    this._registry = pluginRegistry;
  }

  // ---------------------------------------------------------------------------
  // getEntries — build help entries from all registered tools and commands
  // ---------------------------------------------------------------------------

  getEntries() {
    let entries = [];

    // --- Tools ---
    let tools = this._registry.getTools();
    for (let [name, ToolClass] of tools) {
      let entry = this._buildToolEntry(name, ToolClass);
      entries.push(entry);
    }

    // --- Commands ---
    let commands = this._registry.getCommands();
    for (let [name, commandEntry] of commands) {
      let entry = this._buildCommandEntry(name, commandEntry);
      entries.push(entry);
    }

    // --- Capabilities ---
    let capabilities = this._registry.getCapabilities();
    for (let [name, capability] of capabilities) {
      let entry = this._buildCapabilityEntry(name, capability);
      entries.push(entry);
    }

    return entries;
  }

  // ---------------------------------------------------------------------------
  // search — simple grep-style search
  // ---------------------------------------------------------------------------

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

  // ---------------------------------------------------------------------------
  // Internal: build entries
  // ---------------------------------------------------------------------------

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

    // Merge data from getHelp() if available
    if (typeof ToolClass.prototype.getHelp === 'function') {
      let helpData = ToolClass.prototype.getHelp.call({ constructor: ToolClass });
      return { ...base, ...helpData, category: 'tool', name };
    }

    return base;
  }

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
