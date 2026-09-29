'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { Stagehand } from '@browserbasehq/stagehand';

import {
  findChromeExecutable,
  loadStagehandOpenAIAPIKey,
  startStagehandUIServer,
} from './stagehand-test-utils.mjs';

test('Stagehand creates a new session from the workspace grid', async (t) => {
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
    await page.waitForSelector('kikx-session-card', { timeout: 10000 });

    let beforeCount = await page.locator('kikx-session-card').count();
    let result = await stagehand.act(
      'Click the plus button beside the Sessions heading in the workspace to create a new session.',
      {
        page,
        timeout: 20000,
      },
    );
    assert.equal(result.success, true, result.message || 'Stagehand did not report a successful click');

    // Creating a session opens its thread view (stack depth 2).
    await waitForThreadTitle(page, 'Session 2');
    let stackDepth = await page.evaluate(() => document.querySelector('kikx-app')?._state?.navigationStack?.length);
    assert.equal(stackDepth, 2);

    // Closing it returns to the workspace grid with the new card.
    await clickButtonByTitle(page, 'Close session');
    await waitForSessionCount(page, beforeCount + 1);
    let afterCount = await page.locator('kikx-session-card').count();

    assert.equal(afterCount, beforeCount + 1);
  } finally {
    await stagehand.close().catch(() => {});
    await fixture.close().catch(() => {});
    if (previousOpenAIAPIKey == null)
      delete process.env.OPENAI_API_KEY;
    else
      process.env.OPENAI_API_KEY = previousOpenAIAPIKey;
  }
});

async function waitForThreadTitle(page, expectedTitle, timeoutMS = 10000) {
  let startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMS) {
    let title = await page.evaluate(() => document.querySelector('.kikx-thread__header h2')?.textContent || '');
    if (title === expectedTitle)
      return;

    await delay(100);
  }

  throw new Error(`Timed out waiting for thread title: ${expectedTitle}`);
}

async function clickButtonByTitle(page, title) {
  await page.evaluate((label) => {
    let button = Array.from(document.querySelectorAll('button')).find((candidate) => candidate.title === label);
    if (!button)
      throw new Error(`Missing button: ${label}`);

    button.click();
  }, title);
}

async function waitForSessionCount(page, expectedCount, timeoutMS = 10000) {
  let startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMS) {
    let count = await page.locator('kikx-session-card').count();
    if (count >= expectedCount)
      return;

    await delay(100);
  }

  throw new Error(`Timed out waiting for ${expectedCount} sessions`);
}

async function delay(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
