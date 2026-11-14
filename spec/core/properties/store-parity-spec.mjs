'use strict';

import '../../support/test-env.mjs';

// Properties-store P7 (plan §5): ONE contract, TWO implementations. This is
// BOTH the aeordb fake-db spec and the driver-parity suite (plan inventory):
// the full store contract runs against sqlite AND the AeorDB backend over a
// fake `db` exposing the tags mechanism (putFile/getFile — the exact calls
// tag-store.mjs makes), plus a CROSS-backend shape assertion (JSONB-always:
// rows are field-identical; ciphertext differs only by the random IV, by
// design) and env-skipped LIVE parity gates.
//
// AeorDB design note: one document per SCOPE holds the key→row map
// (/kikx/properties/<type>/<scope-id>.json). Soft delete is a row rewrite
// (the doctrine: cleared ≠ never-set), so deleteFile is never needed; the
// store does NOT close the shared db handle. Honesty: without a SQL engine
// the aeordb backend cannot offer cross-writer CAS — expectedVersion still
// guards read-modify-write within the document, last-writer-wins beyond it.
//
// LIVE parity bounds (documented per test_check): opt-in only, 60s lane
// watchdog covers them; default SKIPPED (the unit lane is hermetic by
// contract). PostgreSQL parity was EXERCISED GREEN on this host
// (2026-11-14: KIKX_PROPERTIES_PARITY_URL sourced from .env.dev -> 7 pass,
// isolated /core/parity/probe put/get/delete against live :5434). AeorDB is
// permanently retired (owner ruling), so that skip is the honest state
// forever.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { openPropertiesStore } from '../../../src/core/properties/store.mjs';

const KEY_A = 'a'.repeat(64);
const GLOBAL = { type: 'global', id: '' };
const silent = { warn() {}, error() {}, info() {}, debug() {}, log() {} };

function fakeAeorDB() {
  const files = new Map();
  return {
    files,
    async putFile(docPath, body) {
      files.set(docPath, body);
    },
    async getFile(docPath) {
      return files.has(docPath) ? files.get(docPath) : null;
    },
  };
}

function tmpBacking(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kikx-parity-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'properties.db');
}

// Each opener returns { store, reopen } where reopen builds ANOTHER store on
// the SAME backing (for the cross-instance secret tests).
const BACKENDS = [
  [ 'sqlite', (t) => {
    const filename = tmpBacking(t);
    return {
      open: (extra = {}) => openPropertiesStore(
        { driver: 'sqlite', filename, logger: silent, encryptionKey: KEY_A, ...extra }),
    };
  } ],
  [ 'aeordb', (t) => {
    const db = fakeAeorDB();
    return {
      open: (extra = {}) => openPropertiesStore(
        { driver: 'aeordb', db, logger: silent, encryptionKey: KEY_A, ...extra }),
    };
  } ],
];

function expectCode(fn, code, why) {
  return Promise.resolve().then(fn).then(
    () => assert.fail(`${why}: expected ${code}, nothing thrown`),
    (error) => {
      assert.ok(error instanceof Error, `${why}: must throw an Error`);
      assert.equal(error.code, code, `${why}: expected ${code}, got ${error.code} (${error.message})`);
    },
  );
}

