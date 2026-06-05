'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { Stagehand } from '@browserbasehq/stagehand';

import {
  findChromeExecutable,
  loadStagehandOpenAIAPIKey,
  startStagehandUIServer,
} from './stagehand-test-utils.mjs';

test('Stagehand creates a new session from the Sessions sidebar', async (t) => {
  let chromePath = findChromeExecutable();
  if (!chromePath) {
    t.skip('Stagehand local mode requires Chrome');
    return;
  }

  let openAIAPIKey = await loadStagehandOpenAIAPIKey();
  if (!openAIAPIKey) {
    t.skip('Set OPENAI_API_KEY or create a Test 1 Kikx agent with an apiKey secret');
    return;
  }

  let previousOpenAIAPIKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = openAIAPIKey;

  let fixture = await startStagehandUIServer({
    sessions: [
      { id: 'session_1', title: 'Session 1' },
    ],
  });
  let stagehand = new Stagehand({
    env: 'LOCAL',
    model: process.env.KIKX_STAGEHAND_MODEL || 'openai/gpt-4.1-mini',
    verbose: 0,
    domSettleTimeout: 750,
    localBrowserLaunchOptions: {
      headless: process.env.KIKX_STAGEHAND_HEADLESS === '0' ? false : true,
      executablePath: chromePath,
      chromiumSandbox: false,
      viewport: { width: 1280, height: 900 },
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
      ],
      connectTimeoutMs: 30000,
    },
  });

  try {
    await stagehand.init();
    let page = stagehand.context.pages()[0];
    await page.goto(`${fixture.baseURL}/?code=stagehand-test`, {
      waitUntil: 'domcontentloaded',
      timeout: 10000,
    });
    await page.waitForSelector('.kikx-session-list', { timeout: 10000 });

    let beforeCount = await page.locator('.kikx-session-list > li').count();
    let result = await stagehand.act(
      'Click the plus button beside the Sessions heading to create a new session.',
      {
        page,
        timeout: 20000,
      },
    );
    assert.equal(result.success, true, result.message || 'Stagehand did not report a successful click');

    await waitForSessionCount(page, beforeCount + 1);
    let afterCount = await page.locator('.kikx-session-list > li').count();
    let selectedTitle = await page.locator('.kikx-session-list > li.is-selected strong').first().textContent();

    assert.equal(afterCount, beforeCount + 1);
    assert.equal(selectedTitle, 'Session 2');
  } finally {
    await stagehand.close().catch(() => {});
    await fixture.close().catch(() => {});
    if (previousOpenAIAPIKey == null)
      delete process.env.OPENAI_API_KEY;
    else
      process.env.OPENAI_API_KEY = previousOpenAIAPIKey;
  }
});

async function waitForSessionCount(page, expectedCount, timeoutMS = 10000) {
  let startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMS) {
    let count = await page.locator('.kikx-session-list > li').count();
    if (count >= expectedCount)
      return;

    await delay(100);
  }

  throw new Error(`Timed out waiting for ${expectedCount} sessions`);
}

async function delay(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
