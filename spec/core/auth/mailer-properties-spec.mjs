'use strict';

import '../../support/test-env.mjs';

// P5 (plan: docs/plans/properties-store.md §6/P5): the mailer configuration
// storage seam. One GLOBAL SECRET property; clean cut from
// .kikx/mailer.json (no reader exists anywhere — a leftover file is ignored
// by design); an UNDECRYPTABLE row is loud-warn + {stored:null,
// error:'undecryptable'} — never a crash, never plaintext.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAILER_PROPERTY_KEY,
  readStoredMailerSettings,
  writeStoredMailerSettings,
} from '../../../src/core/auth/mailer-properties.mjs';
import { openPropertiesStore } from '../../../src/core/properties/store.mjs';
import { createPropertiesFacade } from '../../../src/core/properties/facade.mjs';
import { CorePropertyRegistry } from '../../../src/core/properties/registry.mjs';
import { GrantsRegistry } from '../../../src/core/properties/grants.mjs';

const KEY_A = 'a'.repeat(64);
const GLOBAL = { type: 'global', id: '' };

function makeFacade(store, logger) {
  return createPropertiesFacade({
    store,
    registry: new CorePropertyRegistry(),
    grants: new GrantsRegistry(),
    logger,
  });
}

function silent() {
  return { warn() {}, error() {}, info() {}, debug() {}, log() {} };
}

test('the property key the mailer family hangs on (plan §6)', () => {
  assert.equal(MAILER_PROPERTY_KEY, '/core/kikx/email/configuration');
});

test('round-trip: write seals the row, read unseals it — updated_by records the caller', async (t) => {
  const store = await openPropertiesStore({ driver: 'sqlite', filename: ':memory:', encryptionKey: KEY_A });
  t.after(() => store.close());
  const facade = makeFacade(store, silent());

  assert.deepEqual(await readStoredMailerSettings(facade), { stored: null, error: null },
    'never-set reads as unconfigured');
  const written = await writeStoredMailerSettings(facade,
    { provider: 'smtp', host: 'smtp.example.com', port: 465, password: 'hunter2' },
    { updatedBy: 'operator-1' });
  assert.equal(written.host, 'smtp.example.com');

  const { stored, error } = await readStoredMailerSettings(facade);
  assert.equal(error, null);
  assert.equal(stored.host, 'smtp.example.com');
  assert.equal(stored.password, 'hunter2', 'server-side read unseals (the transport never does)');

  const row = await store.get(GLOBAL, MAILER_PROPERTY_KEY);
  assert.equal(row.encryptionMethod, 'aes-256-gcm', 'the row is SECRET — envelope columns present');
  assert.equal(row.updatedBy, 'operator-1', 'audit seam');
});

test('missing facade: read degrades to unconfigured, write refuses 503-shaped', async () => {
  const read = await readStoredMailerSettings(null);
  assert.deepEqual(read, { stored: null, error: null });
  await assert.rejects(
    () => writeStoredMailerSettings(null, { provider: 'log' }),
    (error) => error.code === 'property_facade_unavailable' && error.status === 503,
  );
});

test('undecryptable row: LOUD warn, {stored:null, error}, env fallback stays possible', async (t) => {
  const store = await openPropertiesStore({ driver: 'sqlite', filename: ':memory:', encryptionKey: KEY_A });
  t.after(() => store.close());
  await writeStoredMailerSettings(makeFacade(store, silent()), { provider: 'smtp', host: 'x' });

  // Same FILE, keyless reader — but :memory: is per-connection, so seal into
  // a row this store can read, then read it from a facade whose STORE lost
  // the key: simulate by opening a second store on a file-backed DB.
  await store.close();
  const file = `${globalThis.process?.cwd?.() ?? '/tmp'}/kikx-mailer-undec-${Date.now()}-${Math.random().toString(16).slice(2)}.db`;
  const writer = await openPropertiesStore({ driver: 'sqlite', filename: file, encryptionKey: KEY_A });
  await writeStoredMailerSettings(makeFacade(writer, silent()), { provider: 'smtp', host: 'secret-host' });
  await writer.close();

  const keyless = await openPropertiesStore({ driver: 'sqlite', filename: file });
  t.after(async () => { await keyless.close(); await (await import('node:fs/promises')).rm(file, { force: true }); });
  const warnings = [];
  const logger = { warn: (...args) => warnings.push(args.map(String).join(' ')), error() {}, info() {}, debug() {} };

  // Reader logger is its OWN parameter (facade logger only covers denies).
  const result = await readStoredMailerSettings(makeFacade(keyless), { logger });
  assert.equal(result.stored, null, 'no plaintext fallback — ever');
  assert.equal(result.error, 'undecryptable');
  assert.equal(warnings.length, 1, 'loud, exactly once per read');
  assert.ok(warnings[0].includes('UNREADABLE'), `names the condition: ${warnings[0]}`);
  assert.ok(warnings[0].includes('KIKX_PROPERTIES_ENCRYPTION_KEY'), 'names the operator fix');
});

test('a cleared (soft-deleted) row reads as unconfigured, not an error', async (t) => {
  const store = await openPropertiesStore({ driver: 'sqlite', filename: ':memory:', encryptionKey: KEY_A });
  t.after(() => store.close());
  const facade = makeFacade(store, silent());
  await writeStoredMailerSettings(facade, { provider: 'smtp' });
  await facade.remove('core', GLOBAL, MAILER_PROPERTY_KEY);
  const result = await readStoredMailerSettings(facade);
  assert.deepEqual(result, { stored: null, error: null });
});

test('non-store failures are NOT swallowed as "unconfigured"', async () => {
  const exploding = {
    async read() { throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }); },
  };
  await assert.rejects(() => readStoredMailerSettings(exploding), /connection reset/);
});
