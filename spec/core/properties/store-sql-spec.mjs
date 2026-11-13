'use strict';

import '../../support/test-env.mjs';

// Properties-store P1 (plan: docs/plans/properties-store.md §1 schema, §5
// storage abstraction). The store is the persistence contract the facade
// (P2), HTTP (P3) and boot (P4/P5) all sit on:
//   - unit dialect is sqlite, FILE-backed (two handles share a file, which is
//     how persistence/tamper tests observe the same rows); the lane must never
//     need a live PostgreSQL (real-PG parity is P7, env-skipped).
//   - PK is (scope_type, scope_id, key); global forces scope_id ''.
//   - version is optimistic concurrency; soft delete keeps "cleared" distinct
//     from "never set"; secrets live under envelope columns whose PRESENCE is
//     the secret flag; value size is capped (no quotas — owner ruling).
//   - handles are closed in after-hooks (watchdog: a leaked sqlite handle is
//     a hang, not a slow test).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  openPropertiesStore,
  PropertyStoreError,
  PROPERTY_SCOPES,
} from '../../../src/core/properties/store.mjs';
import { propertiesDDLFor } from '../../../src/core/properties/store-sql.mjs';

const HEX_KEY_A = 'a'.repeat(64);
const HEX_KEY_B = 'b'.repeat(64);
const GLOBAL = { type: 'global', id: '' };
const VALUE_CAP = 64 * 1024;

function tmpFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kikx-props-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'properties.db');
}

const silentLogger = { warn() {}, error() {}, info() {}, debug() {} };

async function open(t, extra = {}) {
  const store = await openPropertiesStore({
    driver: 'sqlite',
    filename: tmpFile(t),
    logger: silentLogger,
    ...extra,
  });
  t.after(() => store.close());
  return store;
}

function expectCode(fn, code, why) {
  return Promise.resolve().then(fn).then(
    () => assert.fail(`${why}: expected ${code}, but nothing was thrown`),
    (error) => {
      assert.ok(error instanceof Error, `${why}: refusal must be an Error`);
      assert.equal(error.code, code, `${why}: expected ${code}, got ${error.code} (${error.message})`);
    },
  );
}

test('factory: unknown drivers are refused with a stable code; scopes are pinned', async (t) => {
  assert.deepEqual([ ...PROPERTY_SCOPES ], [ 'global', 'account', 'session', 'plugin' ]);
  await expectCode(
    () => openPropertiesStore({ driver: 'leveldb', logger: silentLogger }),
    'property_store_driver',
    'unknown driver',
  );
  assert.ok(t); // sqlite path is exercised by every other test here
});

test('DDL parity: both dialects create the same columns, PK, and CHECKs', () => {
  const sqlite = propertiesDDLFor('sqlite').toLowerCase();
  const postgres = propertiesDDLFor('postgresql').toLowerCase();
  const columns = [
    'key', 'scope_type', 'scope_id', 'value', 'encryption_method', 'hash_method',
    'key_ref', 'version', 'created_at', 'updated_at', 'updated_by', 'deleted_at',
  ];
  for (const ddl of [ sqlite, postgres ]) {
    assert.ok(ddl.includes('create table if not exists properties'), 'table name');
    for (const column of columns)
      assert.ok(new RegExp(`\\b${column}\\b`).test(ddl), `column ${column}`);
    assert.ok(ddl.includes('primary key (scope_type, scope_id, key)'), 'PK shape');
    for (const scope of [ 'global', 'account', 'session', 'plugin' ])
      assert.ok(ddl.includes(`'${scope}'`), `scope vocabulary ${scope}`);
    assert.ok(ddl.includes('encryption_method is not null and key_ref is not null'), 'secret CHECK');
    assert.ok(ddl.includes('hash_method is not null and key_ref is not null'), 'hash CHECK');
  }
  assert.ok(sqlite.includes('integer'), 'sqlite timestamps are INTEGER epoch ms');
  assert.ok(postgres.includes('jsonb'), 'postgres value is jsonb');
  assert.ok(postgres.includes('timestamptz'), 'postgres timestamps are timestamptz');
  assert.throws(() => propertiesDDLFor('leveldb'), (error) => error.code === 'property_store_driver');
});

