'use strict';

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

// Ordered, checksummed SQL migrations owned by plugins.
//
// Each plugin declares a directory of NNN-name.sql files. Applied versions are
// recorded in plugin_migrations with a checksum of the file as it was applied.
//
// If an applied migration's file later differs from its recorded checksum we REFUSE
// TO START. Someone edited history; re-running it and ignoring it are both worse than
// stopping with a message that names the file.
//
// Tables must carry the plugin's own prefix (<pluginId>_*). The prefix is a collision
// boundary inside a shared database, not a naming preference.

const MIGRATIONS_TABLE = 'plugin_migrations';
const FILE_PATTERN = /^(\d{3,})[-_].*\.sql$/i;

// This module speaks PostgreSQL SQL: pg_advisory_lock for the startup lock,
// TIMESTAMPTZ in the ledger, and the driver's own `Pool` for DDL. That is a real
// constraint, not an implementation detail, so it is declared rather than implied.
// A plugin may name the drivers it targets; anything else is reported as unsupported
// instead of being fed SQL its database cannot parse.
const SUPPORTED_DRIVERS = Object.freeze([ 'postgresql' ]);

// Mirrors the capability vocabulary on DatabaseConnectionBase so a plugin reads one
// shape whether it is asking about the document store or about migrations.
const MIGRATION_CAPABILITIES = Object.freeze({
  migrations: true,
  sql: true,
  transactions: true,
  advisoryLocks: true,
});

