'use strict';

// =============================================================================
// HelpIndex
// =============================================================================
// Aggregates help entries from all registered plugins in the PluginRegistry.
// Provides grep-style search across tool names, display names, descriptions.
// =============================================================================

export class HelpIndex {
  constructor(pluginRegistry) {
    if (!pluginRegistry)
      throw new Error('HelpIndex requires a PluginRegistry');

    this._registry = pluginRegistry;
  }

  // ---------------------------------------------------------------------------
  // getEntries — build help entries from all registered tools
  // ---------------------------------------------------------------------------

  getEntries() {
    let entries = [];
    let tools   = this._registry.getTools();

    for (let [name, ToolClass] of tools) {
      if (typeof ToolClass.prototype.getHelp === 'function') {
        let helpData = ToolClass.prototype.getHelp.call({ constructor: ToolClass });
        entries.push({ toolName: name, ...helpData });
      } else {
        // Fallback: build entry from static metadata
        entries.push({
          toolName:    name,
          name:        `${ToolClass.pluginId}:${ToolClass.featureName}`,
          displayName: ToolClass.displayName || name,
          description: ToolClass.description || null,
          icon:        ToolClass.icon || null,
        });
      }
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
      return (entry.toolName && entry.toolName.toLowerCase().includes(lower))
        || (entry.name && entry.name.toLowerCase().includes(lower))
        || (entry.displayName && entry.displayName.toLowerCase().includes(lower))
        || (entry.description && entry.description.toLowerCase().includes(lower));
    });
  }
}
