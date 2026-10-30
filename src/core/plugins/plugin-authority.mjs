'use strict';

// Capability checks for plugin actions.
//
// Kikx's own auth is human auth: sessions, magic links, API keys. It has no notion of
// "may this actor perform this action in this scope", which is what a transport plugin
// needs before it sends anything anywhere.
//
// Deny by default. A grant must exist, match the action exactly, and match every key in
// the request's scope. No grant means no. A plugin cannot decide its own permissions by
// reading its own config - the table is the single source.
//
// ---------------------------------------------------------------------------
// TABLE NAMING - the table belongs to the plugin, not to Miri.
//
// This class used to inline the literal table name `miri_capability` in every statement,
// which made it Miri-only by construction: `PluginDatabase` permits a plugin to touch
// only `<pluginId>_*` tables, so any plugin not named `miri` had its authority queries
// rejected by its own scoped handle. The table is now derived from the plugin id:
//
//     pluginId 'miri'  ->  miri_capability   (byte-identical to the historical name)
//     pluginId 'acme'  ->  acme_capability
//
// Miri therefore keeps its existing table, its existing migration and its existing rows;
// no data migration is involved. The derived name also satisfies both prefix rules that
// already exist elsewhere in the platform: `PluginDatabase` allows `<pluginId>_*`, and
// `PluginMigrations.validatePrefix` refuses to create anything that is not `<pluginId>_*`.
//
// A plugin whose table is already named differently can pass `tableName` explicitly. The
// id is validated rather than interpolated: the plugin id arrives from a plugin-declared
// `pluginName`, so it is untrusted text on its way into SQL.
// ---------------------------------------------------------------------------
// SCOPE COMPARISON - read this before changing any predicate here.
//
// `scope_json::text` is NOT the JSON that was passed in. PostgreSQL renders JSONB with
// a space after each colon:
//
//     JSON.stringify({channel:'probe'})  ->  {"channel":"probe"}    len 19
//     scope_json::text                   ->  {"channel": "probe"}   len 20
//
// So a predicate of the form `COALESCE(scope_json::text,'') = COALESCE($n,'')` never
// matches a scoped grant, and a DELETE built on it removes nothing while reporting
// success. That was a real bug in revoke(): a capability could be granted and never
// taken away. It was reproduced against a live database before this fix - scoped
// revoke left the row in place and returned true.
//
// Comparison is therefore by JSONB identity - `scope_json IS NOT DISTINCT FROM $n::jsonb`
// - which is format-insensitive and NULL-safe in one operator.
//
// The COALESCE(...::text) form is kept ONLY inside the ON CONFLICT target, where it must
// textually match the unique index expression
// (<pluginId>_capability_unique ON (actor, action, COALESCE(scope_json::text, ''))).
// ---------------------------------------------------------------------------

// Table-safe and prefix-safe: lowercase, leading letter, then word characters. Rejects
// anything that could terminate or comment out the statement.
const TABLE_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

export class PluginAuthority {
  constructor({ pluginId, db, logger = console, tableName = null } = {}) {
    if (!pluginId) throw new TypeError('PluginAuthority requires a pluginId');
    if (!db) throw new TypeError('PluginAuthority requires a scoped database handle');
    this.pluginId = pluginId;
    this.db = db;
    this.logger = logger;

    // The table is plugin-owned. See TABLE NAMING above.
    let prefix = `${String(pluginId).toLowerCase()}_`;
    let table = tableName || `${prefix}capability`;
    if (!TABLE_NAME_PATTERN.test(table)) {
      // A hyphenated plugin id lands here ("todo-focus-index_capability"). The scoped
      // database handle cannot express such a table name either, so refusing loudly is
      // the honest option: silently generating SQL the handle would reject anyway only
      // moves the failure further from its cause.
      throw new TypeError(
        `PluginAuthority: "${table}" is not a usable table name; it must match `
        + `${TABLE_NAME_PATTERN} (lowercase, leading letter, then letters, digits or underscores)`,
      );
    }
    if (!table.startsWith(prefix)) {
      throw new TypeError(
        `PluginAuthority: table "${table}" is outside plugin "${pluginId}"; the scoped `
        + `database handle only permits tables beginning "${prefix}"`,
      );
    }
    this.tableName = table;
  }

  // null/undefined means "no narrowing", which must reach SQL as NULL rather than 'null'.
  #scopeParam(scope) {
    return scope === null || scope === undefined ? null : JSON.stringify(scope);
  }

  async listGrants(actor) {
    let rows = await this.db.many(
      `SELECT actor, action, scope_json, granted_at FROM ${this.tableName} WHERE actor = $1 ORDER BY action`,
      [actor],
    );
    return rows;
  }

  async grant({ actor, action, scope = null, grantedBy = null }) {
    if (!actor || !action) throw new TypeError('grant requires actor and action');
    await this.db.query(
      `INSERT INTO ${this.tableName} (actor, action, scope_json, granted_by)
       VALUES ($1, $2, $3::jsonb, $4)
       ON CONFLICT (actor, action, COALESCE(scope_json::text, '')) DO UPDATE
         SET granted_at = now(), granted_by = EXCLUDED.granted_by`,
      [actor, action, this.#scopeParam(scope), grantedBy],
    );
    return true;
  }

  // Removes exactly one grant and reports whether a row was actually deleted.
  //
  // This used to `return true` unconditionally, which made a revoke that matched
  // nothing indistinguishable from a revoke that worked - the silent-success shape this
  // codebase keeps producing. Callers must now read `deleted`.
  async revoke({ actor, action, scope = null }) {
    if (!actor || !action) throw new TypeError('revoke requires actor and action');

    let result = await this.db.query(
      `DELETE FROM ${this.tableName}
        WHERE actor = $1 AND action = $2
          AND scope_json IS NOT DISTINCT FROM $3::jsonb`,
      [actor, action, this.#scopeParam(scope)],
    );

    let deleted = result?.rowCount ?? 0;
    return {
      actor,
      action,
      scope: scope ?? null,
      deleted,
      revoked: deleted > 0,
      note: deleted === 0
        ? 'No matching grant existed; nothing was revoked.'
        : 'Grant removed.',
    };
  }

  // The check every transport must make before acting.
  async authorize({ actor, action, scope = {} } = {}) {
    if (!actor || !action) {
      return { allowed: false, reason: 'authorize requires actor and action' };
    }

    let grants = await this.db.many(
      `SELECT action, scope_json FROM ${this.tableName} WHERE actor = $1 AND action = $2`,
      [actor, action],
    );

    if (!grants.length)
      return { allowed: false, reason: `no grant for ${action}` };

    for (let grant of grants) {
      let required = grant.scope_json || null;
      if (!required) return { allowed: true, grant };
      let matches = Object.entries(required).every(([k, v]) => String(scope[k]) === String(v));
      if (matches) return { allowed: true, grant };
    }

    return {
      allowed: false,
      reason: `grant exists for ${action} but its scope does not match the request`,
      requested: scope,
    };
  }

  describe() {
    return { pluginId: this.pluginId, tableName: this.tableName };
  }
}
