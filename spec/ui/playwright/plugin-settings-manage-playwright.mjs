'use strict';

// GAP CLOSED (owner 2026-11-14): management flows proven only at unit/route
// level. This drives the real Settings -> Plugins UI in a real browser:
// install-from-path, disable/enable, and the two-click uninstall confirm —
// everything local-filesystem, no network, fully hermetic.

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { chromium } from 'playwright';

const BOOT_PLUGIN = 'manage-boot-plugin';
const SRC_PLUGIN = 'manage-src-plugin';

async function writePlugin(dir, name) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name, main: 'index.mjs' }));
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ name, version: '1.0.0' }, null, 2));
  await fs.writeFile(path.join(dir, 'index.mjs'),
    `export const pluginName = ${JSON.stringify(name)};\n`
    + 'export function setup(provide) { provide(() => {}); }\n');
}

function cardButton(page, cardName, action) {
  // Scope a [data-action] click to the plugin card containing cardName.
  return page.evaluate(({ cardName, action }) => {
    const cards = [...document.querySelectorAll('.kikx-settings-plugin-card, [class*="plugin-card"]')];
    const card = cards.find((node) => node.textContent.includes(cardName));
    if (!card) return { ok: false, reason: 'card not found', action };
    const button = card.querySelector(`[data-action="${action}"]`);
    if (!button) return { ok: false, reason: `no ${action} button`, labels: [...card.querySelectorAll('[data-action]')].map((b) => b.getAttribute('data-action')) };
    button.click();
    return { ok: true };
  }, { cardName, action });
}

test('Settings -> Plugins management: install from path, disable/enable, two-click uninstall', async (t) => {
  const { findChromeExecutable, startStagehandUIServer } = await import(
    '../stagehand/stagehand-test-utils.mjs'
  );
  const chromePath = findChromeExecutable();
  if (!chromePath) {
    t.skip('Chrome is required');
    return;
  }

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-manage-e2e-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const managedRoot = path.join(tmp, 'managed');
  const sourceDir = path.join(tmp, 'source');
  await writePlugin(managedRoot, BOOT_PLUGIN);   // configured root => managed => uninstallable
  await writePlugin(sourceDir, SRC_PLUGIN);      // plain dir => install-from-path source

  const previous = {
    install: process.env.KIKX_PLUGIN_INSTALL_ENABLED,
    paths: process.env.KIKX_PLUGIN_PATHS,
    npmDir: process.env.KIKX_PLUGIN_NPM_DIR,
  };
  process.env.KIKX_PLUGIN_INSTALL_ENABLED = 'true';
  process.env.KIKX_PLUGIN_PATHS = managedRoot;
  process.env.KIKX_PLUGIN_NPM_DIR = path.join(tmp, 'npm');

  let fixture;
  let browser;
  try {
    fixture = await startStagehandUIServer({
      sessions: [{ id: 'session_1', title: 'Manage flows', messageCount: 0 }],
      // MUST be the option, not env: the fixture resolves pluginPaths as an
      // option FIRST and otherwise short-circuits plugin loading entirely
      // (measured: env-configured roots with no option => "No plugins are
      // loaded"), 2026-11-14.
      pluginPaths: managedRoot,
    });
    browser = await chromium.launch({ executablePath: chromePath, headless: true, args: [ '--no-sandbox' ] });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.addInitScript(() => {
      sessionStorage.setItem('kikx.auth.session', JSON.stringify({ token: 'identity-token', refresh_token: 'identity-refresh' }));
    });

    const url = `${fixture.baseURL}/?session=session_1&view=settings&section=Plugins`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForSelector('.kikx-settings-plugins', { timeout: 10000 });

    // 1. The configured-root plugin is on its card with the management row.
    await page.waitForFunction(
      (name) => document.body.textContent.includes(name), BOOT_PLUGIN, { timeout: 10000 },
    );
    let click = await cardButton(page, BOOT_PLUGIN, 'disable');
    assert.deepEqual(click, { ok: true }, `disable on ${BOOT_PLUGIN}: ${JSON.stringify(click)}`);
    await page.waitForFunction(
      (name) => {
        const cards = [...document.querySelectorAll('[class*="plugin-card"]')];
        const card = cards.find((node) => node.textContent.includes(name));
        return Boolean(card && card.querySelector('[data-action="enable"]'));
      }, BOOT_PLUGIN, { timeout: 10000 },
    );
    click = await cardButton(page, BOOT_PLUGIN, 'enable');
    assert.deepEqual(click, { ok: true }, `enable on ${BOOT_PLUGIN}: ${JSON.stringify(click)}`);
    await page.waitForFunction(
      (name) => {
        const cards = [...document.querySelectorAll('[class*="plugin-card"]')];
        const card = cards.find((node) => node.textContent.includes(name));
        return Boolean(card && card.querySelector('[data-action="disable"]'));
      }, BOOT_PLUGIN, { timeout: 10000 },
    );

    // 2. Install from path: the UI posts {path} and the card appears.
    await page.fill('.kikx-settings-plugins__path', sourceDir);
    await page.click('button:has-text("Install from path")');
    await page.waitForFunction(
      (name) => document.body.textContent.includes(name), SRC_PLUGIN, { timeout: 15000 },
    );

    // 3. Uninstall: first click arms (Confirm Uninstall), second fires, card goes.
    click = await cardButton(page, BOOT_PLUGIN, 'uninstall');
    assert.deepEqual(click, { ok: true }, `uninstall arm on ${BOOT_PLUGIN}: ${JSON.stringify(click)}`);
    await page.waitForFunction(
      (name) => {
        const cards = [...document.querySelectorAll('[class*="plugin-card"]')];
        const card = cards.find((node) => node.textContent.includes(name));
        return Boolean(card && card.textContent.includes('Confirm Uninstall'));
      }, BOOT_PLUGIN, { timeout: 10000 },
    );
    click = await cardButton(page, BOOT_PLUGIN, 'uninstall');
    assert.deepEqual(click, { ok: true }, `uninstall confirm on ${BOOT_PLUGIN}: ${JSON.stringify(click)}`);
    await page.waitForFunction(
      (name) => {
        const cards = [...document.querySelectorAll('[class*="plugin-card"]')];
        return !cards.some((node) => node.textContent.includes(name));
      }, BOOT_PLUGIN, { timeout: 15000 },
    );

    assert.deepEqual(errors, [], 'no page errors through the management flows');
  } finally {
    await browser?.close();
    await fixture?.close();
    for (const [ key, value ] of Object.entries({ KIKX_PLUGIN_INSTALL_ENABLED: previous.install, KIKX_PLUGIN_PATHS: previous.paths, KIKX_PLUGIN_NPM_DIR: previous.npmDir })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
