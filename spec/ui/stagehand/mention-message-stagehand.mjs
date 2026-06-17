'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { Stagehand } from '@browserbasehq/stagehand';

import {
  findChromeExecutable,
  loadStagehandOpenAIAPIKey,
  startStagehandUIServer,
} from './stagehand-test-utils.mjs';

test('Stagehand sends an @mention message and the API exposes mention metadata', async (t) => {
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
      { id: 'session_1', title: 'Mention Smoke' },
    ],
    agents: [
      { id: 'agent_mention', name: 'Mention Bot', pluginID: 'test-agent', enabled: true },
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
    await page.waitForSelector('.kikx-composer textarea:not([disabled])', { timeout: 10000 });

    let focusResult = await stagehand.act(
      'Click into the message composer textarea.',
      {
        page,
        timeout: 20000,
      },
    );
    assert.equal(focusResult.success, true, focusResult.message || 'Stagehand did not focus the message composer');

    await page.evaluate(() => {
      let originalFetch = window.fetch.bind(window);
      let releaseMessagePost = null;
      window.__kikxMessagePostStarted = false;
      window.__kikxReleaseMessagePost = () => releaseMessagePost?.();
      window.fetch = async (input, init = {}) => {
        let url = typeof input === 'string' ? input : input?.url || '';
        let method = String(init?.method || 'GET').toUpperCase();
        if (url.includes('/api/v1/sessions/session_1/messages') && method === 'POST') {
          window.__kikxMessagePostStarted = true;
          await new Promise((resolve) => {
            releaseMessagePost = resolve;
          });
        }

        return await originalFetch(input, init);
      };
    });

    await page.locator('.kikx-composer textarea').fill('Please review this @"Mention Bot"');

    await page.locator('.kikx-composer .kikx-send-button').click();
    await waitForPageFlag(page, '__kikxMessagePostStarted');
    await waitForComposerValue(page, '');
    await page.evaluate(() => window.__kikxReleaseMessagePost?.());

    await page.waitForSelector('.kikx-frame--UserMessage', { timeout: 10000 });
    await waitForComposerValue(page, '');
    fixture.frameRuntime.emitEvent('session.saved', {
      sessionID: 'session_1',
      session: {
        ...fixture.frameRuntime.sessions[0],
        updatedAt: Date.now(),
      },
    });
    await delay(300);
    await waitForComposerValue(page, '');
    let frames = await page.evaluate(async () => {
      let response = await fetch('/api/v1/sessions/session_1/frames');
      return (await response.json()).data.frames;
    });
    let message = frames.find((frame) => frame.type === 'UserMessage');

    assert.equal(message.content.text, 'Please review this @"Mention Bot"');
    assert.deepEqual(message.mentions.agent_mention, {
      id: 'agent_mention',
      type: 'agent',
      name: 'Mention Bot',
      username: null,
      fullName: 'Mention Bot',
      reference: 'Mention Bot',
    });
  } finally {
    await stagehand.close().catch(() => {});
    await fixture.close().catch(() => {});
    if (previousOpenAIAPIKey == null)
      delete process.env.OPENAI_API_KEY;
    else
      process.env.OPENAI_API_KEY = previousOpenAIAPIKey;
  }
});

async function waitForComposerValue(page, expectedValue, timeoutMS = 10000) {
  let startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMS) {
    let value = await page.locator('.kikx-composer textarea').inputValue();
    if (value === expectedValue)
      return;

    await delay(100);
  }

  throw new Error(`Timed out waiting for composer value ${JSON.stringify(expectedValue)}`);
}

async function waitForPageFlag(page, flagName, timeoutMS = 10000) {
  let startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMS) {
    let value = await page.evaluate((name) => Boolean(window[name]), flagName);
    if (value)
      return;

    await delay(100);
  }

  throw new Error(`Timed out waiting for page flag ${flagName}`);
}

async function delay(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
