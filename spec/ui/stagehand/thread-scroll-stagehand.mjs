'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { Stagehand } from '@browserbasehq/stagehand';

import {
  findChromeExecutable,
  loadStagehandOpenAIAPIKey,
  startStagehandUIServer,
} from './stagehand-test-utils.mjs';

test('Stagehand keeps the message thread scrollable and anchored to the bottom', async (t) => {
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
      { id: 'session_1', title: 'Scrollable Thread', messageCount: 48 },
    ],
    agents: [
      { id: 'agent_scroll', name: 'Scroll Agent', pluginID: 'test-agent', enabled: true },
    ],
  });
  fixture.frameRuntime.framesBySessionID.set('session_1', createScrollableFrames());

  let stagehand = new Stagehand({
    env: 'LOCAL',
    model: process.env.KIKX_STAGEHAND_MODEL || 'openai/gpt-4.1-mini',
    verbose: 0,
    domSettleTimeout: 750,
    localBrowserLaunchOptions: {
      headless: process.env.KIKX_STAGEHAND_HEADLESS === '0' ? false : true,
      executablePath: chromePath,
      chromiumSandbox: false,
      viewport: { width: 1280, height: 720 },
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
    await page.waitForSelector('kikx-frame-item[data-frame-id="frame_48"]', { timeout: 10000 });
    await waitForThreadBottom(page);

    let initial = await readThreadScrollMetrics(page);
    assert.equal(initial.canScroll, true);
    assert.equal(initial.atBottom, true);

    await page.evaluate(() => {
      let list = document.querySelector('.kikx-frame-list');
      list.scrollTop = 0;
      list.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    await waitForThreadTop(page);

    let afterScroll = await readThreadScrollMetrics(page);
    assert.equal(afterScroll.canScroll, true);
    assert.equal(afterScroll.atTop, true);
    assert.equal(afterScroll.atBottom, false);
  } finally {
    await stagehand.close().catch(() => {});
    await fixture.close().catch(() => {});
    if (previousOpenAIAPIKey == null)
      delete process.env.OPENAI_API_KEY;
    else
      process.env.OPENAI_API_KEY = previousOpenAIAPIKey;
  }
});

function createScrollableFrames() {
  return Array.from({ length: 48 }, (_value, index) => {
    let number = index + 1;
    let timestamp = 1781035260000000 + (number * 1000000);
    return {
      id: `frame_${number}`,
      type: number % 2 === 0 ? 'AgentMessage' : 'UserMessage',
      sessionID: 'session_1',
      interactionID: `interaction_${number}`,
      authorType: number % 2 === 0 ? 'agent' : 'user',
      authorID: number % 2 === 0 ? 'agent_scroll' : 'stagehand-user',
      authorDisplayName: number % 2 === 0 ? 'Scroll Agent' : 'User',
      hidden: false,
      deleted: false,
      order: number,
      createdAt: timestamp,
      updatedAt: timestamp,
      content: {
        text: `Frame ${number}: this message has enough content to make the thread overflow its viewport and prove the frame list is the scroll container.`,
      },
    };
  });
}

async function readThreadScrollMetrics(page) {
  return await page.evaluate(() => {
    let list = document.querySelector('.kikx-frame-list');
    let scrollTop = list?.scrollTop || 0;
    let clientHeight = list?.clientHeight || 0;
    let scrollHeight = list?.scrollHeight || 0;
    let distanceFromBottom = scrollHeight - scrollTop - clientHeight;
    return {
      scrollTop,
      clientHeight,
      scrollHeight,
      canScroll: scrollHeight > clientHeight,
      atTop: scrollTop <= 5,
      atBottom: distanceFromBottom <= 5,
      distanceFromBottom,
    };
  });
}

async function waitForThreadBottom(page, timeoutMS = 10000) {
  let startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMS) {
    let metrics = await readThreadScrollMetrics(page);
    if (metrics.canScroll && metrics.atBottom)
      return;

    await delay(100);
  }

  throw new Error('Timed out waiting for the frame list to anchor at the bottom');
}

async function waitForThreadTop(page, timeoutMS = 5000) {
  let startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMS) {
    let metrics = await readThreadScrollMetrics(page);
    if (metrics.atTop)
      return;

    await delay(100);
  }

  throw new Error('Timed out waiting for the frame list to scroll to the top');
}

async function delay(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