test('PK/scope round-trip: same key, two scopes, two independent rows', async (t) => {
  const store = await open(t);
  const themeKey = '/core/user/theme/primary_color';
  await store.put(GLOBAL, themeKey, 'blue', { updatedBy: 'core' });
  await store.put({ type: 'account', id: 'uid-1' }, themeKey, 'purple', { updatedBy: 'uid-1' });

  const globalRow = await store.get(GLOBAL, themeKey);
  const accountRow = await store.get({ type: 'account', id: 'uid-1' }, themeKey);
  assert.equal(globalRow.value, 'blue');
  assert.equal(accountRow.value, 'purple');
  assert.equal(await store.get({ type: 'account', id: 'uid-2' }, themeKey), null, 'other account never set');
  assert.equal(await store.get(GLOBAL, '/core/nope'), null, 'missing key never set');

  // global scope_id is PK-safe: any spelling resolves to the one '' row.
  assert.equal((await store.get({ type: 'global', id: 'ignored' }, themeKey)).value, 'blue');
});

test('scope validation: bad vocabulary and missing ids are refused at the app layer', async (t) => {
  const store = await open(t);
  await expectCode(() => store.put({ type: 'bogus', id: 'x' }, '/a/b', 1), 'property_scope_invalid', 'bad scope');
  await expectCode(() => store.put({ type: 'account', id: '' }, '/a/b', 1), 'property_scope_invalid', 'account without id');
  await expectCode(() => store.get({ type: 'session', id: '' }, '/a/b'), 'property_scope_invalid', 'session without id');
});

test('keys are normalized at the store boundary, hostile keys never persist', async (t) => {
  const store = await open(t);
  await store.put(GLOBAL, '  /A//B ', { n: 1 });
  assert.deepEqual((await store.get(GLOBAL, '/a/b')).value, { n: 1 });
  const listed = await store.list(GLOBAL);
  assert.deepEqual(listed, [ '/a/b' ]);
  await expectCode(() => store.put(GLOBAL, '/a/../b', 1), 'property_key_invalid', 'traversal');
  await expectCode(() => store.put(GLOBAL, '/a/', 1), 'property_key_invalid', 'trailing slash');
});

test('version starts at 1, bumps on write, and expectedVersion conflicts -> 409 seam', async (t) => {
  const store = await open(t);
  const created = await store.put(GLOBAL, '/core/kikx/flag', 'a', { updatedBy: 'core' });
  assert.equal(created.version, 1);
  assert.equal(created.updatedBy, 'core');
  assert.ok(created.createdAt > 0);
  assert.ok(created.updatedAt >= created.createdAt);

  const updated = await store.put(GLOBAL, '/core/kikx/flag', 'b', { expectedVersion: 1 });
  assert.equal(updated.version, 2);
  assert.equal(updated.value, 'b');
  assert.equal(updated.createdAt, created.createdAt, 'created_at never moves');

  await expectCode(
    () => store.put(GLOBAL, '/core/kikx/flag', 'c', { expectedVersion: 1 }),
    'property_version_conflict',
    'stale expectedVersion',
  );
  await expectCode(
    () => store.delete(GLOBAL, '/core/kikx/flag', { expectedVersion: 1 }),
    'property_version_conflict',
    'stale delete',
  );
  assert.equal((await store.get(GLOBAL, '/core/kikx/flag')).value, 'b', 'conflict wrote nothing');
});

