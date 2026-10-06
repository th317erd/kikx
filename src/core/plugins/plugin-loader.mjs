'use strict';

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { AgentInterface } from './agent-interface.mjs';
import { PluginInterface } from './plugin-interface.mjs';

export async function loadPlugins(options = {}) {
  let {
    pluginPaths = '',
    registry,
    commandRegistry = null,
    context = {},
    logger = console,
  } = options;

  if (!registry)
    throw new TypeError('loadPlugins() requires registry');

  registry.registerClass('AgentInterface', AgentInterface, { pluginName: 'core' });
  registry.registerClass('PluginInterface', PluginInterface, { pluginName: 'core' });

  let loaded = [];
  for (let pluginPath of normalizePluginPaths(pluginPaths)) {
    try {
      let modulePath = await resolvePluginModule(pluginPath);
      let pluginModule = await import(`${pathToFileURL(modulePath).href}?t=${Date.now()}`);

      if (typeof pluginModule.setup !== 'function')
        continue;

      let pluginName = pluginModule.pluginName || pluginNameFromPath(pluginPath);
      let record = { pluginPath, pluginName, modulePath, callbacks: [], teardown: null };
      let providerIDsBefore = agentProviderIDs(registry);
      let teardown = await pluginModule.setup(createPluginSetupContext({
        registry,
        commandRegistry,
        context,
        pluginPath,
        pluginName,
        onProvide: (callback) => record.callbacks.push(callback),
      }));
      if (typeof teardown === 'function')
        record.teardown = teardown;

      if (typeof registry.registerPluginPath === 'function') {
        let registeredProviderIDs = [];
        for (let key of agentProviderIDs(registry)) {
          if (!providerIDsBefore.has(key))
            registeredProviderIDs.push(key);
        }

        registry.registerPluginPath(pluginName, pluginPath, registeredProviderIDs);
      }

      registerPluginRecord(registry, record);
      loaded.push({ path: pluginPath, modulePath, pluginName });
    } catch (error) {
      logger.warn?.(`Failed to load plugin at ${pluginPath}: ${error.message}`);
    }
  }

  return loaded;
}

// Unload a plugin: run its teardown, pop its class overrides, and forget its
// registrations. Returns true if a plugin by that name was loaded.
export async function unloadPlugin(registry, pluginName, { logger = console } = {}) {
  let record = removePluginRecord(registry, pluginName);
  if (!record)
    return false;

  try {
    if (typeof record.teardown === 'function')
      await record.teardown();
  } catch (error) {
    logger.warn?.(`Plugin "${pluginName}" teardown failed: ${error.message}`);
  }

  if (typeof registry.unregisterPlugin === 'function')
    registry.unregisterPlugin(pluginName);

  return true;
}

function agentProviderIDs(registry) {
  if (typeof registry.getAgentProviders !== 'function')
    return new Set();

  return new Set(registry.getAgentProviders().keys());
}

function registerPluginRecord(registry, record) {
  if (!registry._pluginRegistrations)
    registry._pluginRegistrations = new Map();

  registry._pluginRegistrations.set(record.pluginName, record);
}

function removePluginRecord(registry, pluginName) {
  let map = registry._pluginRegistrations;
  if (!map || !map.has(pluginName))
    return null;

  let record = map.get(pluginName);
  map.delete(pluginName);
  return record;
}

function pluginNameFromPath(pluginPath) {
  let normalized = String(pluginPath).replace(/[/\\]+$/g, '');
  let base = normalized.split(/[/\\]/).pop() || normalized;
  return base.replace(/\.[^.]+$/, '');
}

function createPluginSetupContext({ registry, commandRegistry, context, pluginPath, pluginName = null, onProvide = null }) {
  // Attribute class registrations to the loading plugin so overrides can be
  // popped by unregisterPlugin / unloadPlugin.
  let registerClass = (...args) => registry.registerClass(...attributeToPlugin(args, pluginName));

  let directContext = {
    registry,
    commandRegistry,
    context,
    pluginPath,
    pluginName,
    PluginInterface,
    AgentInterface,
    registerClass,
    registerTool: (...args) => registry.registerTool(...args),
    registerAgentProvider: (...args) => registry.registerAgentProvider(...args),
    registerAgentType: (...args) => registry.registerAgentType(...args),
    registerCommand: (...args) => {
      if (!commandRegistry)
        throw new Error('Command registry is not available in this plugin context');

      return commandRegistry.registerCommand(...args);
    },
    registerSelector: (...args) => registry.registerSelector(...args),
    registerComponent: (...args) => registry.registerComponent(...args),
    registerFrameComponent: (...args) => registry.registerFrameComponent(...args),
    registerToolComponent: (...args) => registry.registerToolComponent(...args),
    registerAgentConfigForm: (...args) => registry.registerAgentConfigForm(...args),
  };

  return (callback) => {
    if (typeof callback === 'function') {
      onProvide?.(callback);
      return callback(directContext);
    }

    return directContext;
  };
}

// registerClass(...) may take options as the 2nd (class + options) or 3rd
// (key + class + options) argument. Inject pluginName only when absent.
function attributeToPlugin(args, pluginName) {
  if (!pluginName)
    return args;

  let next = args.slice();
  if (typeof next[0] === 'string') {
    let options = (next[2] && typeof next[2] === 'object') ? next[2] : {};
    next[2] = { pluginName, ...options };
  } else {
    let options = (next[1] && typeof next[1] === 'object') ? next[1] : {};
    next[1] = { pluginName, ...options };
  }

  return next;
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