function checksum(sql) {
  return crypto.createHash('sha256').update(sql.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

function parseVersion(filename) {
  let match = FILE_PATTERN.exec(filename);
  return match ? Number(match[1]) : null;
}

function tablesCreatedBy(sql) {
  let names = [];
  let re = /create\s+table\s+(?:if\s+not\s+exists\s+)?["'`]?([a-z0-9_.]+)["'`]?/gi;
  let m;
  while ((m = re.exec(sql)) !== null) names.push(m[1].toLowerCase());
  return names;
}

// The document-store driver (src/core/database/postgresql-connection.mjs) exposes a
// document API, not a SQL client: `query` rejects anything without a `where`. DDL is
// therefore impossible through it, so migrations own a plain pg pool built from the
// same connection URL.
export class PluginMigrations {
  static driverID = 'postgresql';
  static capabilities = MIGRATION_CAPABILITIES;

  constructor(options = {}) {
    this.plugins = new Map();
    this.logger = options.logger || console;
    this.pool = null;
    // The URL is supplied by the caller. Reading process.env here would bypass the
    // config module, which the architecture spec forbids outside src/core/config.
    this.url = options.url || null;  // required; supplied by the caller
    // Defaults to postgresql because that is what the code below actually executes.
    // A caller that names any other driver gets a refusal, not silently misapplied SQL.
    this.driver = options.driver || PluginMigrations.driverID;
    if (!SUPPORTED_DRIVERS.includes(this.driver)) {
      throw new Error(
        `plugin migrations do not support driver "${this.driver}"; `
        + `supported drivers: ${SUPPORTED_DRIVERS.join(', ')}`,
      );
    }
  }

  supports(capability) {
    return this.constructor.capabilities?.[capability] === true;
  }

  requireCapability(capability) {
    if (!this.supports(capability))
      throw new Error(`plugin migrations do not support capability: ${capability}`);
  }

  describe() {
    return {
      driverID: this.driver,
      capabilities: { ...this.constructor.capabilities },
      plugins: [ ...this.plugins.keys() ],
    };
  }

  async getPool() {
    if (this.pool) return this.pool;
    if (!this.url)
      throw new Error('plugin migrations require a database url');
    let { Pool } = await import('pg');
    this.pool = new Pool({ connectionString: this.url });
    return this.pool;
  }

  async close() {
    if (this.pool) { await this.pool.end(); this.pool = null; }
  }

  register(pluginId, { directory, allowUnprefixed = false, drivers = null } = {}) {
    if (typeof pluginId !== 'string' || !pluginId.trim())
      throw new TypeError('registerMigrations requires a plugin id');
    if (typeof directory !== 'string' || !directory)
      throw new TypeError('registerMigrations requires a directory');
    let existing = this.plugins.get(pluginId);
    if (existing) {
      // A reload re-registers what boot already registered. Same directory means the
      // same migrations, so this is idempotent; a different directory is a real conflict.
      if (existing.directory === directory) return true;
      throw new TypeError(
        `migrations already registered for "${pluginId}" from ${existing.directory}, `
        + `cannot re-register from ${directory}`,
      );
    }
    // A plugin that names drivers is declaring where its SQL may run. One that names
    // none is assumed portable, which keeps every existing plugin working unchanged.
    let targets = null;
    if (drivers != null) {
      if (!Array.isArray(drivers) || !drivers.length || drivers.some((d) => typeof d !== 'string' || !d.trim()))
        throw new TypeError(`registerMigrations drivers for "${pluginId}" must be a non-empty array of driver ids`);
      targets = drivers.map((d) => d.trim().toLowerCase());
    }
    this.plugins.set(pluginId, { directory, allowUnprefixed, drivers: targets });
    return true;
  }

  // Forget a plugin's migration directory without touching what was applied. The
  // ledger rows stay: they record that the schema exists, and re-applying them on a
  // later reload is exactly what the checksums are there to prevent. Only the claim
  // on the directory is released, so a different plugin may register it.
  unregister(pluginId) {
    return this.plugins.delete(pluginId);
  }

  async loadFiles(pluginId) {
    let entry = this.plugins.get(pluginId);
    if (!entry) throw new Error(`no migrations registered for "${pluginId}"`);

    let names = [];
    try {
      names = await fs.readdir(entry.directory);
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }

    let files = [];
    for (let name of names.sort()) {
      let version = parseVersion(name);
      if (version === null) continue;
      let full = path.join(entry.directory, name);
      let sql = await fs.readFile(full, 'utf8');
      files.push({ version, name, sql, checksum: checksum(sql) });
    }

    files.sort((a, b) => a.version - b.version);

    let seen = new Set();
    for (let file of files) {
      if (seen.has(file.version))
        throw new Error(`plugin "${pluginId}" has two migrations numbered ${file.version}`);
      seen.add(file.version);
    }

    return files;
  }

  validatePrefix(pluginId, file) {
    let entry = this.plugins.get(pluginId);
    if (entry?.allowUnprefixed) return;
    let expected = `${pluginId}_`;
    for (let table of tablesCreatedBy(file.sql)) {
      let bare = table.includes('.') ? table.split('.').pop() : table;
      if (bare === MIGRATIONS_TABLE) continue;
      if (!bare.startsWith(expected.toLowerCase())) {
        throw new Error(
          `plugin "${pluginId}" migration ${file.name} creates table "${table}", `
          + `which does not carry the "${expected}" prefix`,
        );
      }
    }
  }

  // Whether this plugin's declared driver targets include the driver in use. A plugin
  // with no declaration is assumed portable.
  supportsPlugin(pluginId) {
    let entry = this.plugins.get(pluginId);
    if (!entry) return false;
    if (!entry.drivers) return true;
    return entry.drivers.includes(this.driver);
  }

  getUnsupportedPlugins() {
    let unsupported = [];
    for (let id of this.plugins.keys()) {
      if (!this.supportsPlugin(id))
        unsupported.push({ pluginId: id, drivers: this.plugins.get(id).drivers });
    }
    return unsupported;
  }

  async run(options = {}) {
    let logger = options.logger || this.logger;
    this.applied = [];

    // Nothing registered means nothing to do. This is the common case for a server
    // started without plugins, including most tests.
    if (!this.plugins.size)
      return { skipped: true, reason: 'no plugins registered migrations' };

    // Resolve the driver before touching a connection. A plugin whose SQL targets a
    // different database is skipped *by name*, never executed on a guess: running
    // PostgreSQL DDL against another driver fails obscurely, half-applied.
    let runnable = [ ...this.plugins.keys() ].filter((pluginId) => this.supportsPlugin(pluginId));
    let unsupported = this.getUnsupportedPlugins();
    for (let entry of unsupported) {
      logger?.warn?.(
        `[plugin-migrations] ${entry.pluginId} declares drivers ${entry.drivers.join(', ')}, `
        + `but this instance runs "${this.driver}"; skipping its migrations`,
      );
    }

    // No url means the caller has no database to migrate. Skipping with a warning is
    // correct here: refusing would make every plugin-less or database-less boot fail,
    // and an actual migration error is still fatal. This is checked before the
    // driver-target branch because "there is no database" is the more fundamental
    // missing precondition: reporting a driver mismatch when no database exists at all
    // would point an operator at the wrong setting.
    if (!this.url) {
      logger?.warn?.('[plugin-migrations] no database url supplied; skipping migrations');
      return { skipped: true, reason: 'no database url', driver: this.driver, unsupported };
    }

    if (!runnable.length) {
      return {
        skipped: true,
        reason: `no registered plugin targets driver "${this.driver}"`,
        driver: this.driver,
        unsupported,
      };
    }

    let connection = await this.getPool();

    // The ledger table itself must be created under a lock. PostgreSQL's
    // CREATE TABLE IF NOT EXISTS is not atomic across concurrent sessions: two processes
    // starting together race on pg_type and one fails with a duplicate-key error. The
    // per-plugin locks below come too late to protect this.
    await connection.query('SELECT pg_advisory_lock(hashtext($1))', ['plugin_migrations:ledger']);
    try {
      await connection.query(`
        CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
          plugin_id   TEXT        NOT NULL,
          version     INTEGER     NOT NULL,
          name        TEXT        NOT NULL,
          checksum    TEXT        NOT NULL,
          applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (plugin_id, version)
        )`);
    } finally {
      await connection.query('SELECT pg_advisory_unlock(hashtext($1))', ['plugin_migrations:ledger']);
    }

    for (let pluginId of runnable) {
      // Serialise concurrent startups against the same database.
      await connection.query('SELECT pg_advisory_lock(hashtext($1))', [`plugin_migrations:${pluginId}`]);
      try {
        await this.#runPlugin(connection, pluginId, logger);
      } finally {
        await connection.query('SELECT pg_advisory_unlock(hashtext($1))', [`plugin_migrations:${pluginId}`]);
      }
    }

    return { skipped: false, driver: this.driver, applied: this.applied.slice(), unsupported };
  }

  async #runPlugin(connection, pluginId, logger) {
    let files = await this.loadFiles(pluginId);
    let applied = await connection.query(
      `SELECT version, name, checksum FROM ${MIGRATIONS_TABLE} WHERE plugin_id = $1 ORDER BY version`,
      [pluginId],
    );

    let byVersion = new Map(applied.rows.map((r) => [Number(r.version), r]));

    for (let row of applied.rows) {
      let file = files.find((f) => f.version === Number(row.version));
      if (!file) {
        throw new Error(
          `plugin "${pluginId}" has migration ${row.version} recorded as applied (${row.name}) `
          + 'but the file is missing. Restore it or write a new migration.',
        );
      }
      if (file.checksum !== row.checksum) {
        throw new Error(
          `plugin "${pluginId}" migration ${file.name} changed after it was applied. `
          + `Recorded ${row.checksum.slice(0, 12)}, found ${file.checksum.slice(0, 12)}. `
          + 'Applied migrations are immutable; write a new migration instead.',
        );
      }
    }

    for (let file of files) {
      if (byVersion.has(file.version)) continue;
      this.validatePrefix(pluginId, file);
      this.applied.push(`${pluginId}:${file.name}`);

      await connection.query('BEGIN');
      try {
        await connection.query(file.sql);
        await connection.query(
          `INSERT INTO ${MIGRATIONS_TABLE} (plugin_id, version, name, checksum) VALUES ($1, $2, $3, $4)`,
          [pluginId, file.version, file.name, file.checksum],
        );
        await connection.query('COMMIT');
        logger?.info?.(`[plugin-migrations] ${pluginId} applied ${file.name}`);
      } catch (error) {
        await connection.query('ROLLBACK');
        throw new Error(`plugin "${pluginId}" migration ${file.name} failed: ${error.message}`);
      }
    }
  }
}

let defaultMigrations = null;

export function getPluginMigrations(options = {}) {
  if (!defaultMigrations) defaultMigrations = new PluginMigrations(options);
  return defaultMigrations;
}

export function resetPluginMigrations() {
  defaultMigrations = null;
}
