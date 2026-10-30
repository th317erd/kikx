'use strict';

// PluginAuthority: the scoped-revoke contract.
//
// Why this file exists
// --------------------
// revoke() used to build its DELETE on
//   COALESCE(scope_json::text,'') = COALESCE($3,'')
// which can never match a scoped grant: PostgreSQL renders JSONB with a space after
// each colon ({"channel": "probe"}) while JSON.stringify produces none
// ({"channel":"probe"}). Scoped revocation therefore deleted nothing and returned
// true. Reproduced against a live database before the fix, and again after.
//
// Postgres is not required here. The fake database below behaves like the one real
// behaviour this contract depends on: the caller's scope parameter arrives as a JSON
// *string*, while the stored column is JSONB. The fake fails the comparison unless the
// SQL asks for JSONB identity, so a regression to ::text comparison fails the spec.

import assert from 'node:assert/strict';
import test from 'node:test';

import { PluginAuthority } from '../../../src/core/plugins/plugin-authority.mjs';

// Mimics `scope_json <op> $n::jsonb` semantics: the parameter is parsed as JSON, so
// formatting differences do not matter. Returns the rows that match.
function fakeDatabase(rows, { jsonb = true } = {}) {
  return {
    calls: [],
    async many(sql) {
      this.calls.push(sql);
      return rows;
    },
    async query(sql, params = []) {
      this.calls.push(sql);
      if (!/^\s*DELETE/i.test(sql)) return { rowCount: 0, rows: [] };

      const [ actor, action, scopeParam ] = params;
      const matches = (row) => {
        if (row.actor !== actor || row.action !== action) return false;
        if (row.scope_json === null) return scopeParam === null || scopeParam === undefined;
        if (scopeParam === null || scopeParam === undefined) return false;
        if (!jsonb) {
          // The old ::text comparison: string vs the way Postgres renders JSONB.
          return String(row.scope_json) === String(scopeParam);
        }
        return JSON.stringify(row.scope_json) === JSON.stringify(JSON.parse(scopeParam));
      };

      const kept = rows.filter((row) => !matches(row));
      const deleted = rows.length - kept.length;
      rows.length = 0;
      rows.push(...kept);
      return { rowCount: deleted, rows: [] };
    },
  };
}

test('scoped revoke deletes the matching grant and reports deleted=1', async () => {
  const rows = [ { actor: 'miri', action: 'discord.send', scope_json: { channel: 'probe' } } ];
  const db = fakeDatabase(rows);
  const authority = new PluginAuthority({ pluginId: 'miri', db, logger: console });

  const result = await authority.revoke({ actor: 'miri', action: 'discord.send', scope: { channel: 'probe' } });

  assert.equal(result.deleted, 1);
  assert.equal(result.revoked, true);
  assert.equal(rows.length, 0, 'the row must actually be gone');
  assert.match(result.note, /removed/i);
});

test('the DELETE compares scope by JSONB identity, not by ::text', async () => {
  const db = fakeDatabase([]);
  const authority = new PluginAuthority({ pluginId: 'miri', db, logger: console });

  await authority.revoke({ actor: 'miri', action: 'discord.send', scope: { channel: 'probe' } });

  const deleteSql = db.calls.find((sql) => /^\s*DELETE/i.test(sql));
  assert.ok(deleteSql, 'revoke must issue a DELETE');
  assert.match(deleteSql, /IS NOT DISTINCT FROM\s+\$\d+::jsonb/i);
  assert.doesNotMatch(deleteSql, /COALESCE\s*\(\s*scope_json::text/i);
});

test('a revoke that matches nothing says so instead of claiming success', async () => {
  const db = fakeDatabase([]);
  const authority = new PluginAuthority({ pluginId: 'miri', db, logger: console });

  const result = await authority.revoke({ actor: 'miri', action: 'discord.send', scope: { channel: 'probe' } });

  assert.equal(result.deleted, 0);
  assert.equal(result.revoked, false);
  assert.match(result.note, /nothing was revoked/i);
});

test('the pre-fix ::text comparison is what made scoped revoke fail', async () => {
  // Guards the diagnosis, not the fix: if someone reverts the SQL, the real comparison
  // is just as broken as this simulation of it.
  const rows = [ { actor: 'miri', action: 'discord.send', scope_json: { channel: 'probe' } } ];
  const db = fakeDatabase(rows, { jsonb: false });
  const authority = new PluginAuthority({ pluginId: 'miri', db, logger: console });

  const result = await authority.revoke({ actor: 'miri', action: 'discord.send', scope: { channel: 'probe' } });

  assert.equal(result.deleted, 0, 'formatting defeats a string comparison - this is the bug');
  assert.equal(rows.length, 1, 'and the capability survives, unrevokable');
});

test('unscoped revoke targets the NULL-scope row only', async () => {
  const rows = [
    { actor: 'miri', action: 'system.run', scope_json: null },
    { actor: 'miri', action: 'system.run', scope_json: { host: 'x' } },
  ];
  const db = fakeDatabase(rows);
  const authority = new PluginAuthority({ pluginId: 'miri', db, logger: console });

  const result = await authority.revoke({ actor: 'miri', action: 'system.run' });

  assert.equal(result.deleted, 1);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].scope_json, { host: 'x' }, 'the scoped grant must survive an unscoped revoke');
});

test('revoke requires actor and action rather than silently doing nothing', async () => {
  const db = fakeDatabase([]);
  const authority = new PluginAuthority({ pluginId: 'miri', db, logger: console });

  await assert.rejects(() => authority.revoke({ action: 'discord.send' }), /requires actor and action/);
  await assert.rejects(() => authority.revoke({ actor: 'miri' }), /requires actor and action/);
});

test('authorize stays deny-by-default for an empty scope request', async () => {
  const db = fakeDatabase([]);
  const authority = new PluginAuthority({ pluginId: 'miri', db, logger: console });

  const result = await authority.authorize({ actor: 'miri', action: 'discord.send', scope: {} });

  assert.equal(result.allowed, false);
  assert.match(result.reason, /no grant/i);
});

test('authorize matches a grant by its scope keys, not by their formatting', async () => {
  const db = fakeDatabase([
    { action: 'discord.send', scope_json: { channel: 'probe' } },
  ]);
  const authority = new PluginAuthority({ pluginId: 'miri', db, logger: console });

  assert.equal((await authority.authorize({ actor: 'miri', action: 'discord.send', scope: { channel: 'probe' } })).allowed, true);
  assert.equal((await authority.authorize({ actor: 'miri', action: 'discord.send', scope: { channel: 'other' } })).allowed, false);
});

test('an unscoped grant allows any scope - null means no narrowing', async () => {
  const db = fakeDatabase([
    { action: 'system.run', scope_json: null },
  ]);
  const authority = new PluginAuthority({ pluginId: 'miri', db, logger: console });

  assert.equal((await authority.authorize({ actor: 'miri', action: 'system.run', scope: { anything: 'x' } })).allowed, true);
});
