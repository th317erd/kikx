'use strict';

import { getLoadedPlugins } from './loader.mjs';

/**
 * Get all commands from loaded plugins.
 *
 * @param {string} [agentType] - Filter by agent type (optional)
 * @returns {Array<PluginCommand>} Plugin commands
 */
export function getPluginCommands(agentType) {
  let plugins  = getLoadedPlugins();
  let commands = [];

  for (let plugin of plugins) {
    // Check agent compatibility
    if (agentType) {
      let agents = plugin.metadata.agents;

      if (!agents.includes('*') && !agents.includes(agentType))
        continue;
    }

    let pluginCommands = plugin.module.commands;

    if (!Array.isArray(pluginCommands))
      continue;

    for (let command of pluginCommands) {
      commands.push({
        name:        command.name,
        description: command.description || '',
        execute:     command.execute,
        plugin:      plugin.metadata.name,
        source:      'plugin',
      });
    }
  }

  return commands;
}

/**
 * Get all tools from loaded plugins.
 *
 * @param {string} [agentType] - Filter by agent type (optional)
 * @returns {Array<PluginTool>} Plugin tools
 */
export function getPluginTools(agentType) {
  let plugins = getLoadedPlugins();
  let tools   = [];

  for (let plugin of plugins) {
    // Check agent compatibility
    if (agentType) {
      let agents = plugin.metadata.agents;

      if (!agents.includes('*') && !agents.includes(agentType))
        continue;
    }

    let pluginTools = plugin.module.tools;

    if (!Array.isArray(pluginTools))
      continue;

    for (let tool of pluginTools) {
      tools.push({
        name:        tool.name,
        description: tool.description || '',
        inputSchema: tool.input_schema || tool.inputSchema,
        execute:     tool.execute,
        plugin:      plugin.metadata.name,
        source:      'plugin',
      });
    }
  }

  return tools;
}

/**
 * Find a command by name across all sources (plugins and user-defined).
 *
 * @param {string} name - Command name
 * @param {Array<object>} userCommands - User-defined commands from database
 * @param {string} [agentType] - Agent type for filtering
 * @returns {object | null} Command or null if not found
 */
export function findCommand(name, userCommands = [], agentType) {
  // User commands take precedence
  let userCommand = userCommands.find((c) => c.name === name);

  if (userCommand)
    return { ...userCommand, source: 'user' };

  // Then check plugins
  let pluginCommands = getPluginCommands(agentType);
  let pluginCommand  = pluginCommands.find((c) => c.name === name);

  if (pluginCommand)
    return pluginCommand;

  return null;
}

/**
 * Find a tool by name across all sources (plugins and user-defined).
 *
 * @param {string} name - Tool name
 * @param {Array<object>} userTools - User-defined tools from database
 * @param {string} [agentType] - Agent type for filtering
 * @returns {object | null} Tool or null if not found
 */
export function findTool(name, userTools = [], agentType) {
  // User tools take precedence
  let userTool = userTools.find((t) => t.name === name);

  if (userTool)
    return { ...userTool, source: 'user' };

  // Then check plugins
  let pluginTools = getPluginTools(agentType);
  let pluginTool  = pluginTools.find((t) => t.name === name);

  if (pluginTool)
    return pluginTool;

  return null;
}

/**
 * Get all available commands (plugins + user-defined).
 *
 * @param {Array<object>} userCommands - User-defined commands
 * @param {string} [agentType] - Agent type for filtering
 * @returns {Array<object>} All commands
 */
export function getAllCommands(userCommands = [], agentType) {
  let pluginCommands = getPluginCommands(agentType);

  // Merge, with user commands taking precedence
  let commandMap = new Map();

  for (let cmd of pluginCommands)
    commandMap.set(cmd.name, cmd);

  for (let cmd of userCommands)
    commandMap.set(cmd.name, { ...cmd, source: 'user' });

  return Array.from(commandMap.values());
}

/**
 * Get all available tools (plugins + user-defined).
 *
 * @param {Array<object>} userTools - User-defined tools
 * @param {string} [agentType] - Agent type for filtering
 * @returns {Array<object>} All tools
 */
export function getAllTools(userTools = [], agentType) {
  let pluginTools = getPluginTools(agentType);

  // Merge, with user tools taking precedence
  let toolMap = new Map();

  for (let tool of pluginTools)
    toolMap.set(tool.name, tool);

  for (let tool of userTools)
    toolMap.set(tool.name, { ...tool, source: 'user' });

  return Array.from(toolMap.values());
}

/**
 * @typedef {object} PluginCommand
 * @property {string} name - Command name
 * @property {string} description - Command description
 * @property {function(string, object, AbortSignal?): Promise<string>} execute - Execution function
 * @property {string} plugin - Source plugin name
 * @property {'plugin'} source - Source type
 */

/**
 * @typedef {object} PluginTool
 * @property {string} name - Tool name
 * @property {string} description - Tool description
 * @property {object} inputSchema - JSON schema for input
 * @property {function(object, object, AbortSignal?): Promise<string>} execute - Execution function
 * @property {string} plugin - Source plugin name
 * @property {'plugin'} source - Source type
 */

export default {
  getPluginCommands,
  getPluginTools,
  findCommand,
  findTool,
  getAllCommands,
  getAllTools,
};
