'use strict';

import { readdir, readFile, stat, watch } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { pathToFileURL } from 'url';
import { ensurePluginsDir, getPluginsDir } from '../config-path.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * @typedef {object} PluginMetadata
 * @property {string} name - Plugin name
 * @property {string} version - Plugin version
 * @property {string} main - Entry point file
 * @property {Array<string>} agents - Compatible agents ('*' for all)
 * @property {Array<string>} dependencies - Plugin names this depends on
 * @property {string} source - 'internal' or 'user'
 * @property {string} path - Full path to plugin directory
 */

/**
 * @typedef {object} LoadedPlugin
 * @property {PluginMetadata} metadata - Plugin metadata
 * @property {object} module - Loaded module exports
 * @property {boolean} initialized - Whether init() has been called
 */

// Store for loaded plugins
const loadedPlugins = new Map();

// File watcher abort controllers per plugin directory
const watchers = new Map();

// ============================================================================
// Internal Plugins Directory
// ============================================================================

/**
 * Get the internal plugins directory (ships with the app).
 *
 * @returns {string} Absolute path to internal plugins
 */
export function getInternalPluginsDir() {
  return join(__dirname, '..', '..', 'plugins');
}

// ============================================================================
// Plugin Discovery
// ============================================================================

/**
 * Discover all plugins from internal and user directories.
 *
 * Internal plugins are found in server/plugins/.
 * User plugins are found in ~/.config/hero/plugins/.
 *
 * @returns {Promise<Array<PluginMetadata>>} Array of plugin metadata
 */
export async function discoverPlugins() {
  let plugins = [];

  // Discover internal plugins first (lower priority)
  let internalPlugins = await discoverPluginsInDirectory(getInternalPluginsDir(), 'internal');
  for (let plugin of internalPlugins)
    plugins.push(plugin);

  // Discover user plugins (higher priority — can override internal)
  let userPlugins = await discoverPluginsInDirectory(getPluginsDir(), 'user');
  for (let plugin of userPlugins)
    plugins.push(plugin);

  // Deduplicate: user plugins override internal plugins with same name
  let pluginMap = new Map();
  for (let plugin of plugins)
    pluginMap.set(plugin.name, plugin);

  return Array.from(pluginMap.values());
}

/**
 * Discover plugins in a specific directory.
 *
 * @param {string} directory - Directory to scan
 * @param {string} source - 'internal' or 'user'
 * @returns {Promise<Array<PluginMetadata>>} Array of plugin metadata
 */
export async function discoverPluginsInDirectory(directory, source) {
  let plugins = [];

  try {
    let stats = await stat(directory);
    if (!stats.isDirectory())
      return plugins;
  } catch (error) {
    if (error.code === 'ENOENT')
      return plugins;

    console.warn(`Failed to access plugins directory "${directory}":`, error.message);
    return plugins;
  }

  try {
    let entries = await readdir(directory, { withFileTypes: true });

    for (let entry of entries) {
      if (!entry.isDirectory())
        continue;

      let pluginPath = join(directory, entry.name);

      try {
        let metadata = await readPluginMetadata(pluginPath, source);

        if (metadata)
          plugins.push(metadata);
      } catch (error) {
        console.warn(`Failed to read plugin "${entry.name}":`, error.message);
      }
    }
  } catch (error) {
    console.warn(`Failed to discover plugins in "${directory}":`, error.message);
  }

  return plugins;
}

/**
 * Read plugin metadata from package.json.
 *
 * @param {string} pluginPath - Path to plugin directory
 * @param {string} source - 'internal' or 'user'
 * @returns {Promise<PluginMetadata | null>} Plugin metadata or null if invalid
 */
async function readPluginMetadata(pluginPath, source = 'user') {
  let packagePath = join(pluginPath, 'package.json');

  try {
    let packageJson = JSON.parse(await readFile(packagePath, 'utf8'));

    // Validate required fields
    if (!packageJson.name || !packageJson.version)
      return null;

    let main         = packageJson.main || 'index.mjs';
    let hero         = packageJson.hero || {};
    let agents       = hero.agents || ['*'];
    let dependencies = hero.dependencies || [];

    // Verify entry point exists
    let entryPath = join(pluginPath, main);
    let stats     = await stat(entryPath);

    if (!stats.isFile()) {
      console.warn(`Plugin "${packageJson.name}" entry point not found: ${main}`);
      return null;
    }

    return {
      name:         packageJson.name,
      version:      packageJson.version,
      main:         main,
      agents:       agents,
      dependencies: dependencies,
      source:       source,
      path:         pluginPath,
    };
  } catch (error) {
    if (error.code === 'ENOENT')
      return null;

    throw error;
  }
}

// ============================================================================
// Dependency Resolution
// ============================================================================