test('soft delete: cleared is distinct from never-set, and a write revives', async (t) => {
  const store = await open(t);
  await store.put(GLOBAL, '/core/kikx/gone', 'here');
  const gone = await store.delete(GLOBAL, '/core/kikx/gone');
  assert.ok(gone.deletedAt > 0, 'delete stamps deleted_at');
  assert.equal(gone.version, 2, 'delete bumps version');

  const row = await store.get(GLOBAL, '/core/kikx/gone');
  assert.ok(row, 'a cleared row still EXISTS (cleared never-set are different facts)');
  assert.ok(row.deletedAt > 0);
  assert.equal(row.value, null, 'but its value is gone');
  assert.deepEqual(await store.list(GLOBAL), [], 'list shows live rows only');

  const revived = await store.put(GLOBAL, '/core/kikx/gone', 'back');
  assert.equal(revived.deletedAt, null, 'write clears deleted_at');
  assert.equal(revived.version, 3);
  assert.equal((await store.get(GLOBAL, '/core/kikx/gone')).value, 'back');

  await expectCode(() => store.delete(GLOBAL, '/core/kikx/never'), 'property_not_found', 'delete never-set');
});

test('list: prefix-bounded, scope-bounded, sorted, live-only', async (t) => {
  const store = await open(t);
  await store.put(GLOBAL, '/core/a', 1);
  await store.put(GLOBAL, '/core/b', 2);
  await store.put(GLOBAL, '/other/c', 3);
  await store.put({ type: 'account', id: 'u1' }, '/core/a', 4);
  await store.put(GLOBAL, '/core/zz-deleted', 5);
  await store.delete(GLOBAL, '/core/zz-deleted');

  assert.deepEqual(await store.list(GLOBAL, '/core'), [ '/core/a', '/core/b' ]);
  assert.deepEqual(await store.list(GLOBAL, '/core/'), [ '/core/a', '/core/b' ]);
  assert.deepEqual(await store.list(GLOBAL), [ '/core/a', '/core/b', '/other/c' ]);
  assert.deepEqual(await store.list({ type: 'account', id: 'u1' }), [ '/core/a' ],
    'scopes never bleed across');
});

test('value size cap: 64KB of value bytes is protocol sanity, not a quota', async (t) => {
  const store = await open(t);
  const wrapperOverhead = JSON.stringify({ value: '' }).length;
  const atCap = VALUE_CAP - wrapperOverhead;
  const value = 'x'.repeat(atCap);
  assert.equal(JSON.stringify({ value }).length, VALUE_CAP);
  await store.put(GLOBAL, '/core/kikx/big', value);
  await expectCode(
    () => store.put(GLOBAL, '/core/kikx/bigger', 'x'.repeat(atCap + 1)),
    'property_value_too_large',
    'one byte over the cap',
  );
});

test('secrets: envelope columns carry the value, get returns plaintext to server callers', async (t) => {
  const store = await open(t, { encryptionKey: HEX_KEY_A });
  const written = await store.put(GLOBAL, '/core/kikx/email/configuration',
    { host: 'smtp.example.com', password: 'hunter2' }, { secret: true, updatedBy: 'core' });
  assert.equal(written.encryptionMethod, 'aes-256-gcm');
  assert.match(written.keyRef, /^properties-v1\/[0-9a-f]{8}$/);
  assert.equal(written.hashMethod, null);

  const row = await store.get(GLOBAL, '/core/kikx/email/configuration');
  assert.deepEqual(row.value, { host: 'smtp.example.com', password: 'hunter2' });
  assert.equal(row.encryptionMethod, 'aes-256-gcm');
});

test('secret write without key material is refused (fail-closed without KIKX_PROPERTIES_ENCRYPTION_KEY)', async (t) => {
  const keyless = await open(t);
  await expectCode(
    () => keyless.put(GLOBAL, '/core/kikx/email/configuration', { password: 'x' }, { secret: true }),
    'property_secret_key_missing',
    'no key on the store',
  );
  const invalidKey = await open(t, { encryptionKey: 'garbage' });
  await expectCode(
    () => invalidKey.put(GLOBAL, '/core/kikx/email/configuration', { password: 'x' }, { secret: true }),
    'property_secret_key_missing',
    'unusable key format',
  );
  // Non-secret rows still work on a keyless store (theme story).
  await invalidKey.put(GLOBAL, '/core/user/theme/primary_color', 'purple');
  assert.equal((await invalidKey.get(GLOBAL, '/core/user/theme/primary_color')).value, 'purple');
});

