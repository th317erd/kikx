'use strict';

// PluginAuthority: the table belongs to the plugin that owns it.
//
// Why this file exists
// --------------------
// PluginAuthority used to inline the literal table name `miri_capability` in all five of
// its statements. Meanwhile PluginDatabase - the scoped handle every plugin is given, and
// the only handle a plugin is given - refuses any statement that touches a table outside
// `<pluginId>_*`. So a plugin named anything other than `miri` had every authority query
// rejected by its own database handle: the capability system could not be used by a
// generic plugin at all. That is the defect this contract locks down.
//
// It is not enough to assert that the class now produces a differently-spelled string.
// The two components have to agree, so this spec cross-checks the SQL PluginAuthority
// generates against the *real* PluginDatabase statement guard rather than against a
// hand-written expectation. A rename that still fails the guard fails here.

import assert from 'node:assert/strict';
import test from 'node:test';

import { PluginAuthority } from '../../../src/core/plugins/plugin-authority.mjs';
import { PluginDatabase } from '../../../src/core/plugins/plugin-database.mjs';

// Records the SQL it is handed, and applies the two filters `authorize()` relies on so a
// row for one action is not returned when another action is asked for.
// The interesting assertion in this file is whether the SQL would be *permitted*, and the
// real PluginDatabase below answers that.
function recordingDatabase(rows = []) {
  return {
    calls: [],
    async many(sql, params = []) {
      this.calls.push({ sql, params });
      if (!/^\s*SELECT/i.test(sql)) return rows;
      // SELECT … WHERE actor = $1 AND action = $2  |  WHERE actor = $1 ORDER BY action
      const [ actor, action ] = params;
      return rows.filter((row) => row.actor === actor && (action === undefined || row.action === action));
    },
    async query(sql, params = []) {
      this.calls.push({ sql, params });
      return { rowCount: 0, rows: [] };
    },
  };
}

function scopedHandle(pluginId) {
  return new PluginDatabase({ pluginId, pool: { query: async () => ({ rows: [] }) } });
}

// Every statement the class can issue, for one plugin id.
async function allStatementsFor(pluginId) {
  const db = recordingDatabase();
  const authority = new PluginAuthority({ pluginId, db });
  await authority.listGrants('someone');
  await authority.grant({ actor: 'someone', action: 'thing.do' });
  await authority.revoke({ actor: 'someone', action: 'thing.do' });
  await authority.authorize({ actor: 'someone', action: 'thing.do' });
  return db.calls.map((call) => call.sql);
}

test('the table is derived from the plugin id', () => {
  const db = recordingDatabase();
  assert.equal(new PluginAuthority({ pluginId: 'miri', db }).tableName, 'miri_capability');
  assert.equal(new PluginAuthority({ pluginId: 'acme', db }).tableName, 'acme_capability');
  assert.equal(new PluginAuthority({ pluginId: 'AcMe', db }).tableName, 'acme_capability');
});

test('Miri keeps the historical table name, so no migration is implied', async () => {
  const statements = await allStatementsFor('miri');
  assert.ok(statements.length >= 4, 'all four operations must issue SQL');
  for (const sql of statements) assert.match(sql, /\bmiri_capability\b/);
});

test('a second plugin gets its own table and never touches miri_capability', async () => {
  const statements = await allStatementsFor('acme');
  for (const sql of statements) {
    assert.match(sql, /\bacme_capability\b/, 'must address the plugin-owned table');
    assert.doesNotMatch(sql, /\bmiri_capability\b/, 'must not reach into Miri\'s grants');
  }
});

test('every generated statement is accepted by the real scoped database handle', async () => {
  // This is the cross-component half: it is what proves the fix, not the rename.
  for (const pluginId of ['acme', 'miri', 'other_plugin']) {
    const handle = scopedHandle(pluginId);
    for (const sql of await allStatementsFor(pluginId)) {
      assert.doesNotThrow(
        () => handle.assertStatement(sql),
        `plugin "${pluginId}" must be able to run its own authority SQL: ${sql}`,
      );
    }
  }
});

