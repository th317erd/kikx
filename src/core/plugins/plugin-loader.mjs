'use strict';

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { AgentInterface } from './agent-interface.mjs';
import { PluginInterface } from './plugin-interface.mjs';

export async function loadPlugins(options = {}) {
  let {
    pluginPaths = process.env.KIKX_PLUGIN_PATHS || '',
    registry,
    context = {},
    logger = console,
  } = options;

  if (!registry)
    throw new TypeError('loadPlugins() requires registry');

  registry.registerClass('AgentInterface', AgentInterface);
  registry.registerClass('PluginInterface', PluginInterface);

  let loaded = [];
  for (let pluginPath of normalizePluginPaths(pluginPaths)) {
    try {
      let modulePath = await resolvePluginModule(pluginPath);
      let pluginModule = await import(`${pathToFileURL(modulePath).href}?t=${Date.now()}`);

      if (typeof pluginModule.setup !== 'function')
        continue;

      await pluginModule.setup(createPluginSetupContext({ registry, context, pluginPath }));
      loaded.push({ path: pluginPath, modulePath });
    } catch (error) {
      logger.warn?.(`Failed to load plugin at ${pluginPath}: ${error.message}`);
    }
  }

  return loaded;
}

function createPluginSetupContext({ registry, context, pluginPath }) {
  let directContext = {
    registry,
    context,
    pluginPath,
    PluginInterface,
    AgentInterface,
    registerTool: (...args) => registry.registerTool(...args),
    registerAgentProvider: (...args) => registry.registerAgentProvider(...args),
    registerAgentType: (...args) => registry.registerAgentType(...args),
    registerSelector: (...args) => registry.registerSelector(...args),
  };

  return (callback) => {
    if (typeof callback === 'function')
      return callback(directContext);

    return directContext;
  };
}

function normalizePluginPaths(pluginPaths) {
  if (Array.isArray(pluginPaths))
    return pluginPaths.filter(Boolean);

  if (!pluginPaths || typeof pluginPaths !== 'string')
    return [];

  return pluginPaths
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

async function resolvePluginModule(pluginPath) {
  let stat = await fs.stat(pluginPath);
  if (stat.isFile())
    return pluginPath;

  let packageJSONPath = path.join(pluginPath, 'package.json');
  try {
    let packageJSON = JSON.parse(await fs.readFile(packageJSONPath, 'utf8'));
    return path.join(pluginPath, packageJSON.main || 'index.mjs');
  } catch (_error) {
    return path.join(pluginPath, 'index.mjs');
  }
}