for (const [ name, makeBacking ] of BACKENDS) {
  test(`contract @ ${name}: scopes, versions, soft delete, list, secrets, cap`, async (t) => {
    const backing = makeBacking(t);
    const store = await backing.open();
    t.after(() => store.close());

    // Scope isolation + normalization at the boundary.
    await store.put(GLOBAL, '  /A//B ', { n: 1 });
    assert.deepEqual((await store.get(GLOBAL, '/a/b')).value, { n: 1 });
    await store.put({ type: 'account', id: 'u1' }, '/a/b', { n: 2 });
    assert.equal((await store.get({ type: 'account', id: 'u1' }, '/a/b')).value.n, 2);
    assert.equal((await store.get(GLOBAL, '/a/b')).value.n, 1, 'scopes never bleed');
    assert.equal(await store.get({ type: 'account', id: 'u2' }, '/a/b'), null);
    await expectCode(() => store.put({ type: 'bogus', id: 'x' }, '/a', 1),
      'property_scope_invalid', `${name} scope vocabulary`);
    await expectCode(() => store.put(GLOBAL, '/a/../b', 1),
      'property_key_invalid', `${name} traversal refusal`);

    // Versions.
    const first = await store.put(GLOBAL, '/core/flag', 'a', { updatedBy: 'core' });
    assert.equal(first.version, 1);
    const bumped = await store.put(GLOBAL, '/core/flag', 'b', { expectedVersion: 1 });
    assert.equal(bumped.version, 2);
    assert.equal(bumped.createdAt, first.createdAt, 'created_at never moves');
    await expectCode(() => store.put(GLOBAL, '/core/flag', 'c', { expectedVersion: 1 }),
      'property_version_conflict', `${name} stale write`);
    await expectCode(() => store.put(GLOBAL, '/core/never', 'x', { expectedVersion: 5 }),
      'property_version_conflict', `${name} expectedVersion on a missing row`);

    // Soft delete: cleared ≠ never-set, list excludes, revive bumps.
    await store.put(GLOBAL, '/core/tmp', 'here');
    const gone = await store.delete(GLOBAL, '/core/tmp');
    assert.ok(gone.deletedAt > 0);
    assert.equal(gone.version, 2);
    const cleared = await store.get(GLOBAL, '/core/tmp');
    assert.ok(cleared, 'a cleared row still EXISTS');
    assert.equal(cleared.value, null);
    await expectCode(() => store.get({ type: 'global', id: '' }, '/core/x')
      .then(() => store.delete(GLOBAL, '/core/nope')), 'property_not_found', `${name} delete missing`);
    await store.put(GLOBAL, '/core/tmp', 'back');
    assert.equal((await store.get(GLOBAL, '/core/tmp')).value, 'back');
    assert.equal((await store.get(GLOBAL, '/core/tmp')).deletedAt, null, 'write revives');

    // List: prefix + scope bounded, sorted, live-only.
    await store.put(GLOBAL, '/core/a', 1);
    await store.put(GLOBAL, '/core/b', 2);
    await store.put(GLOBAL, '/other/c', 3);
    await store.put(GLOBAL, '/core/zz', 4);
    await store.delete(GLOBAL, '/core/zz');
    assert.deepEqual(await store.list(GLOBAL, '/core'),
      [ '/core/a', '/core/b', '/core/flag', '/core/tmp' ],
      'prefix-bounded, sorted, deleted (/core/zz) excluded, earlier rows included');

    // Size cap.
    const wrapperOverhead = JSON.stringify({ value: '' }).length;
    const atCap = (64 * 1024) - wrapperOverhead;
    await store.put(GLOBAL, '/core/big', 'x'.repeat(atCap));
    await expectCode(() => store.put(GLOBAL, '/core/bigger', 'x'.repeat(atCap + 1)),
      'property_value_too_large', `${name} size cap`);
  });

  test(`secrets @ ${name}: sealed columns, keyless read fail-closed, cross-instance`, async (t) => {
    const backing = makeBacking(t);
    const keyed = await backing.open();
    t.after(() => keyed.close());
    const written = await keyed.put(GLOBAL, '/core/email', { password: 'hunter2' },
      { secret: true, updatedBy: 'operator' });
    assert.equal(written.encryptionMethod, 'aes-256-gcm');
    assert.match(written.keyRef, /^properties-v1\/[0-9a-f]{8}$/);
    assert.deepEqual((await keyed.get(GLOBAL, '/core/email')).value, { password: 'hunter2' });

    // A second store on the SAME backing WITHOUT the key: plain rows read,
    // secret rows refuse (fail-closed), proving persistence across instances.
    const keyless = await backing.open({ encryptionKey: null });
    t.after(() => keyless.close());
    await keyless.put(GLOBAL, '/core/theme', 'purple');
    assert.equal((await keyless.get(GLOBAL, '/core/theme')).value, 'purple');
    await expectCode(() => keyless.get(GLOBAL, '/core/email'),
      'property_envelope_key', `${name} keyless secret read`);
    await expectCode(
      () => keyless.put(GLOBAL, '/core/email2', { password: 'x' }, { secret: true }),
      'property_secret_key_missing', `${name} keyless secret write`);
  });
}

