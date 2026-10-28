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

export class PluginAuthority {
  constructor({ pluginId, db, logger = console } = {}) {
    if (!pluginId) throw new TypeError('PluginAuthority requires a pluginId');
    if (!db) throw new TypeError('PluginAuthority requires a scoped database handle');
    this.pluginId = pluginId;
    this.db = db;
    this.logger = logger;
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
      [actor, action, scope === null ? null : JSON.stringify(scope), grantedBy],
    );
    return true;
  }

  async revoke({ actor, action, scope = null }) {
    await this.db.query(
      `DELETE FROM miri_capability
        WHERE actor = $1 AND action = $2
          AND COALESCE(scope_json::text, '') = COALESCE($3, '')`,
      [actor, action, scope === null ? null : JSON.stringify(scope)],
    );
    return true;
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
