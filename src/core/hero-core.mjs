'use strict';

// =============================================================================
// HeroCore
// =============================================================================
// Embeddable core engine with zero HTTP dependencies.
// Manages database, models, plugins, sessions, interactions.
// =============================================================================

import { CascadingContext }             from './context/index.mjs';
import { DEFAULT_CONFIG, mergeConfig } from './config/index.mjs';
import { DEFAULT_MODELS }              from './models/index.mjs';

export class HeroCore {
  constructor(config) {
    this._config     = mergeConfig(DEFAULT_CONFIG, config);
    this._context    = new CascadingContext(this._config);
    this._connection = null;
    this._models     = null;
    this._started    = false;
    this._plugins    = new Map();

    // Store core reference on context
    this._context.setProperty('core', this);
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async start() {
    if (this._started)
      throw new Error('HeroCore is already started');

    // Initialize database connection
    await this._initializeDatabase();

    this._started = true;
  }

  async stop() {
    if (!this._started)
      return;

    // Teardown plugins (call teardown closures in reverse order)
    let pluginNames = Array.from(this._plugins.keys()).reverse();
    for (let name of pluginNames) {
      let plugin = this._plugins.get(name);
      if (typeof plugin.teardown === 'function') {
        try {
          await plugin.teardown();
        } catch (error) {
          // Log but don't throw during teardown
          console.error(`Plugin teardown error (${name}):`, error);
        }
      }
    }

    this._plugins.clear();

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
        await this._connection.createTable(Model);
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
    // the original model classes. This allows multiple HeroCore
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

  // ---------------------------------------------------------------------------
  // Plugin Management (skeleton — full implementation in Wave K, Step 41)
  // ---------------------------------------------------------------------------

  registerPlugin(name, plugin) {
    if (this._plugins.has(name))
      console.warn(`Plugin "${name}" is being overridden`);

    this._plugins.set(name, plugin);
  }

  getPlugin(name) {
    return this._plugins.get(name) || null;
  }

  getPlugins() {
    return new Map(this._plugins);
  }
}
