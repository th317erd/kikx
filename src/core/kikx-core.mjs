'use strict';

// =============================================================================
// KikxCore
// =============================================================================
// Embeddable core engine with zero HTTP dependencies.
// Manages database, models, plugins, sessions, interactions.
// =============================================================================

import { CascadingContext }             from './context/index.mjs';
import { DEFAULT_CONFIG, mergeConfig } from './config/index.mjs';
import { DEFAULT_MODELS }              from './models/index.mjs';
import { PluginLoader, FilesystemPluginProvider, InMemoryPluginProvider } from './plugin-loader/index.mjs';
import { PermissionEngine }  from './permissions/index.mjs';
import { HookRunner }        from './hooks/index.mjs';
import { PrimerAssembler }   from './primer/index.mjs';
import { mkdir }            from 'node:fs/promises';
import { join }             from 'node:path';
import { fileURLToPath }    from 'node:url';

export class KikxCore {
  constructor(config) {
    this._config     = mergeConfig(DEFAULT_CONFIG, config);
    this._context    = new CascadingContext(this._config);
    this._connection       = null;
    this._models           = null;
    this._started          = false;
    this._pluginLoader     = null;
    this._permissionEngine = null;

    // Store core reference on context
    this._context.setProperty('core', this);
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async start() {
    if (this._started)
      throw new Error('KikxCore is already started');

    // Initialize database connection
    await this._initializeDatabase();

    // Initialize permission engine (after DB, before plugins)
    this._permissionEngine = new PermissionEngine(this._context);
    this._context.setProperty('permissionEngine', this._permissionEngine);

    // Load plugins
    await this._loadPlugins();

    // Initialize primer assembler (after plugins, so plugin instructions are registered)
    let primerAssembler = new PrimerAssembler(this._context);
    this._context.setProperty('primerAssembler', primerAssembler);

    this._started = true;
  }

  async stop() {
    if (!this._started)
      return;

    // Teardown plugins (reverse order)
    if (this._pluginLoader) {
      let loaded = this._pluginLoader.getLoadedPlugins();
      for (let name of [...loaded].reverse())
        await this._pluginLoader.unloadPlugin(name);

      this._pluginLoader = null;
    }

    // Close database connection
    if (this._connection) {
      try {
        await this._connection.stop();
      } catch (error) {
        console.error('Database connection close error:', error);
      }

      this._connection = null;
    }

    this._models  = null;
    this._started = false;
  }

  // ---------------------------------------------------------------------------
  // Database
  // ---------------------------------------------------------------------------

  async _initializeDatabase() {
    let databaseConfig = this._config.database;

    if (!databaseConfig)
      throw new Error('Database configuration is required');

    // The connection class is provided by the embedder or defaults to SQLite
    let ConnectionClass = databaseConfig.ConnectionClass;

    if (!ConnectionClass) {
      // Default: dynamic import of mythix-orm-sqlite
      let sqliteModule = await import('mythix-orm-sqlite');
      ConnectionClass = sqliteModule.default
        ? sqliteModule.default.SQLiteConnection
        : sqliteModule.SQLiteConnection;
    }

    // Collect model classes
    let modelClasses = this._getModelClasses();

    // Create and start connection
    this._connection = new ConnectionClass({
      filename:                   databaseConfig.filename || ':memory:',
      emulateBigIntAutoIncrement: databaseConfig.emulateBigIntAutoIncrement !== false,
      foreignConstraints:         databaseConfig.foreignConstraints !== false,
      models:                     modelClasses,
      bindModels:                 true,
      logger:                     databaseConfig.logger || undefined,
    });

    await this._connection.start();

    // Create tables for all models
    let models = this._connection.getModels();
    for (let Model of Object.values(models)) {
      if (typeof Model.getTableName === 'function')
        await this._connection.createTable(Model, { ifNotExists: true });
    }

    // Store on context
    this._models = models;
    this._context.setProperty('models', models);
    this._context.setProperty('connection', this._connection);
  }

  _getModelClasses() {
    let configModels = this._config.models;
    let sourceModels;

    // If models explicitly provided, use those
    if (configModels) {
      if (typeof configModels === 'object' && !Array.isArray(configModels))
        sourceModels = Object.values(configModels);
      else
        sourceModels = configModels;
    } else {
      // Default: use all built-in models
      sourceModels = DEFAULT_MODELS;
    }

    // Create fresh subclasses so Mythix ORM binding doesn't mutate
    // the original model classes. This allows multiple KikxCore
    // instances (important for testing and embedded use).
    return sourceModels.map((ModelClass) => {
      let modelName = ModelClass.getModelName ? ModelClass.getModelName() : ModelClass.name;

      let BoundModel = {
        [modelName]: class extends ModelClass {
          static getModelName() {
            return modelName;
          }
        },
      }[modelName];

      // Copy static fields (which are own properties on the class)
      if (ModelClass.fields)
        BoundModel.fields = { ...ModelClass.fields };

      if (ModelClass.version !== undefined)
        BoundModel.version = ModelClass.version;

      return BoundModel;
    });
  }

  // ---------------------------------------------------------------------------
  // Accessors
  // ---------------------------------------------------------------------------

  getConfig() {
    return this._config;
  }

  getContext() {
    return this._context;
  }

  getConnection() {
    return this._connection;
  }

  getModels() {
    return this._models || {};
  }

  getModel(name) {
    let models = this.getModels();
    return models[name] || null;
  }

  isStarted() {
    return this._started;
  }

  getPermissionEngine() {
    return this._permissionEngine;
  }

  // ---------------------------------------------------------------------------
  // Plugin Loading
  // ---------------------------------------------------------------------------

  async _loadPlugins() {
    let config     = this._config;
    let pluginDirs = [];

    // 1. Internal plugins — relative to this source file
    let coreDir             = fileURLToPath(new URL('.', import.meta.url));
    let internalPluginsPath = join(coreDir, 'internal-plugins');
    pluginDirs.push(internalPluginsPath);

    // 2. External plugins from dataDirectory
    let dataDir = config.dataDirectory;
    if (dataDir) {
      let externalPluginsPath = join(dataDir, 'plugins');
      await mkdir(externalPluginsPath, { recursive: true });
      pluginDirs.push(externalPluginsPath);
    }

    // 3. Additional paths from config.plugins.paths
    let additionalPaths = (config.plugins && config.plugins.paths) || [];
    for (let p of additionalPaths)
      pluginDirs.push(p);

    // 4. Additional paths from KIKX_PLUGIN_PATHS environment variable
    let envPaths = process.env.KIKX_PLUGIN_PATHS;
    if (envPaths) {
      for (let p of envPaths.split(':').filter(Boolean))
        pluginDirs.push(p);
    }

    // Build disabled set
    let disabled = new Set((config.plugins && config.plugins.disabled) || []);

    // Create loader
    let loader   = new PluginLoader(this._context, { disabled });
    let provider = new FilesystemPluginProvider(pluginDirs);
    loader.addProvider(provider);

    // In-memory plugins (for testing)
    let modules = config.plugins && config.plugins.modules;
    if (modules) {
      let memProvider = new InMemoryPluginProvider(modules);
      loader.addProvider(memProvider);
    }

    await loader.loadAll();

    // Create hook runner from the registry
    let hookRunner = new HookRunner(loader.getRegistry());
    this._context.setProperty('hookRunner', hookRunner);

    this._pluginLoader = loader;
    this._context.setProperty('pluginLoader', loader);
    this._context.setProperty('pluginRegistry', loader.getRegistry());
  }

  // ---------------------------------------------------------------------------
  // Plugin Accessors
  // ---------------------------------------------------------------------------

  getAgentType(pluginID) {
    if (!this._pluginLoader)
      return null;

    return this._pluginLoader.getRegistry().getAgentType(pluginID);
  }

  getPluginRegistry() {
    if (!this._pluginLoader)
      return null;

    return this._pluginLoader.getRegistry();
  }

  getPluginLoader() {
    return this._pluginLoader;
  }
}
