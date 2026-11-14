'use strict';

import '../support/test-env.mjs';

// Properties-store P1 (plan: docs/plans/properties-store.md, DDL EXECUTION
// POINT): the properties table must exist BEFORE plugins load — a plugin's
// setup()/onInit() may write properties, and both run INSIDE create-server's
// boot load (pluginLoadPromise), before plugin migrations. The document
// driver cannot own this step: it is resolved only AFTER the load (a plugin
// may even register the driver). So create-server opens the properties store
// as core boot work, ahead of the load promise, and this test proves the
// ORDER the only way that matters: a real fixture plugin writes a property
// DURING setup at boot, then an independent reader finds the row.
//
// Lane safety: sqlite file under tmp, injected `aeordb: {}` context (no
// driver resolution, no network), tmp cwd (runtime files never touch the
// real ~/.kikx), signature mode forced unsafe by test-env.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createServer } from '../../src/server/create-server.mjs';
import { AppContext } from '../../src/core/app/app-context.mjs';
import { openPropertiesStore } from '../../src/core/properties/store.mjs';

// Isolate from ambient plugin discovery (same posture as
// create-server-spec): the fixture must be the ONLY plugin this boot sees.
delete process.env.KIKX_PLUGIN_PATHS;

const silent = { warn() {}, info() {}, error() {}, debug() {}, log() {} };
const PROOF_KEY = '__kikxPropertiesBootProof';

function writeFixturePlugin(root) {
  const dir = path.join(root, 'boot-order-fixture');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'boot-order-fixture', main: 'index.mjs' }));
  fs.writeFileSync(path.join(dir, 'index.mjs'), `
    export const pluginName = 'boot-order-fixture';

    // The property write happens DURING setup — before plugin migrations, and
    // before anything else at boot could have created the table.
    export async function setup(provide) {
      const store = provide((ctx) => ctx.context.require('propertiesStore'));
      try {
        const row = await store.put({ type: 'global', id: '' }, '/fixtures/boot/wrote',
          { from: 'setup', at: Date.now() }, { updatedBy: 'boot-order-fixture' });
        globalThis.${PROOF_KEY} = { ok: true, version: row.version };
      } catch (error) {
        globalThis.${PROOF_KEY} = { ok: false, error: error?.message || String(error) };
      }
      provide(() => {});
    }
  `);
  return root;
}

test('boot order: a fixture plugin writes a property DURING setup — the table already exists', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kikx-boot-props-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const cwd = path.join(tmp, 'cwd');
  fs.mkdirSync(cwd, { recursive: true });
  const pluginRoot = writeFixturePlugin(path.join(tmp, 'plugins'));
  const dbFile = path.join(tmp, 'properties.db');
  delete globalThis[PROOF_KEY];

  const server = await createServer({
    context: new AppContext({ aeordb: {} }),
    pluginPaths: [ pluginRoot ],
    cwd,
    logger: silent,
    properties: { driver: 'sqlite', filename: dbFile },
  });
  t.after(() => new Promise((resolve) => server.close(() => resolve())));

  const proof = globalThis[PROOF_KEY];
  assert.ok(proof, 'the fixture plugin must have run its setup at boot');
  assert.equal(proof.ok, true,
    `writing a property during setup must succeed (table exists before pluginLoadPromise): ${proof.error}`);
  assert.equal(proof.version, 1);

  // An independent store instance on the same file finds the durable row —
  // ordering proven from outside the boot context.
  const reader = await openPropertiesStore({ driver: 'sqlite', filename: dbFile, logger: silent });
  t.after(() => reader.close());
  const row = await reader.get({ type: 'global', id: '' }, '/fixtures/boot/wrote');
  assert.ok(row, 'the setup-time write must be durable on disk');
  assert.equal(row.value.from, 'setup');
  assert.equal(row.updatedBy, 'boot-order-fixture');
});

test('injection: an injected propertiesStore registers the FULL aside — facade + grants (503 root)', async (t) => {
  // Red-first: observed in the browser (theme fixture answered 503
  // property_store unavailable with a store-only injection — the P1 seam
  // predates the P2 facade, 2026-11-14); this is the fast unit pin so the
  // seam can never regress without Chrome. Signature-free assertions on
  // purpose — the HTTP 200 end-to-end lives in the theme puppeteer spec.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kikx-inject-aside-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const store = await openPropertiesStore({
    driver: 'sqlite', filename: path.join(tmp, 'injected.db'), logger: silent,
  });
  t.after(() => store.close());

  // Pre-seed BEFORE boot: the HTTP layer reads through the facade, so the
  // aside must exist for any injected-server read to work at all.
  await store.put({ type: 'global', id: '' }, '/fixtures/boot/injected',
    { ok: true }, { updatedBy: 'injection-test' });

  const context = new AppContext({ aeordb: {} });
  const server = await createServer({
    context,
    aeordb: {},
    logger: silent,
    propertiesStore: store,
  });
  t.after(() => new Promise((resolve) => server.close(() => resolve())));

  assert.equal(context.has('propertiesStore'), true, 'the injected store is registered');
  assert.equal(context.require('propertiesStore'), store,
    'and it is THE injected instance — not a second opened store');
  assert.ok(context.has('propertiesFacade'),
    'the FACADE is registered — the HTTP routes only talk to it (the 503 root)');
  assert.ok(context.has('propertiesGrants'), 'grants register alongside the facade');
  const facade = context.require('propertiesFacade');
  assert.equal(typeof facade.read, 'function', 'the facade exposes reads (caller-first API)');
  const row = await facade.read('core', { type: 'global', id: '' }, '/fixtures/boot/injected');
  assert.deepEqual(row?.value, { ok: true },
    'and a pre-seeded row is readable THROUGH the facade — exactly the path the HTTP 503 was missing');
});