test('the literal-name version is what the scoped handle rejects - the original defect', () => {
  // Guards the diagnosis. If a hardcoded name came back, the real handle would refuse it
  // for every plugin except the one whose name it hardcodes.
  const handle = scopedHandle('acme');
  assert.throws(
    () => handle.assertStatement('SELECT action FROM miri_capability WHERE actor = $1'),
    /acme_/,
    'a hardcoded miri_capability must be refused for a plugin named acme',
  );
});

test('the table is still the right shape where the guard cannot help', async () => {
  // The handle allows any prefix-matching table, so the upsert target and the unique-index
  // expression are not covered by the guard above. They must still name the owned table.
  const statements = await allStatementsFor('acme');
  const insert = statements.find((sql) => /^\s*INSERT/i.test(sql));
  assert.ok(insert, 'grant must issue an INSERT');
  assert.match(insert, /INSERT INTO acme_capability\b/);
  assert.match(insert, /ON CONFLICT \(actor, action, COALESCE\(scope_json::text, ''\)\)/);
  assert.match(insert, /EXCLUDED\.granted_by/);
});

test('an explicit table name is honoured only inside the plugin prefix', () => {
  const db = recordingDatabase();
  const renamed = new PluginAuthority({ pluginId: 'acme', db, tableName: 'acme_permissions' });
  assert.equal(renamed.tableName, 'acme_permissions');

  assert.throws(
    () => new PluginAuthority({ pluginId: 'acme', db, tableName: 'miri_capability' }),
    /outside plugin "acme"/,
  );
  assert.throws(
    () => new PluginAuthority({ pluginId: 'acme', db, tableName: 'capability' }),
    /outside plugin "acme"/,
  );
});

test('a plugin id that cannot form a table name is refused rather than interpolated', () => {
  const db = recordingDatabase();
  // Hyphens are legal in a plugin name (both in-repo plugins are named this way), but they
  // cannot appear in the table name this class must produce. Refusing at construction keeps
  // the failure next to the cause instead of surfacing as rejected SQL later.
  assert.throws(
    () => new PluginAuthority({ pluginId: 'todo-focus-index', db }),
    /not a usable table name/,
  );

  // Anything that could terminate or comment out the statement is not a table name.
  for (const bad of ['acme;drop', 'acme--x', 'acme capability', 'acme"capability']) {
    assert.throws(
      () => new PluginAuthority({ pluginId: 'acme', db, tableName: bad }),
      /not a usable table name/,
      `"${bad}" must be refused`,
    );
  }
});

test('grants and checks still behave once the table is plugin-owned', async () => {
  const rows = [
    { actor: 'acme', action: 'thing.do', scope_json: { channel: 'probe' } },
    { actor: 'acme', action: 'thing.other', scope_json: null },
    { actor: 'somebody-else', action: 'thing.do', scope_json: null },
  ];
  const authority = new PluginAuthority({ pluginId: 'acme', db: recordingDatabase(rows) });

  assert.equal((await authority.authorize({ actor: 'acme', action: 'thing.do', scope: { channel: 'probe' } })).allowed, true);
  assert.equal((await authority.authorize({ actor: 'acme', action: 'thing.do', scope: { channel: 'other' } })).allowed, false);
  // A NULL scope means "no narrowing", so any request shape is allowed by that grant.
  assert.equal((await authority.authorize({ actor: 'acme', action: 'thing.other', scope: { anything: 'x' } })).allowed, true);
  // And another actor's grant is not the caller's grant.
  assert.equal((await authority.authorize({ actor: 'acme', action: 'absent', scope: {} })).allowed, false);
});

test('deny-by-default survives the rename', async () => {
  const authority = new PluginAuthority({ pluginId: 'acme', db: recordingDatabase([]) });
  const result = await authority.authorize({ actor: 'acme', action: 'thing.do', scope: {} });
  assert.equal(result.allowed, false);
  assert.match(result.reason, /no grant/i);
});

test('describe reports the table the plugin actually uses', () => {
  const db = recordingDatabase();
  assert.deepEqual(
    new PluginAuthority({ pluginId: 'acme', db }).describe(),
    { pluginId: 'acme', tableName: 'acme_capability' },
  );
});
