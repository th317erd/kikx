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