test('byte-identical SHAPE across backends (JSONB-always): same rows, same fields', async (t) => {
  const sqlite = await openPropertiesStore({
    driver: 'sqlite', filename: tmpBacking(t), logger: silent, encryptionKey: KEY_A,
  });
  t.after(() => sqlite.close());
  const db = fakeAeorDB();
  const aeordb = await openPropertiesStore({ driver: 'aeordb', db, logger: silent, encryptionKey: KEY_A });
  t.after(() => aeordb.close());

  const seed = async (store) => {
    await store.put(GLOBAL, '/core/plain', { hello: 'world', list: [ 1, 2 ] });
    await store.put({ type: 'account', id: 'u1' }, '/core/secret', { password: 'p' },
      { secret: true, updatedBy: 'operator' });
    await store.put(GLOBAL, '/core/gone', 'temp');
    await store.delete(GLOBAL, '/core/gone');
  };
  await seed(sqlite);
  await seed(aeordb);

  const stripVolatile = (row) => row && {
    version: row.version,
    // Timestamps are wall-clock (the two seeds run ms apart): presence and
    // null-ness are the shape, not the values. `value` is the UNSEALED
    // plaintext both backends return — already identical; ciphertext (with
    // its random IV) exists only on disk, never at this API.
    createdAtIsNumber: typeof row.createdAt === 'number',
    updatedAtIsNumber: typeof row.updatedAt === 'number',
    deletedAtSet: row.deletedAt !== null,
    encryptionMethod: row.encryptionMethod,
    hashMethod: row.hashMethod,
    keyRef: row.keyRef,
    updatedBy: row.updatedBy,
    value: row.value,
  };
  for (const [ scope, key ] of [
    [ GLOBAL, '/core/plain' ],
    [ { type: 'account', id: 'u1' }, '/core/secret' ],
    [ GLOBAL, '/core/gone' ],
  ]) {
    const a = stripVolatile(await sqlite.get(scope, key));
    const b = stripVolatile(await aeordb.get(scope, key));
    assert.deepEqual(a, b, `shape parity for ${key} (ciphertext differs only by random IV)`);
  }
  assert.deepEqual(await sqlite.list(GLOBAL), await aeordb.list(GLOBAL), 'list parity');
});

test('the factory refuses aeordb without a db handle (post-load seam, named)', async () => {
  await expectCode(() => openPropertiesStore({ driver: 'aeordb', logger: silent }),
    'property_store_driver', 'missing db handle');
});

test('live PostgreSQL parity — opt-in, env-skipped by default', { skip: !process.env.KIKX_PROPERTIES_PARITY_URL }, async (t) => {
  const store = await openPropertiesStore({
    driver: 'postgresql', url: process.env.KIKX_PROPERTIES_PARITY_URL,
    logger: silent, encryptionKey: KEY_A,
  });
  t.after(() => store.close());
  const row = await store.put(GLOBAL, '/core/parity/probe', { ok: true });
  assert.equal(row.version, 1);
  assert.deepEqual((await store.get(GLOBAL, '/core/parity/probe')).value, { ok: true });
  await store.delete(GLOBAL, '/core/parity/probe');
});

test('live AeorDB parity — opt-in, env-skipped (AeorDB retired on this host: owner ruling)',
  { skip: !process.env.KIKX_PROPERTIES_PARITY_AEORDB_URL }, async () => {
    assert.fail('unreachable without an explicit AeorDB opt-in — see the header note');
  });