/**
 * Sort plugins by dependencies (topological sort).
 * Throws if circular dependencies are detected.
 *
 * @param {Array<PluginMetadata>} plugins - Plugins to sort
 * @returns {Array<PluginMetadata>} Sorted plugins (dependencies first)
 */
export function resolveDependencies(plugins) {
  let pluginMap = new Map();
  for (let plugin of plugins)
    pluginMap.set(plugin.name, plugin);

  let sorted  = [];
  let visited = new Set();
  let visiting = new Set();

  function visit(name, chain = []) {
    if (visited.has(name))
      return;

    if (visiting.has(name))
      throw new Error(`Circular plugin dependency detected: ${[...chain, name].join(' → ')}`);

    let plugin = pluginMap.get(name);
    if (!plugin)
      return; // Skip missing dependencies (will be caught at init)

    visiting.add(name);

    for (let dep of plugin.dependencies) {
      if (!pluginMap.has(dep)) {
        console.warn(`Plugin "${name}" depends on "${dep}" which is not available`);
        continue;
      }
      visit(dep, [...chain, name]);
    }

    visiting.delete(name);
    visited.add(name);
    sorted.push(plugin);
  }

  for (let plugin of plugins)
    visit(plugin.name);

  return sorted;
}

// ============================================================================
// Plugin Loading
// ============================================================================

/**
 * Load a plugin by metadata.
 *
 * @param {PluginMetadata} metadata - Plugin metadata
 * @param {object} context - Context passed to plugin init()
 * @returns {Promise<LoadedPlugin>} Loaded plugin
 */
export async function loadPlugin(metadata, context = {}) {
  // Check if already loaded
  if (loadedPlugins.has(metadata.name))
    return loadedPlugins.get(metadata.name);

  let entryPath = join(metadata.path, metadata.main);
  let entryUrl  = pathToFileURL(entryPath).href;

  try {
    let module = await import(entryUrl);

    let plugin = {
      metadata:    metadata,
      module:      module,
      initialized: false,
    };

    loadedPlugins.set(metadata.name, plugin);

    return plugin;
  } catch (error) {
    throw new Error(`Failed to load plugin "${metadata.name}": ${error.message}`);
  }
}

/**
 * Initialize a loaded plugin.
 *
 * @param {LoadedPlugin} plugin - Loaded plugin
 * @param {object} context - Context passed to init()
 * @returns {Promise<void>}
 */
export async function initializePlugin(plugin, context = {}) {
  if (plugin.initialized)
    return;

  // Check that dependencies are loaded
  for (let dep of (plugin.metadata.dependencies || [])) {
    if (!loadedPlugins.has(dep))
      throw new Error(`Plugin "${plugin.metadata.name}" requires "${dep}" which is not loaded`);
  }

  if (typeof plugin.module.init === 'function') {
    try {
      await plugin.module.init(context);
    } catch (error) {
      throw new Error(`Plugin "${plugin.metadata.name}" init failed: ${error.message}`);
    }
  }

  plugin.initialized = true;
}

/**
 * Unload a plugin.
 *
 * @param {string} name - Plugin name
 * @returns {Promise<boolean>} True if plugin was unloaded
 */
export async function unloadPlugin(name) {
  let plugin = loadedPlugins.get(name);

  if (!plugin)
    return false;

  // Check if other loaded plugins depend on this one
  for (let [otherName, otherPlugin] of loadedPlugins) {
    if (otherName === name)
      continue;

    if (otherPlugin.metadata.dependencies?.includes(name)) {
      console.warn(`Cannot unload "${name}": plugin "${otherName}" depends on it`);
      return false;
    }
  }

  // Call destroy if available
  if (plugin.initialized && typeof plugin.module.destroy === 'function') {
    try {
      await plugin.module.destroy();
    } catch (error) {
      console.warn(`Plugin "${name}" destroy failed:`, error.message);
    }
  }

  loadedPlugins.delete(name);
  return true;
}

/**
 * Reload a plugin (unload then load).
 *
 * @param {string} name - Plugin name
 * @param {object} context - Context passed to plugin init()
 * @returns {Promise<LoadedPlugin|null>} Reloaded plugin, or null if failed
 */
export async function reloadPlugin(name, context = {}) {
  let plugin = loadedPlugins.get(name);

  if (!plugin) {
    console.warn(`Cannot reload "${name}": not currently loaded`);
    return null;
  }

  let metadata = plugin.metadata;

  // Re-read metadata in case package.json changed
  try {
    let freshMetadata = await readPluginMetadata(metadata.path, metadata.source);
    if (freshMetadata)
      metadata = freshMetadata;
  } catch (error) {
    console.warn(`Failed to re-read metadata for "${name}":`, error.message);
  }

  // Unload
  await unloadPlugin(name);

  // Load fresh
  try {
    let reloaded = await loadPlugin(metadata, context);
    await initializePlugin(reloaded, context);
    console.log(`Plugin "${name}" reloaded successfully`);
    return reloaded;
  } catch (error) {
    console.error(`Failed to reload plugin "${name}":`, error.message);
    return null;
  }
}

