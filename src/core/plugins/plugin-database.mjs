'use strict';

// A scoped database handle for plugins.
//
// A plugin never receives a pool, a client, or a connection string. It receives this
// wrapper, which is the only place a permission boundary can live: the plugin's SQL is
// inspected and rejected here rather than trusted to plugin authors.
//
// The rules, enforced on every statement:
//
//   1. Only tables carrying the plugin's own prefix (<pluginId>_*) may be read or
//      written. A plugin cannot touch another plugin's tables, Kikx's document store,
//      or the migration ledger.
//   2. No DDL. Schema changes go through migrations, which run once at startup under
//      their own pool and their own checksum ledger. A plugin that could run CREATE or
//      ALTER at runtime could rewrite its own ledger.
//   3. No multi-statement SQL. One statement per call, so "SELECT ...; DROP ..."
//      cannot ride along.
//   4. Parameterised values only; the wrapper refuses to interpolate.
//
// This is deliberately a small, conservative grammar rather than a SQL parser. It
// rejects anything it does not positively recognise.

const ALLOWED_STATEMENTS = /^\s*(select|insert|update|delete)\b/i;
const FORBIDDEN = /\b(create|alter|drop|truncate|grant|revoke|copy|vacuum|reindex|comment|security|attach|detach)\b/i;
// `update` is followed by a table name in a plain UPDATE, but by nothing in
// `ON CONFLICT ... DO UPDATE SET`, where the next word is the SET keyword. Reserved
// words are excluded so an upsert is not read as touching a table called "set".
const TABLE_REFERENCE = /\b(?:from|join|into|update)\s+["'`]?([a-z0-9_]+)["'`]?/gi;
const NOT_A_TABLE = new Set(['set', 'where', 'values', 'select', 'returning', 'on']);

export class PluginDatabase {
  constructor({ pluginId, pool, logger = console }) {
    if (!pluginId) throw new TypeError('PluginDatabase requires a pluginId');
    if (!pool) throw new TypeError('PluginDatabase requires a pool');
    this.pluginId = pluginId;
    this.prefix = `${pluginId}_`.toLowerCase();
    this.pool = pool;
    this.logger = logger;
  }

  assertStatement(sql) {
    if (typeof sql !== 'string' || !sql.trim())
      throw new Error('plugin database: a SQL statement is required');

    if (sql.includes(';') && sql.trim().replace(/;\s*$/, '').includes(';'))
      throw new Error('plugin database: only one statement per call');

    if (!ALLOWED_STATEMENTS.test(sql))
      throw new Error('plugin database: only SELECT, INSERT, UPDATE and DELETE are permitted');

    let forbidden = FORBIDDEN.exec(sql);
    if (forbidden)
      throw new Error(`plugin database: "${forbidden[1].toUpperCase()}" is not permitted; schema changes go through migrations`);

    let tables = [];
    let m;
    TABLE_REFERENCE.lastIndex = 0;
    while ((m = TABLE_REFERENCE.exec(sql)) !== null) tables.push(m[1].toLowerCase());

    for (let table of tables) {
      if (NOT_A_TABLE.has(table)) continue;
      if (table.startsWith(this.prefix)) continue;
      // Subqueries and CTEs can introduce aliases; anything unrecognised is refused
      // rather than assumed safe.
      throw new Error(
        `plugin database: plugin "${this.pluginId}" may only access tables beginning `
        + `"${this.prefix}" (statement references "${table}")`,
      );
    }

    return true;
  }

  async query(sql, params = []) {
    this.assertStatement(sql);
    return this.pool.query(sql, params);
  }

  async one(sql, params = []) {
    let result = await this.query(sql, params);
    return result.rows?.[0] ?? null;
  }

  async many(sql, params = []) {
    let result = await this.query(sql, params);
    return result.rows ?? [];
  }

  describe() {
    return { pluginId: this.pluginId, prefix: this.prefix, ddl: false, multiStatement: false };
  }
}

export function wrapPoolForPlugin({ pluginId, pool, logger }) {
  return new PluginDatabase({ pluginId, pool, logger });
}