test('secret read without key material is fail-closed, across instances on the same file', async (t) => {
  const filename = tmpFile(t);
  const writer = await openPropertiesStore({ driver: 'sqlite', filename, logger: silentLogger, encryptionKey: HEX_KEY_A });
  await writer.put(GLOBAL, '/core/kikx/email/configuration', { password: 'hunter2' }, { secret: true });
  await writer.put(GLOBAL, '/core/user/theme/primary_color', 'purple');
  await writer.close();

  const keyless = await openPropertiesStore({ driver: 'sqlite', filename, logger: silentLogger });
  t.after(() => keyless.close());
  assert.equal((await keyless.get(GLOBAL, '/core/user/theme/primary_color')).value, 'purple',
    'plain rows survive a keyless boot (and the file persists across instances)');
  await expectCode(
    () => keyless.get(GLOBAL, '/core/kikx/email/configuration'),
    'property_envelope_key',
    'sealed row, no key',
  );
});

test('row tampering is refused: plaintext under sealed columns, and a re-aimed key_ref', async (t) => {
  const filename = tmpFile(t);
  const store = await openPropertiesStore({
    driver: 'sqlite', filename, logger: silentLogger, encryptionKey: HEX_KEY_A,
  });
  t.after(() => store.close());
  await store.put(GLOBAL, '/core/kikx/email/configuration', { password: 'hunter2' }, { secret: true });

  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(filename);
  try {
    raw.exec(`UPDATE properties SET value = '{"value":"evil"}' WHERE key = '/core/kikx/email/configuration'`);
  } finally {
    raw.close();
  }
  await expectCode(
    () => store.get(GLOBAL, '/core/kikx/email/configuration'),
    'property_envelope_mismatch',
    'plaintext under sealed columns',
  );

  // Restore a REAL sealed value under a forged key_ref: the column now aims
  // at a different key than the envelope names — mismatch, not decryption.
  const store2 = await openPropertiesStore({
    driver: 'sqlite', filename, logger: silentLogger, encryptionKey: HEX_KEY_B,
  });
  t.after(() => store2.close());
  await store2.put(GLOBAL, '/core/kikx/email/configuration', { password: 'from-b' }, { secret: true });
  const raw2 = new DatabaseSync(filename);
  try {
    raw2.exec(`UPDATE properties SET key_ref = 'properties-v1/deadbeef' WHERE key = '/core/kikx/email/configuration'`);
  } finally {
    raw2.close();
  }
  await expectCode(
    () => store2.get(GLOBAL, '/core/kikx/email/configuration'),
    'property_envelope_mismatch',
    'forged key_ref column',
  );
});

test('a second writer on a released handle can reopen and continue (close is real)', async (t) => {
  const filename = tmpFile(t);
  const first = await openPropertiesStore({ driver: 'sqlite', filename, logger: silentLogger });
  await first.put(GLOBAL, '/core/kikx/seq', 1);
  await first.close();
  const second = await openPropertiesStore({ driver: 'sqlite', filename, logger: silentLogger });
  t.after(() => second.close());
  assert.equal((await second.get(GLOBAL, '/core/kikx/seq')).value, 1);
  const again = await second.put(GLOBAL, '/core/kikx/seq', 2);
  assert.equal(again.version, 2);
});

test('PropertyStoreError carries its stable code (callers map codes, not messages)', () => {
  const error = new PropertyStoreError('property_store_driver', 'nope');
  assert.equal(error.code, 'property_store_driver');
  assert.ok(error instanceof Error);
});
