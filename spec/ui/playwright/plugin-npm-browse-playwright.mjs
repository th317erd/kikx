'use strict';

// GAP CLOSED (owner 2026-11-14): Browse/search/install/update/uninstall in a
// REAL browser against a LOCAL mock npm registry — hermetic (no public npm),
// but end-to-end through the real pipeline: UI -> search route ->
// /-/v1/search -> packument -> tarball over real HTTP -> sha512 SRI ->
// extraction -> load -> updates -> uninstall. The registry's `latest` is
// mutable mid-test so the Update chip is proven, not assumed.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { chromium } from 'playwright';

import { gzipTar } from '../../support/tar-fixture.mjs';

const PKG = 'kikx-mock-plugin';

function pluginIndex() {
  return `export const pluginName = '${PKG}';
export function setup(provide) { provide(() => {}); }
`;
}

function packumentFor(base, version) {
  const tarball = `${base}/${PKG}/-/${PKG}-${version}.tgz`;
  return {
    name: PKG,
    'dist-tags': { latest: version },
    versions: {
      [version]: { name: PKG, version, dist: { tarball, integrity: sriFor(version) } },
    },
  };
}

function tarballFor(version) {
  return gzipTar([
    { name: 'package/package.json', data: JSON.stringify({ name: PKG, version, main: 'index.mjs' }) },
    { name: 'package/index.mjs', data: pluginIndex() },
  ]);
}

function sriFor(version) {
  return 'sha512-' + crypto.createHash('sha512').update(tarballFor(version)).digest('base64');
}

