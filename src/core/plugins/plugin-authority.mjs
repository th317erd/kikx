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
// (miri_capability_unique ON (actor, action, COALESCE(scope_json::text, ''))).
// ---------------------------------------------------------------------------

export class PluginAuthority {
  constructor({ pluginId, db, logger = console } = {}) {
    if (!pluginId) throw new TypeError('PluginAuthority requires a pluginId');
    if (!db) throw new TypeError('PluginAuthority requires a scoped database handle');
    this.pluginId = pluginId;
    this.db = db;
    this.logger = logger;
  }

  // null/undefined means "no narrowing", which must reach SQL as NULL rather than 'null'.
  #scopeParam(scope) {
    return scope === null || scope === undefined ? null : JSON.stringify(scope);
  }

  async listGrants(actor) {
    let rows = await this.db.many(
      'SELECT actor, action, scope_json, granted_at FROM miri_capability WHERE actor = $1 ORDER BY action',
      [actor],
    );
    return rows;
  }

  async grant({ actor, action, scope = null, grantedBy = null }) {
    if (!actor || !action) throw new TypeError('grant requires actor and action');
    await this.db.query(
      `INSERT INTO miri_capability (actor, action, scope_json, granted_by)
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
      `DELETE FROM miri_capability
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
      'SELECT action, scope_json FROM miri_capability WHERE actor = $1 AND action = $2',
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
}
