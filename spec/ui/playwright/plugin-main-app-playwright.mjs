'use strict';

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { chromium } from 'playwright';

import {
  findChromeExecutable,
  startStagehandUIServer,
} from '../stagehand/stagehand-test-utils.mjs';

test('a plugin can replace the kikx-app shell before the built-in app is defined', async (t) => {
  let chromePath = findChromeExecutable();
  if (!chromePath) {
    t.skip('Chrome is required');
    return;
  }

  let fixture = await startStagehandUIServer({
    sessions: [{ id: 'session_1', title: 'Main app plugin', messageCount: 0 }],
    pluginPaths: path.resolve('spec/ui/playwright/fixtures/main-app-plugin'),
  });
  let browser;
  try {
    browser = await chromium.launch({ executablePath: chromePath, headless: true, args: [ '--no-sandbox' ] });
    let page = await browser.newPage();
    let errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.goto(`${fixture.baseURL}/?code=plugin-main-app`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForFunction(() => document.querySelector('kikx-app')?.textContent === 'PLUGIN SHELL', null, { timeout: 10000 });
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await fixture.close();
  }
});