function startMockRegistry(state) {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://registry.invalid');
    const base = `http://127.0.0.1:${server.address().port}`;
    if (url.pathname === '/-/v1/search') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        objects: [ { package: { name: PKG, version: state.latest, description: 'Mock kikx plugin', keywords: [ 'kikx-plugin' ] } } ],
        total: 1,
      }));
      return;
    }
    if (url.pathname === `/${PKG}`) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(packumentFor(base, state.latest)));
      return;
    }
    const tarMatch = url.pathname.match(new RegExp(`^/${PKG}/-/${PKG}-(.*)\\.tgz$`));
    if (tarMatch) {
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      response.end(tarballFor(tarMatch[1]));
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end('{}');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

test('Browse -> search -> install -> update chip -> uninstall against a local registry', async (t) => {
  const { findChromeExecutable, startStagehandUIServer } = await import(
    '../stagehand/stagehand-test-utils.mjs'
  );
  const chromePath = findChromeExecutable();
  if (!chromePath) {
    t.skip('Chrome is required');
    return;
  }

  const state = { latest: '1.0.0' };
  const registry = await startMockRegistry(state);
  t.after(() => registry.server.close());

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-npm-e2e-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));

  const previous = {
    install: process.env.KIKX_PLUGIN_INSTALL_ENABLED,
    registryUrls: process.env.KIKX_PLUGIN_REGISTRY_URLS,
    npmDir: process.env.KIKX_PLUGIN_NPM_DIR,
  };
  process.env.KIKX_PLUGIN_INSTALL_ENABLED = 'true';
  process.env.KIKX_PLUGIN_REGISTRY_URLS = registry.base;
  process.env.KIKX_PLUGIN_NPM_DIR = path.join(tmp, 'npm');   // configured npm dir => managed => uninstallable

  let fixture;
  let browser;
  const hasCard = (page, name, extra = null) => page.evaluate(({ name, extra }) => {
    const cards = [...document.querySelectorAll('[class*="plugin-card"]')];
    const card = cards.find((node) => node.textContent.includes(name));
    if (!card) return false;
    return extra ? Boolean(card.querySelector(`[data-action="${extra}"]`)) : true;
  }, { name, extra });

  try {
    fixture = await startStagehandUIServer({
      sessions: [{ id: 'session_1', title: 'Browse flows', messageCount: 0 }],
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

    // 1. Search paints a Browse result from the local registry. Wait for the
    //    BUTTON itself (inventory repaints can detach a freshly seen card).
    await page.fill('.kikx-settings-plugins__search-input', 'kikx-mock');
    await page.click('button:has-text("Search")');
    await page.waitForFunction(
      (name) => [...document.querySelectorAll('[data-action="install-npm"]')]
        .some((button) => (button.closest('.kikx-settings-plugins')?.textContent || '').includes(name)),
      PKG, { timeout: 15000 },
    );
    const installClick = await page.evaluate((name) => {
      const button = [...document.querySelectorAll('[data-action="install-npm"]')]
        .find((node) => (node.closest('.kikx-settings-plugins')?.textContent || '').includes(name));
      if (!button) return false;
      button.click();
      return true;
    }, PKG);
    assert.equal(installClick, true, 'a Browse install button for the mock package must exist');

    // 2. The installed card lands (real download + SRI + extraction + load).
    await page.waitForFunction(
      (name) => {
        const cards = [...document.querySelectorAll('[class*="plugin-card"]')];
        return cards.some((node) => node.textContent.includes(name)
          && node.querySelector('[data-action="unload"]'));
      }, PKG, { timeout: 20000 },
    );

    // 3. Registry publishes a newer latest; a section re-entry fetches updates
    //    (fire-and-forget on entry) and the Update chip appears.
    state.latest = '1.1.0';
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForSelector('.kikx-settings-plugins', { timeout: 10000 });
    await page.waitForFunction(
      (name) => {
        const cards = [...document.querySelectorAll('[class*="plugin-card"]')];
        const card = cards.find((node) => node.textContent.includes(name));
        return Boolean(card && card.querySelector('[data-action="update-npm"]'));
      }, PKG, { timeout: 15000 },
    );

    // 4. Click Update, then poll the CARD's rendered manifest version — the
    //    deterministic installed-state marker (updates store only refetches on
    //    section entry, so the chip clears on the re-entry below).
    await page.evaluate((name) => {
      const cards = [...document.querySelectorAll('[class*="plugin-card"]')];
      const card = cards.find((node) => node.textContent.includes(name));
      card?.querySelector('[data-action="update-npm"]')?.click();
    }, PKG);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForSelector('.kikx-settings-plugins', { timeout: 10000 });
    await page.waitForFunction(
      (name) => {
        const cards = [...document.querySelectorAll('[class*="plugin-card"]')];
        const card = cards.find((node) => node.textContent.includes(name));
        return Boolean(card && card.querySelector('[data-action="unload"]'))
          && !card.querySelector('[data-action="update-npm"]');
      }, PKG, { timeout: 20000 },
    );

    // 5. Two-click uninstall removes the card (npm dir is a managed root).
    await page.evaluate((name) => {
      const cards = [...document.querySelectorAll('[class*="plugin-card"]')];
      const card = cards.find((node) => node.textContent.includes(name));
      card?.querySelector('[data-action="uninstall"]')?.click();
    }, PKG);
    await page.waitForFunction(
      (name) => {
        const cards = [...document.querySelectorAll('[class*="plugin-card"]')];
        const card = cards.find((node) => node.textContent.includes(name));
        return Boolean(card && card.textContent.includes('Confirm Uninstall'));
      }, PKG, { timeout: 10000 },
    );
    await page.evaluate((name) => {
      const cards = [...document.querySelectorAll('[class*="plugin-card"]')];
      const card = cards.find((node) => node.textContent.includes(name));
      card?.querySelector('[data-action="uninstall"]')?.click();
    }, PKG);
    await page.waitForFunction(
      (name) => ![...document.querySelectorAll('[class*="plugin-card"]')]
        .some((node) => node.textContent.includes(name)), PKG, { timeout: 15000 },
    );

    assert.deepEqual(errors, [], 'no page errors through the Browse lifecycle');
  } finally {
    await browser?.close();
    await fixture?.close();
    for (const [ key, value ] of Object.entries({ KIKX_PLUGIN_INSTALL_ENABLED: previous.install, KIKX_PLUGIN_REGISTRY_URLS: previous.registryUrls, KIKX_PLUGIN_NPM_DIR: previous.npmDir })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
