'use strict';

import '../support/test-env.mjs';

// Properties-store P2 (plan: docs/plans/properties-store.md) — ONE
// end-to-end through the REAL loader (cynic pass: hand-built grants give
// false confidence). A fixture plugin declares `pluginID` + `access` in
// manifest.json — the EXACT file the S4 signature envelope signs (`.kikx-sig`
// payload = its bytes) — and the loader must:
//   1. parse + validate that block and register grants before setup runs,
//   2. bind ctx.properties to the plugin's caller class, so a relative write
//      lands in the plugin's own namespace and a granted absolute read passes
//      the facade while an undeclared write is DENIED and structured-logged,
//   3. REFUSE a malformed access block at load (never half-register).
// Lane safety mirrors properties-boot-order-spec: tmp cwd, sqlite file,
// injected aeordb: {}, signature unsafe via test-env.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createServer } from '../../src/server/create-server.mjs';
import { AppContext } from '../../src/core/app/app-context.mjs';
import { openPropertiesStore } from '../../src/core/properties/store.mjs';

delete process.env.KIKX_PLUGIN_PATHS;

const PROOF_KEY = '__kikxPropertiesE2EProof';

function silentLogger(sink = []) {
  return {
    warn: (...args) => sink.push(args.map(String).join(' ')),
    info() {}, error() {}, debug() {}, log() {},
  };
}

function writePlugin(root, name, manifestBody, entryBody) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifestBody));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, main: 'index.mjs' }));
  fs.writeFileSync(path.join(dir, 'index.mjs'), entryBody);
  return dir;
}

const GOOD_ENTRY = `
  export const pluginName = 'props-e2e-good';
  export async function setup(provide) {
    const props = provide((ctx) => ctx.properties);
    const proof = {};
    try {
      await props.write(null, 'e2e_key', { ok: true });
      proof.ownWrite = 'ok';
    } catch (error) { proof.ownWrite = error?.code || String(error); }
    try {
      const row = await props.read({ type: 'global', id: '' }, '/probe/granted');
      proof.grantedRead = row === null || row.value === undefined ? 'ok-null' : 'ok-value';
    } catch (error) { proof.grantedRead = error?.code || String(error); }
    try {
      await props.write({ type: 'global', id: '' }, '/probe/granted', 'nope');
      proof.deniedWrite = 'NOT-THROWN';
    } catch (error) { proof.deniedWrite = error?.code || String(error); }
    globalThis.__kikxPropertiesE2EProof = proof;
  }
`;

const BAD_ACCESS_ENTRY = `
  export const pluginName = 'props-e2e-bad';
  export async function setup(provide) {
    provide((ctx) => {});
    globalThis.__kikxPropertiesE2EBadSetupRan = true;
  }
`;

// Valid grants, failing setup: the rollback path (registered before setup,
// must be released when the load fails after it).
const ROLLBACK_ENTRY = `
  export const pluginName = 'props-e2e-rollback';
  export async function setup(provide) {
    provide((ctx) => {});
    throw new Error('fixture setup explosion');
  }
`;

test('real loader E2E: signed-manifest grants register, bind, deny, log — malformed refuses', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kikx-props-e2e-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const cwd = path.join(tmp, 'cwd');
  fs.mkdirSync(cwd, { recursive: true });
  const pluginsRoot = path.join(tmp, 'plugins');
  writePlugin(pluginsRoot, 'props-e2e-good', {
    pluginID: '/spec/props/good',
    access: {
      read: { allow: [ '/probe/granted' ] },
      write: { deny: [ '*' ], allow: [] },
    },
  }, GOOD_ENTRY);
  writePlugin(pluginsRoot, 'props-e2e-bad', {
    pluginID: '/spec/props/bad',
    access: { read: 'nope' },
  }, BAD_ACCESS_ENTRY);
  writePlugin(pluginsRoot, 'props-e2e-rollback', {
    pluginID: '/spec/props/rollback',
    access: { read: { allow: [ '/*' ] } },
  }, ROLLBACK_ENTRY);

  const dbFile = path.join(tmp, 'properties.db');
  delete globalThis[PROOF_KEY];
  delete globalThis.__kikxPropertiesE2EBadSetupRan;
  const warnings = [];

  const server = await createServer({
    context: new AppContext({ aeordb: {} }),
    pluginPaths: [ pluginsRoot ],
    cwd,
    logger: silentLogger(warnings),
    properties: { driver: 'sqlite', filename: dbFile },
  });
  t.after(() => new Promise((resolve) => server.close(() => resolve())));

  const registry = server.kikxContext.require('pluginRegistry');

  // NOTE: pluginIDs are FQIDs — at least THREE segments (plan §2).

  // 1. The good plugin ran and its three-way verdict is exactly as designed.
  const proof = globalThis[PROOF_KEY];
  assert.ok(proof, 'the good fixture must have run its setup');
  assert.equal(proof.ownWrite, 'ok', 'relative write through ctx.properties lands in own namespace');
  assert.equal(proof.grantedRead, 'ok-null', 'granted absolute READ passes the facade (row never set -> null)');
  assert.equal(proof.deniedWrite, 'property_denied', 'undeclared absolute WRITE is denied (deny:*)');

  // 2. The deny was structured-logged by the boot logger.
  const denies = warnings.filter((line) => line.includes('[properties-deny]'));
  assert.equal(denies.length, 1, `exactly one structured deny line: ${JSON.stringify(warnings)}`);
  assert.ok(denies[0].includes('plugin:/spec/props/good'), 'caller named');
  assert.ok(denies[0].includes('/probe/granted'), 'key named');
  assert.ok(denies[0].includes('decision=deny'), 'decision named');

  // 3. The own-namespace write is durable in the plugin's scope.
  const reader = await openPropertiesStore({ driver: 'sqlite', filename: dbFile, logger: silentLogger() });
  t.after(() => reader.close());
  const row = await reader.get({ type: 'plugin', id: '/spec/props/good' }, '/plugins/spec/props/good/e2e_key');
  assert.deepEqual(row?.value, { ok: true });
  assert.equal(row.updatedBy, 'plugin:/spec/props/good', 'audit seam records the bound caller');

  // 4. A malformed access block REFUSES the load and setup never runs.
  assert.equal(globalThis.__kikxPropertiesE2EBadSetupRan, undefined,
    'the malformed fixture must never reach setup');
  const failures = registry._pluginLoadErrors || [];
  assert.ok(failures.some((entry) => /grant|access|pluginID/i.test(entry.message || '')),
    `load error must name the malformed block: ${JSON.stringify(failures)}`);

  // 5. Rollback: grants registered before setup are RELEASED when the load
  // fails afterwards — a plugin that never loaded must not keep permissions.
  const grants = server.kikxContext.require('propertiesGrants');
  assert.ok(grants.get('/spec/props/good'), 'the successful plugin keeps its grants');
  assert.equal(grants.get('/spec/props/rollback'), null,
    'the failed fixture\u2019s grants were rolled back at load failure');
});
