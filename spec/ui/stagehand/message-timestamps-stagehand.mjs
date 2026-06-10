'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { Stagehand } from '@browserbasehq/stagehand';

import {
  findChromeExecutable,
  loadStagehandOpenAIAPIKey,
  startStagehandUIServer,
} from './stagehand-test-utils.mjs';

test('Stagehand renders timestamps on visible message frames', async (t) => {
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
      { id: 'session_1', title: 'Timestamp Smoke', messageCount: 2 },
    ],
    agents: [
      { id: 'agent_timekeeper', name: 'Timekeeper', pluginID: 'test-agent', enabled: true },
    ],
  });
  fixture.frameRuntime.framesBySessionID.set('session_1', [
    {
      id: 'user_msg_1',
      type: 'UserMessage',
      sessionID: 'session_1',
      interactionID: 'interaction_1',
      authorType: 'user',
      authorID: 'stagehand-user',
      hidden: false,
      deleted: false,
      order: 1,
      createdAt: 1781035262345678,
      updatedAt: 1781035262345678,
      content: { text: 'What time is this frame?' },
    },
    {
      id: 'agent_msg_1',
      type: 'AgentMessage',
      sessionID: 'session_1',
      interactionID: 'interaction_2',
      parentID: 'user_msg_1',
      authorType: 'agent',
      authorID: 'agent_timekeeper',
      authorDisplayName: 'Timekeeper',
      hidden: false,
      deleted: false,
      order: 2,
      createdAt: 1781035263456789,
      updatedAt: 1781035263456789,
      content: { text: 'This frame also has an exact timestamp.' },
    },
  ]);

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
    await page.waitForSelector('.kikx-frame__timestamp', { timeout: 10000 });

    let timestamps = await page.evaluate(() => Array.from(document.querySelectorAll('.kikx-frame')).map((frame) => {
      let timestamp = frame.querySelector('.kikx-frame__timestamp');
      return {
        frameClass: Array.from(frame.classList).find((className) => className.startsWith('kikx-frame--')) || '',
        text: timestamp?.textContent || '',
        dateTime: timestamp?.getAttribute('datetime') || '',
        title: timestamp?.getAttribute('title') || '',
      };
    }));

    assert.deepEqual(timestamps.map((entry) => entry.frameClass), [
      'kikx-frame--UserMessage',
      'kikx-frame--AgentMessage',
    ]);
    assert.deepEqual(timestamps.map((entry) => entry.dateTime), [
      '2026-06-09T20:01:02.345678Z',
      '2026-06-09T20:01:03.456789Z',
    ]);
    assert.deepEqual(timestamps.map((entry) => entry.title), timestamps.map((entry) => entry.dateTime));
    assert.equal(timestamps.every((entry) => entry.text.trim().length > 0), true);
  } finally {
    await stagehand.close().catch(() => {});
    await fixture.close().catch(() => {});
    if (previousOpenAIAPIKey == null)
      delete process.env.OPENAI_API_KEY;
    else
      process.env.OPENAI_API_KEY = previousOpenAIAPIKey;
  }
});
