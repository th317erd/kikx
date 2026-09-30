'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { Stagehand } from '@browserbasehq/stagehand';

import {
  findChromeExecutable,
  loadStagehandOpenAIAPIKey,
  startStagehandUIServer,
} from './stagehand-test-utils.mjs';

test('Stagehand updates account profile and uses the display name on user messages', async (t) => {
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
      { id: 'session_1', title: 'Account Smoke', messageCount: 0 },
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
      viewport: { width: 1280, height: 800 },
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
    await page.goto(`${fixture.baseURL}/?code=stagehand-test&view=thread`, {
      waitUntil: 'domcontentloaded',
      timeout: 10000,
    });

    await page.waitForSelector('.kikx-topbar__actions button', { timeout: 10000 });
    await page.locator('.kikx-topbar__actions button').first().click();
    await page.waitForSelector('.kikx-account-form', { timeout: 10000 });
    await waitForTwoAnimationFrames(page);
    await page.evaluate(() => {
      setAeorInputValue('.kikx-account-form aeor-input[name="name"] input', 'Stagehand User');
      setAeorInputValue('.kikx-account-form aeor-input[name="email"] input', 'stagehand@example.com');

      function setAeorInputValue(selector, value) {
        let input = document.querySelector(selector);
        if (!input)
          throw new Error(`Missing account input: ${selector}`);

        input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    // Click the actual Save button. The modal lifts .modal-footer-actions out of
    // the form, so this must be wired via onClick (not type=submit); clicking it
    // is the behavior a user relies on and the case that regressed.
    await page.evaluate(() => {
      let save = Array.from(document.querySelectorAll('aeor-modal[title="Account"] button'))
        .find((candidate) => candidate.textContent.trim() === 'Save');
      if (!save)
        throw new Error('Missing account Save button');

      save.click();
    });
    await waitForPagePredicate(page, () => document.querySelector('.kikx-account-chip')?.textContent?.includes('Stagehand User'));

    await page.locator('.kikx-composer textarea').fill('This should render with my account name.');
    await page.locator('.kikx-composer .kikx-send-button').click();
    await page.waitForSelector('.kikx-frame--UserMessage', { timeout: 10000 });

    let result = await page.evaluate(() => {
      let frame = document.querySelector('.kikx-frame--UserMessage');
      return {
        label: frame?.querySelector('.kikx-frame__meta-main strong')?.textContent || '',
        text: frame?.textContent || '',
      };
    });

    assert.equal(result.label, 'Stagehand User');
    assert.match(result.text, /This should render with my account name\./);
  } finally {
    await stagehand.close().catch(() => {});
    await fixture.close();
    if (previousOpenAIAPIKey == null)
      delete process.env.OPENAI_API_KEY;
    else
      process.env.OPENAI_API_KEY = previousOpenAIAPIKey;
  }
});

async function waitForTwoAnimationFrames(page) {
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
}

async function waitForPagePredicate(page, predicate, timeoutMS = 10000) {
  let start = Date.now();
  while (Date.now() - start < timeoutMS) {
    if (await page.evaluate(predicate))
      return;

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error('Timed out waiting for page predicate');
}
