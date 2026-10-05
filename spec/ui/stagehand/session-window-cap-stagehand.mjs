'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { Stagehand } from '@browserbasehq/stagehand';

import {
  findChromeExecutable,
  loadStagehandOpenAIAPIKey,
  startStagehandUIServer,
} from './stagehand-test-utils.mjs';

const SEEDED_FRAMES = 320;
const MAX_DOM_ITEMS = 200;

test('Stagehand caps rendered thread items and trims when scrolling up through history', async (t) => {
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
      { id: 'session_1', title: 'Long Thread', messageCount: SEEDED_FRAMES },
    ],
  });
  fixture.frameRuntime.framesBySessionID.set('session_1', createLongThreadFrames(SEEDED_FRAMES));

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
    await page.goto(`${fixture.baseURL}/?code=stagehand-test&view=thread`, {
      waitUntil: 'domcontentloaded',
      timeout: 10000,
    });
    await page.waitForSelector('kikx-frame-item', { timeout: 10000 });

    // Scroll to the top repeatedly to page in older history; the rendered item
    // count must never exceed the client window cap.
    let maxObserved = 0;
    for (let attempt = 0; attempt < 6; attempt++) {
      let countBefore = await countRenderedItems(page);
      maxObserved = Math.max(maxObserved, countBefore);

      await page.evaluate(() => {
        let list = document.querySelector('.kikx-frame-list');
        list.scrollTop = 0;
        list.dispatchEvent(new Event('scroll', { bubbles: true }));
      });
      await page.waitForTimeout(500);
    }

    let finalCount = await countRenderedItems(page);
    maxObserved = Math.max(maxObserved, finalCount);

    // Performance contract: the DOM holds at most the capped window of items,
    // despite 320 frames existing in the session.
    assert.ok(maxObserved <= MAX_DOM_ITEMS, `rendered items ${maxObserved} must be <= ${MAX_DOM_ITEMS}`);
    assert.ok(finalCount > 0, 'thread still shows items after trimming');
  } finally {
    await stagehand.close().catch(() => {});
    await fixture.close().catch(() => {});
    if (previousOpenAIAPIKey == null)
      delete process.env.OPENAI_API_KEY;
    else
      process.env.OPENAI_API_KEY = previousOpenAIAPIKey;
  }
});

function createLongThreadFrames(count) {
  return Array.from({ length: count }, (_value, index) => {
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
        text: `Frame ${number}: enough content to render a visible thread item in the frame list.`,
      },
    };
  });
}

async function countRenderedItems(page) {
  return await page.evaluate(() => document.querySelectorAll('kikx-frame-item').length);
}
