'use strict';

import '../../support/test-env.mjs';

// Properties-store P2 (plan §2-§3): THE FACADE IS THE ONLY WAY non-core
// callers reach the store. Relative keys resolve into the caller's own
// namespace (plugins: /plugins/<fqid>/…) with NO declaration — dynamic
// properties — and are forced into the caller's own scope. Absolute keys run
// the full gauntlet: core-owned sensitivity registry + grants (deny-wins,
// default-deny) + structured DENY LOGGING (owner: "we do want to log such
// things"). core is server code with ambient absolute access and no relative
// form. HTTP user identities never reach this layer (P3 keeps the scope
// rules); unknown caller shapes are refused, never guessed.

import assert from 'node:assert/strict';
import test from 'node:test';

import { openPropertiesStore } from '../../../src/core/properties/store.mjs';
import { CorePropertyRegistry } from '../../../src/core/properties/registry.mjs';
import { GrantsRegistry } from '../../../src/core/properties/grants.mjs';
import { createPropertiesFacade, pluginPropertiesAPI } from '../../../src/core/properties/facade.mjs';

const FQID = '/org/test/demo';
const PLUGIN = `plugin:${FQID}`;
const KEY_A = 'a'.repeat(64);
const GLOBAL = { type: 'global', id: '' };

function makeLogger() {
  const warnings = [];
  return {
    warnings,
    warn: (...args) => warnings.push(args.map(String).join(' ')),
    error() {}, info() {}, debug() {}, log() {},
  };
}

async function setup(t, { access = null, entries = null, pluginPath = '/path/demo' } = {}) {
  const store = await openPropertiesStore({ driver: 'sqlite', filename: ':memory:', encryptionKey: KEY_A });
  t.after(() => store.close());
  const registry = new CorePropertyRegistry(entries ?? [
    [ '/probe/public', 'public' ],
    [ '/probe/internal', 'internal' ],
    [ '/core/kikx/email/configuration', 'secret' ],
  ]);
  const grants = new GrantsRegistry();
  if (access)
    grants.register(FQID, access, pluginPath);
  const logger = makeLogger();
  const facade = createPropertiesFacade({ store, registry, grants, logger });
  return { store, registry, grants, logger, facade };
}

function expectDenial(fn, why) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof Error, `${why}: must throw`);
    assert.equal(error.code, 'property_denied', `${why}: expected property_denied, got ${error.code}`);
    return true;
  }, why);
}

test('core: absolute access with ambient rights, and relative keys are refused', async (t) => {
  const { facade, logger } = await setup(t);
  await facade.write('core', { type: 'account', id: 'u1' }, '/core/user/theme/primary_color', 'purple');
  assert.equal((await facade.read('core', { type: 'account', id: 'u1' },
    '/core/user/theme/primary_color')).value, 'purple');
  await facade.write('core', GLOBAL, '/core/kikx/email/configuration', { host: 'x' }, { secret: true });
  assert.equal((await facade.read('core', GLOBAL, '/core/kikx/email/configuration')).value.host, 'x',
    'core reads its own secrets (server-side)');
  // core has no plugin namespace to be relative to — refused, not guessed.
  assert.throws(() => facade.write('core', GLOBAL, 'relative/key', 1), (error) =>
    error.code === 'property_caller_invalid');
  assert.deepEqual(logger.warnings, [], 'core access never logs a deny');
});

test('plugin relative keys: own namespace, own scope, unrestricted and dynamic', async (t) => {
  const { facade, grants } = await setup(t); // no grants registered at all
  // A caller-chosen scope is IGNORED for relative keys: the namespace forces
  // (plugin, fqid) so a plugin can never write into an account's rows.
  await facade.write(PLUGIN, { type: 'account', id: 'victim' }, 'my_dynamic_key', { n: 1 });
  const row = await facade.read(PLUGIN, null, 'my_dynamic_key');
  assert.deepEqual(row.value, { n: 1 });
  assert.equal(row.updatedBy, PLUGIN, 'audit seam records the caller (plan §10.7)');
  // It really landed in the plugin scope, not the account scope the caller named.
  assert.equal(await facade.read('core', { type: 'account', id: 'victim' }, `/plugins${FQID}/my_dynamic_key`),
    null);
  assert.equal(await facade.read('core', { type: 'plugin', id: FQID }, `/plugins${FQID}/my_dynamic_key`).then((r) => r.value.n),
    1);
  // Undeclared dynamic keys need no manifest entries (owner relaxation).
  await facade.write(PLUGIN, null, 'another/undeclared', 'ok');
  assert.equal((await facade.read(PLUGIN, null, 'another/undeclared')).value, 'ok');
  assert.deepEqual(await facade.list(PLUGIN, null, null), [
    `/plugins${FQID}/another/undeclared`,
    `/plugins${FQID}/my_dynamic_key`,
  ], 'own-namespace listing works');
  assert.ok(grants);
});

