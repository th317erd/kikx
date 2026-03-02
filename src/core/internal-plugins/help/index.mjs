'use strict';

import { HelpIndex } from '../../help/help-index.mjs';

// =============================================================================
// Help Plugin
// =============================================================================
// Registers as a tool so agents can query available tools and commands.
// Uses HelpIndex to aggregate and search all registered tools.
// =============================================================================

export function setup({ registerTool, PluginInterface, context }) {
  class HelpTool extends PluginInterface {
    static pluginId    = 'help';
    static featureName = 'search';
    static displayName = 'Help';
    static description = 'Search available tools and commands';

    async _execute({ query }) {
      let registry  = context.getProperty('pluginRegistry');
      let helpIndex = new HelpIndex(registry);

      if (!query)
        return { entries: helpIndex.getEntries() };

      return { entries: helpIndex.search(query) };
    }

    getHelp() {
      return {
        ...super.getHelp(),
        usage:   'help:search { query: "shell" }',
        examples: [
          { query: '',      description: 'List all available tools' },
          { query: 'shell', description: 'Search for shell-related tools' },
        ],
      };
    }
  }

  registerTool('help:search', HelpTool);

  return () => {};
}
