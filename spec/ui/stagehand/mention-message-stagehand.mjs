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

    await page.locator('.kikx-composer textarea').fill('Please review this @"Mention Bot"');

    let sendResult = await stagehand.act(
      'Click the Send button in the message composer.',
      {
        page,
        timeout: 20000,
      },
    );
    assert.equal(sendResult.success, true, sendResult.message || 'Stagehand did not send the mention message');

    await page.waitForSelector('.kikx-frame--UserMessage', { timeout: 10000 });
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