test('plugin absolute: public reads are free, public WRITES still need a grant', async (t) => {
  const { facade, logger } = await setup(t);
  const publicRow = await facade.read(PLUGIN, GLOBAL, '/probe/public');
  assert.equal(publicRow, null,
    'unrestricted READ of a public key (never-set row reads as null)');
  expectDenial(() => facade.write(PLUGIN, GLOBAL, '/probe/public', 'v'),
    'public write without a grant is denied');
  assert.equal(logger.warnings.length, 1, 'the deny was logged');
});

test('plugin absolute: undeclared internal AND secret access are denied and LOGGED', async (t) => {
  const { facade, logger } = await setup(t);
  expectDenial(() => facade.read(PLUGIN, GLOBAL, '/probe/internal'), 'undeclared internal read');
  expectDenial(() => facade.write(PLUGIN, GLOBAL, '/probe/internal', 1), 'undeclared internal write');
  expectDenial(() => facade.read(PLUGIN, GLOBAL, '/core/kikx/email/configuration'),
    'undeclared secret read');
  assert.equal(logger.warnings.length, 3, 'every deny logged once');
  for (const line of logger.warnings) {
    assert.ok(line.includes('[properties-deny]'), `structured deny prefix: ${line}`);
    assert.ok(line.includes(PLUGIN), `caller named: ${line}`);
    assert.ok(line.includes('decision=deny'), `decision named: ${line}`);
    assert.ok(line.includes('action='), `action named: ${line}`);
    assert.ok(line.includes('key='), `key named: ${line}`);
  }
  // Allowed operations log nothing.
  await facade.read(PLUGIN, GLOBAL, '/probe/public');
  assert.equal(logger.warnings.length, 3, 'success is silent');
});

test('plan §4 manifest example: allow grants the secret read; deny "*" flat-wins on write', async (t) => {
  const { facade, logger } = await setup(t, {
    access: {
      // FLAT deny-wins (§4 prose: "deny beats allow") — so the carve-out idiom
      // is allow-under-no-covering-deny. An allow sitting UNDER a covering
      // deny is dead; P8 docs note the pattern next to the example.
      read: { allow: [ '/core/kikx/email/configuration' ] },
      write: { deny: '*', allow: [] },
    },
  });
  await facade.write('core', GLOBAL, '/core/kikx/email/configuration', { host: 'smtp' });
  // Secret reads by a granted plugin return the REAL value server-side
  // (the HTTP hasValue restriction is P3's identity-layer rule).
  const row = await facade.read(PLUGIN, GLOBAL, '/core/kikx/email/configuration');
  assert.deepEqual(row.value, { host: 'smtp' }, 'grant covers the secret read (plan §4 intent)');
  expectDenial(() => facade.write(PLUGIN, GLOBAL, '/core/kikx/email/configuration', { host: 'evil' }),
    'write denied by deny:* with empty allow');
  expectDenial(() => facade.read(PLUGIN, GLOBAL, '/other/key'),
    'no grant on this key = default deny');
  assert.equal(logger.warnings.length, 2, 'both denies logged');
});

test('deny-wins and /* subtree coverage through the facade', async (t) => {
  const { facade, logger } = await setup(t, {
    access: {
      read: { deny: [ '/core/kikx/email/*' ], allow: [ '/*' ] },
      write: { allow: [ '/audit/*' ] },
    },
  });
  await facade.write('core', GLOBAL, '/other/key', 'v');
  assert.equal((await facade.read(PLUGIN, GLOBAL, '/other/key')).value, 'v',
    '/* read grant covers the absolute tree');
  expectDenial(() => facade.read(PLUGIN, GLOBAL, '/core/kikx/email/credentials'),
    'deny prefix beats the /* allow');
  await facade.write(PLUGIN, GLOBAL, '/audit/trail', [ 1, 2 ]);
  assert.deepEqual((await facade.read(PLUGIN, GLOBAL, '/audit/trail')).value, [ 1, 2 ]);
  assert.equal(logger.warnings.length, 1);
});