// ============================================================================
// Batch Loading
// ============================================================================

/**
 * Load all plugins compatible with a given agent type.
 * Resolves dependencies and loads in correct order.
 *
 * @param {string} agentType - Agent type (e.g., 'claude')
 * @param {object} context - Context passed to plugin init()
 * @returns {Promise<Array<LoadedPlugin>>} Loaded and initialized plugins
 */
export async function loadPluginsForAgent(agentType, context = {}) {
  let allPlugins = await discoverPlugins();
  let compatible = allPlugins.filter((p) => p.agents.includes('*') || p.agents.includes(agentType));

  // Resolve dependency ordering
  let sorted;
  try {
    sorted = resolveDependencies(compatible);
  } catch (error) {
    console.error('Plugin dependency resolution failed:', error.message);
    sorted = compatible; // Fall back to unordered
  }

  let loaded = [];

  for (let metadata of sorted) {
    try {
      let plugin = await loadPlugin(metadata, context);
      await initializePlugin(plugin, context);
      loaded.push(plugin);
    } catch (error) {
      console.error(`Failed to load plugin "${metadata.name}":`, error.message);
    }
  }

  return loaded;
}

// ============================================================================
// Hot-Reload (File Watching)
// ============================================================================

/**
 * Start watching a plugins directory for changes.
 * When a plugin file changes, it will be automatically reloaded.
 *
 * @param {string} directory - Directory to watch
 * @param {object} context - Context passed to reloaded plugins
 * @returns {AbortController} Controller to stop watching
 */
export function watchPluginsDirectory(directory, context = {}) {
  let controller = new AbortController();

  // Debounce map to prevent rapid reloads
  let pending = new Map();

  (async () => {
    try {
      let watcher = watch(directory, { recursive: true, signal: controller.signal });

      for await (let event of watcher) {
        let filename = event.filename;
        if (!filename)
          continue;

        // Extract plugin name from path (first directory component)
        let pluginName = filename.split('/')[0] || filename.split('\\')[0];

        // Skip if this plugin is not loaded
        let plugin = loadedPlugins.get(pluginName);
        if (!plugin)
          continue;

        // Clear any pending reload for this plugin
        if (pending.has(pluginName)) {
          clearTimeout(pending.get(pluginName));
        }

        // Schedule reload after brief pause (coalesce rapid changes)
        pending.set(pluginName, setTimeout(async () => {
          pending.delete(pluginName);
          console.log(`[Plugins] Detected change in "${pluginName}", reloading...`);
          await reloadPlugin(pluginName, context);
        }, 300));
      }
    } catch (error) {
      if (error.name !== 'AbortError')
        console.error('[Plugins] Watch error:', error.message);
    }
  })();

  watchers.set(directory, controller);
  return controller;
}

/**
 * Stop watching a plugins directory.
 *
 * @param {string} directory - Directory to stop watching
 */
export function stopWatchingDirectory(directory) {
  let controller = watchers.get(directory);

  if (controller) {
    controller.abort();
    watchers.delete(directory);
  }
}

/**
 * Stop all directory watchers.
 */
export function stopAllWatchers() {
  for (let [directory, controller] of watchers) {
    controller.abort();
  }
  watchers.clear();
}

// ============================================================================
// Query Helpers
// ============================================================================

/**
 * Get all loaded plugins.
 *
 * @returns {Array<LoadedPlugin>} Loaded plugins
 */
export function getLoadedPlugins() {
  return Array.from(loadedPlugins.values());
}

/**
 * Get a loaded plugin by name.
 *
 * @param {string} name - Plugin name
 * @returns {LoadedPlugin | undefined} Loaded plugin or undefined
 */
export function getPlugin(name) {
  return loadedPlugins.get(name);
}

/**
 * Check if a plugin is loaded.
 *
 * @param {string} name - Plugin name
 * @returns {boolean} True if loaded
 */
export function isPluginLoaded(name) {
  return loadedPlugins.has(name);
}

export default {
  getInternalPluginsDir,
  discoverPlugins,
  discoverPluginsInDirectory,
  resolveDependencies,
  loadPlugin,
  initializePlugin,
  unloadPlugin,
  reloadPlugin,
  loadPluginsForAgent,
  watchPluginsDirectory,
  stopWatchingDirectory,
  stopAllWatchers,
  getLoadedPlugins,
  getPlugin,
  isPluginLoaded,
};
