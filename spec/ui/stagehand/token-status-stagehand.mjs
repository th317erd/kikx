'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { Stagehand } from '@browserbasehq/stagehand';

import {
  findChromeExecutable,
  loadStagehandOpenAIAPIKey,
  startStagehandUIServer,
} from './stagehand-test-utils.mjs';

test('Stagehand renders token totals in the bottom status bar', async (t) => {
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
    tokenUsageSnapshot: {
      'openai/chatgpt/codex-agent': {
        tokensUsed: 1234,
        createdAt: 'first',
        updatedAt: 'now',
      },
    },
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
    await page.waitForSelector('.kikx-statusbar__tokens', { timeout: 10000 });
    await waitForTokenText(page, 'Tokens: 1,234');

    fixture.tokenUsage.setSnapshot({
      'openai/chatgpt/codex-agent': {
        tokensUsed: 5678,
        createdAt: 'first',
        updatedAt: 'later',
      },
    });
    await waitForTokenText(page, 'Tokens: 5,678');

    let text = await page.locator('.kikx-statusbar__tokens').first().textContent();
    assert.equal(text, 'Tokens: 5,678');
  } finally {
    await stagehand.close().catch(() => {});
    await fixture.close().catch(() => {});
    if (previousOpenAIAPIKey == null)
      delete process.env.OPENAI_API_KEY;
    else
      process.env.OPENAI_API_KEY = previousOpenAIAPIKey;
  }
});

async function waitForTokenText(page, expectedText, timeoutMS = 10000) {
  let startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMS) {
    let text = await page.locator('.kikx-statusbar__tokens').first().textContent().catch(() => '');
    if (text === expectedText)
      return;

    await delay(100);
  }

  throw new Error(`Timed out waiting for status bar token text: ${expectedText}`);
}

async function delay(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