test('v1 scope forcing: plugin absolute access is global-scoped (no cross-account reads)', async (t) => {
  const { facade } = await setup(t, { access: { read: { allow: [ '/*' ] } } });
  await facade.write('core', { type: 'account', id: 'victim' }, '/probe/internal', 'their-data');
  const row = await facade.read(PLUGIN, { type: 'account', id: 'victim' }, '/probe/internal');
  assert.equal(row, null, 'the plugin read the GLOBAL row (absent), never the account row');
});

test('plugin absolute list is denied (keys leak); own-namespace list stays open', async (t) => {
  const { facade, logger } = await setup(t, { access: { read: { allow: [ '/*' ] } } });
  expectDenial(() => facade.list(PLUGIN, GLOBAL, '/probe'), 'absolute list v1-denied');
  assert.ok(logger.warnings[0].includes('action=list'));
  assert.deepEqual(await facade.list(PLUGIN, null, null), [], 'own-ns list allowed (empty)');
});

test('caller validation: HTTP identities and malformed shapes never reach the store', async (t) => {
  const { facade } = await setup(t);
  for (const caller of [ null, undefined, '', 'user:operator-1', 'plugin:', 'plugin/bad', 42, 'PLUGIN:/org/x/y' ]) {
    assert.throws(() => facade.read(caller, GLOBAL, '/probe/public'), (error) =>
      error.code === 'property_caller_invalid', `caller ${JSON.stringify(caller)} refused`);
  }
});

test('deny logging can never throw into the request path', async (t) => {
  const store = await openPropertiesStore({ driver: 'sqlite', filename: ':memory:' });
  t.after(() => store.close());
  const registry = new CorePropertyRegistry([ [ '/probe/internal', 'internal' ] ]);
  const hostile = { warn() { throw new Error('logger exploded'); }, error() {}, info() {}, debug() {} };
  const facade = createPropertiesFacade({ store, registry, grants: new GrantsRegistry(), logger: hostile });
  assert.throws(() => facade.read(PLUGIN, GLOBAL, '/probe/internal'), (error) =>
    error.code === 'property_denied', 'the DENIAL still propagates even if the logger throws');
});

test('pluginPropertiesAPI: the setup-context binding, both failure branches included', async (t) => {
  const { facade } = await setup(t);

  // Bound API behaves exactly like a plugin caller: own namespace, caller
  // audit seam, relative keys — the E2E through the real loader uses this.
  const api = pluginPropertiesAPI(facade, FQID);
  await api.write(null, 'from_api', 'v1');
  assert.equal((await api.read(null, 'from_api')).value, 'v1');
  assert.deepEqual(await api.list(null, null), [ `/plugins${FQID}/from_api` ]);
  assert.equal((await facade.read('core', { type: 'plugin', id: FQID },
    `/plugins${FQID}/from_api`)).updatedBy, PLUGIN);
  await api.remove(null, 'from_api');
  const cleared = await api.read(null, 'from_api');
  assert.ok(cleared, 'the cleared row still EXISTS (soft delete)');
  assert.equal(cleared.value, null, 'but its value is gone');
  assert.ok(cleared.deletedAt > 0);

  // A manifest without pluginID cannot name a namespace: every call refuses
  // (CALL-time, never factory-time — a booted plugin that simply never
  // declared pluginID must still LOAD; properties stay unusable, loudly).
  for (const bad of [ null, undefined, '', 'nope', '/two/only', 42 ]) {
    const api = pluginPropertiesAPI(facade, bad);
    assert.throws(() => api.read(null, 'x'), (error) =>
      error.code === 'property_plugin_id_invalid', `pluginID ${JSON.stringify(bad)} refused per call`);
    assert.throws(() => api.write(null, 'x', 1), (error) =>
      error.code === 'property_plugin_id_invalid', `pluginID ${JSON.stringify(bad)} refused per call`);
  }

  // No facade in context (direct loadPlugins harness): the stub refuses per
  // call so plugin LOAD still succeeds — properties are simply unavailable.
  const stub = pluginPropertiesAPI(null, FQID);
  assert.throws(() => stub.read(null, 'x'), (error) =>
    error.code === 'property_facade_unavailable', 'null-facade stub refuses per call');
  assert.throws(() => stub.write(null, 'x', 1), (error) =>
    error.code === 'property_facade_unavailable');
});
