'use strict';

// GAP CLOSED (owner 2026-11-14): the PRODUCTION signature posture
// (mode=required) was proven only in unit tests — every browser lane runs
// `unsafe` because fixtures are unsigned. This test boots a real fixture
// server in REQUIRED mode with a real Ed25519 keypair and proves, in a real
// browser, both halves of the gate end-to-end:
//   - the SIGNED fixture loads and paints (its toolbar-action surface
//     mounts AND its plugin asset module executes), and
//   - the UNSIGNED twin (same code, no .kikx-sig) never loads: absent from
//     the DOM and absent from the inventory, which reports
//     signatureMode: 'required' from the same authoritative answer the
//     Settings banner reads.
//
// Env is set INSIDE the test body and test-utils is imported dynamically
// after it, so config snapshot order can never beat the mode switch.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { chromium } from 'playwright';

import { signPluginSignature } from '../../../src/core/plugins/plugin-signature.mjs';

const PLUGIN_NAME = 'sig-proof-signed';
const UNSIGNED_NAME = 'sig-proof-unsigned';
const SURFACE_KEY = `${PLUGIN_NAME}-probe`;

function writeFixture(dir, name, { signed = false, privateKey = null } = {}) {
  const manifest = { name, version: '1.0.0' };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2));
  return fs.mkdir(dir, { recursive: true }).then(async () => {
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name, main: 'index.mjs' }));
    await fs.writeFile(path.join(dir, 'manifest.json'), manifestBytes);
    await fs.writeFile(path.join(dir, 'index.mjs'), [
      'export const pluginName = ' + JSON.stringify(name) + ';',
      'export function setup(provide) {',
      '  provide((ctx) => {',
      '    ctx.registerClientSurface(\'toolbar-action\', ' + JSON.stringify(`${name}-probe`) + ', {',
      '      tagName: \'kikx-sig-probe\',',
      '      moduleURL: `/api/v1/plugin-assets/${pluginName}/proof.mjs`,',
      '      label: ' + JSON.stringify(`${name} probe`) + ',',
      '    });',
      '  });',
      '}',
      '',
    ].join('\n'));
    // The asset module: defines the element the toolbar mounts. Its text is
    // the proof that plugin-owned code EXECUTED in the browser.
    await fs.mkdir(path.join(dir, 'client'), { recursive: true });
    await fs.writeFile(path.join(dir, 'client', 'proof.mjs'), [
      'if (!customElements.get(\'kikx-sig-probe\')) {',
      '  customElements.define(\'kikx-sig-probe\', class extends HTMLElement {',
      '    connectedCallback() { this.textContent = \'SIGNED-ASSET-EXECUTED\'; }',
      '  });',
      '}',
      '',
    ].join('\n'));
    if (signed) {
      const sig = signPluginSignature(manifestBytes, privateKey, 'k1');
      await fs.writeFile(path.join(dir, '.kikx-sig'), JSON.stringify(sig));
    }
  });
}

test('required signature mode: the signed fixture loads into the browser, the unsigned twin is refused', async (t) => {
  const { findChromeExecutable, startStagehandUIServer } = await import(
    '../stagehand/stagehand-test-utils.mjs'
  );
  const chromePath = findChromeExecutable();
  if (!chromePath) {
    t.skip('Chrome is required');
    return;
  }

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const rawPublicKey = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-sig-e2e-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const signedDir = path.join(tmp, 'signed');
  const unsignedDir = path.join(tmp, 'unsigned');
  await writeFixture(signedDir, PLUGIN_NAME, { signed: true, privateKey });
  await writeFixture(unsignedDir, UNSIGNED_NAME);

  const previous = {
    mode: process.env.KIKX_PLUGIN_SIGNATURE_MODE,
    keys: process.env.KIKX_PLUGIN_SIGNING_PUBLIC_KEYS,
  };
  process.env.KIKX_PLUGIN_SIGNATURE_MODE = 'required';
  process.env.KIKX_PLUGIN_SIGNING_PUBLIC_KEYS = rawPublicKey;

  let fixture;
  let browser;
  try {
    fixture = await startStagehandUIServer({
      sessions: [{ id: 'session_1', title: 'Signature gate', messageCount: 0 }],
      pluginPaths: [ signedDir, unsignedDir ],
    });
    browser = await chromium.launch({ executablePath: chromePath, headless: true, args: [ '--no-sandbox' ] });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.addInitScript(() => {
      sessionStorage.setItem('kikx.auth.session', JSON.stringify({ token: 'identity-token', refresh_token: 'identity-refresh' }));
    });

    await page.goto(`${fixture.baseURL}/?session=session_1`, { waitUntil: 'domcontentloaded', timeout: 15000 });

    // The signed plugin's surface mounts in the top bar AND its asset module
    // executed (the element's text only exists if plugin code ran).
    await page.waitForFunction(
      () => document.querySelector('kikx-sig-probe')?.textContent === 'SIGNED-ASSET-EXECUTED',
      null,
      { timeout: 10000 },
    );

    // The unsigned twin never appears anywhere.
    const unsignedCount = await page.evaluate(() => document.querySelectorAll('[data-plugin-toolbar-action^="sig-proof-unsigned"]').length);
    assert.equal(unsignedCount, 0, 'the unsigned plugin must never mount');

    // Inventory: signed present, unsigned refused, mode reported as required.
    // Fetched THROUGH the app's own _getJSON so the session auth the real
    // client uses is identical (a raw fetch carries no session header — the
    // auth lives in sessionStorage, not cookies).
    const inventory = await page.evaluate(async () => {
      const app = document.querySelector('kikx-app');
      if (typeof app?._getJSON !== 'function') return { error: 'no app._getJSON' };
      try {
        return await app._getJSON('/api/v1/plugins');
      } catch (error) {
        return { error: String(error) };
      }
    });
    assert.ok(!inventory?.error, `inventory fetch failed: ${JSON.stringify(inventory)}`);
    const data = inventory?.data && typeof inventory.data === 'object' ? inventory.data : inventory;
    const names = (data?.plugins || []).map((plugin) => plugin.name);
    assert.ok(names.includes(PLUGIN_NAME), `signed plugin in inventory: ${JSON.stringify(names)}`);
    assert.ok(!names.includes(UNSIGNED_NAME), `unsigned twin must be refused: ${JSON.stringify(names)}`);
    assert.equal(data?.signatureMode, 'required',
      `inventory must report the authoritative mode: ${JSON.stringify(data?.signatureMode)}`);

    assert.deepEqual(errors, [], 'no page errors while loading signed plugin code');
  } finally {
    await browser?.close();
    await fixture?.close();
    if (previous.mode === undefined) delete process.env.KIKX_PLUGIN_SIGNATURE_MODE;
    else process.env.KIKX_PLUGIN_SIGNATURE_MODE = previous.mode;
    if (previous.keys === undefined) delete process.env.KIKX_PLUGIN_SIGNING_PUBLIC_KEYS;
    else process.env.KIKX_PLUGIN_SIGNING_PUBLIC_KEYS = previous.keys;
  }
});
