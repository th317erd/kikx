'use strict';

// ============================================================================
// Plugin Ability Loader
// ============================================================================
// Loads abilities exported by plugins.
//
// Plugins can export startup abilities by naming them with the pattern:
//   _onstart_*  - Runs after __onstart_ builtin
//   __onstart_* - Runs with highest priority (same as builtin)
//
// Example plugin with startup ability:
//   export const abilities = [
//     {
//       name: '_onstart_my_plugin',
//       type: 'process',
//       description: 'My plugin initialization',
//       content: '## My Plugin Instructions\n\nCustom instructions here...',
//       permissions: { autoApprove: true, dangerLevel: 'safe' },
//     },
//   ];

import { registerAbility, clearAbilitiesBySource } from '../registry.mjs';

/**
 * Load abilities from a plugin module.
 *
 * Plugins can export abilities in several ways:
 * 1. `abilities` array - New format, preferred
 * 2. `commands` array - Legacy format, converted to function abilities
 * 3. `tools` array - Legacy format, converted to function abilities
 *
 * @param {Object} plugin - Plugin object with metadata and module
 * @param {Object} plugin.metadata - Plugin metadata (name, version, etc.)
 * @param {Object} plugin.module - Plugin module exports
 * @returns {number} Number of abilities loaded
 */
export function loadPluginAbilities(plugin) {
  let pluginName = plugin.metadata?.name || 'unknown';
  let count = 0;

  // Load from new `abilities` export
  if (Array.isArray(plugin.module?.abilities)) {
    for (let ability of plugin.module.abilities) {
      try {
        registerAbility({
          id:          `plugin-${pluginName}-${ability.name}`,
          name:        ability.name,
          type:        ability.type || 'function',
          source:      'plugin',
          pluginName:  pluginName,
          content:     ability.content || null,
          execute:     ability.execute || null,
          inputSchema: ability.inputSchema || ability.input_schema || null,
          description: ability.description || '',
          category:    ability.category || 'plugin',
          tags:        ability.tags || [],
          permissions: {
            autoApprove:       ability.permissions?.autoApprove || false,
            autoApprovePolicy: ability.permissions?.autoApprovePolicy || 'ask',
            dangerLevel:       ability.permissions?.dangerLevel || 'safe',
          },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });

        count++;

        // Note if it's a startup ability
        let isStartup = ability.name.startsWith('_onstart_') || ability.name.startsWith('__onstart_');
        console.log(`Loaded plugin ability: ${ability.name} from ${pluginName}${(isStartup) ? ' (startup)' : ''}`);
      } catch (error) {
        console.error(`Failed to load plugin ability ${ability.name}:`, error.message);
      }
    }
  }

  // Convert legacy `commands` export
  if (Array.isArray(plugin.module?.commands)) {
    for (let command of plugin.module.commands) {
      try {
        registerAbility({
          id:          `plugin-${pluginName}-cmd-${command.name}`,
          name:        command.name,
          type:        'function',
          source:      'plugin',
          pluginName:  pluginName,
          execute:     command.execute || command.handler,
          description: command.description || '',
          category:    'plugin-command',
          tags:        ['legacy', 'command'],
          permissions: {
            autoApprove:       false,
            autoApprovePolicy: 'ask',
            dangerLevel:       'moderate',
          },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });

        count++;
        console.log(`Loaded legacy plugin command: ${command.name} from ${pluginName}`);
      } catch (error) {
        console.error(`Failed to load plugin command ${command.name}:`, error.message);
      }
    }
  }

  // Convert legacy `tools` export
  if (Array.isArray(plugin.module?.tools)) {
    for (let tool of plugin.module.tools) {
      try {
        registerAbility({
          id:          `plugin-${pluginName}-tool-${tool.name}`,
          name:        tool.name,
          type:        'function',
          source:      'plugin',
          pluginName:  pluginName,
          execute:     tool.execute || tool.handler,
          inputSchema: tool.input_schema || tool.inputSchema || null,
          description: tool.description || '',
          category:    'plugin-tool',
          tags:        ['legacy', 'tool'],
          permissions: {
            autoApprove:       false,
            autoApprovePolicy: 'ask',
            dangerLevel:       'moderate',
          },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });

        count++;
        console.log(`Loaded legacy plugin tool: ${tool.name} from ${pluginName}`);
      } catch (error) {
        console.error(`Failed to load plugin tool ${tool.name}:`, error.message);
      }
    }
  }

  return count;
}

/**
 * Load abilities from all plugins.
 *
 * @param {Array} plugins - Array of plugin objects
 * @returns {number} Total abilities loaded
 */
export function loadAllPluginAbilities(plugins) {
  // Clear existing plugin abilities
  clearAbilitiesBySource('plugin');

  let total = 0;

  for (let plugin of plugins) {
    try {
      total += loadPluginAbilities(plugin);
    } catch (error) {
      console.error(`Failed to load abilities from plugin ${plugin.metadata?.name}:`, error.message);
    }
  }

  return total;
}

export default {
  loadPluginAbilities,
  loadAllPluginAbilities,
};
