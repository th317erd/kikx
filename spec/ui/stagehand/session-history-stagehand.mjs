'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { Stagehand } from '@browserbasehq/stagehand';

import {
  findChromeExecutable,
  loadStagehandOpenAIAPIKey,
  startStagehandUIServer,
} from './stagehand-test-utils.mjs';

test('Stagehand opens a long session at the newest page and prepends older frames on scroll-up', async (t) => {
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
      { id: 'session_1', title: 'Long History', messageCount: 130 },
    ],
    agents: [
      { id: 'agent_history', name: 'History Agent', pluginID: 'test-agent', enabled: true },
    ],
  });

  let totalFrames = 130;
  fixture.frameRuntime.framesBySessionID.set('session_1', createLongHistory(totalFrames));

  let windowRequests = [];
  let originalListFrameWindow = fixture.frameRuntime.listFrameWindow.bind(fixture.frameRuntime);
  fixture.frameRuntime.listFrameWindow = async (sessionID, options = {}) => {
    windowRequests.push({ sessionID, options: { ...options } });
    return await originalListFrameWindow(sessionID, options);
  };

  let stagehand = new Stagehand({
    env: 'LOCAL',
    model: process.env.KIKX_STAGEHAND_MODEL || 'openai/gpt-4.1-mini',
    verbose: 0,
    domSettleTimeout: 750,
    localBrowserLaunchOptions: {
      headless: process.env.KIKX_STAGEHAND_HEADLESS === '0' ? false : true,
      executablePath: chromePath,
      chromiumSandbox: false,
      viewport: { width: 1100, height: 720 },
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

    // Newest page shows the newest frames and anchors to the bottom.
    await page.waitForSelector(`kikx-frame-item[data-frame-id="frame_${totalFrames}"]`, { timeout: 10000 });
    await waitForThreadBottom(page);

    let initialMetrics = await readThreadScrollMetrics(page);
    assert.equal(initialMetrics.canScroll, true, 'long session must overflow its viewport');
    assert.equal(initialMetrics.atBottom, true, 'the thread must open anchored to the bottom');

    let initial = await readFrameIDs(page);
    assert.ok(initial.includes(`frame_${totalFrames}`), 'the newest frame is rendered on open');
    // Pagination is page-based, not item-count based (owner, 2026-11-14): the
    // open renders the newest page as one contiguous run ending at the newest
    // frame. Assert the MODEL, never a magic page size.
    let openFirstOrder = Number((initial[0] || '').split('_')[1]);
    assert.ok(initial.every((id, index) => id === `frame_${openFirstOrder + index}`),
      `the open must render one contiguous newest run, got first=${initial[0]} len=${initial.length}`);
    assert.equal(initial.includes('frame_1'), false, 'the oldest frames are not loaded until requested');
    assert.equal(windowRequests.some((request) => request.options.before != null), false);

    // Scroll near the top; the older frames reveal from state. No
    // listFrameWindow `before` refetch is expected: the full frame list
    // remains in state so older pages reveal WITHOUT a refetch (see the
    // render-window comment in kikx-chat-view). The old before-cursor
    // asserts encoded the retired item-count pagination — removed per owner
    // ruling, 2026-11-14.
    await page.evaluate(() => {
      let list = document.querySelector('.kikx-frame-list');
      list.scrollTop = 0;
      list.dispatchEvent(new Event('scroll', { bubbles: true }));
    });

    await page.waitForSelector('kikx-frame-item[data-frame-id="frame_1"]', { timeout: 10000 });

    let after = await readFrameIDs(page);
    assert.ok(after.includes('frame_1'), 'older frames are prepended on scroll-up');
    assert.ok(after.includes(`frame_${totalFrames}`), 'newer frames are not regressed by the prepend');
    assert.equal(after[0], 'frame_1', 'older frames are inserted before the existing newer frames');
    assert.equal(after.at(-1), `frame_${totalFrames}`, 'the newest frame stays last after prepending');

    // Prepending must not jump the viewport to the bottom.
    let afterMetrics = await readThreadScrollMetrics(page);
    assert.equal(afterMetrics.atBottom, false, 'the viewport must not be pushed to the bottom by a prepend');
  } finally {
    await stagehand.close().catch(() => {});
    await fixture.close().catch(() => {});
    if (previousOpenAIAPIKey == null)
      delete process.env.OPENAI_API_KEY;
    else
      process.env.OPENAI_API_KEY = previousOpenAIAPIKey;
  }
});

function createLongHistory(total) {
  return Array.from({ length: total }, (_value, index) => {
    let number = index + 1;
    let timestamp = 1781035260000000 + (number * 1000000);
    return {
      id: `frame_${number}`,
      type: number % 2 === 0 ? 'AgentMessage' : 'UserMessage',
      sessionID: 'session_1',
      interactionID: `interaction_${number}`,
      authorType: number % 2 === 0 ? 'agent' : 'user',
      authorID: number % 2 === 0 ? 'agent_history' : 'stagehand-user',
      authorDisplayName: number % 2 === 0 ? 'History Agent' : 'User',
      hidden: false,
      deleted: false,
      order: number,
      createdAt: timestamp,
      updatedAt: timestamp,
      content: {
        text: `Frame ${number}: this message has enough content to overflow the thread viewport and exercise lazy history paging.`,
      },
    };
  });
}

async function readFrameIDs(page) {
  return await page.evaluate(() => Array.from(
    document.querySelectorAll('.kikx-frame-list kikx-frame-item[data-frame-id]'),
  ).map((node) => node.dataset.frameId));
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
      atBottom: distanceFromBottom <= 5,
      distanceFromBottom,
    };
  });
}

async function waitForThreadBottom(page, timeoutMS = 10000) {
  await waitFor(async () => {
    let metrics = await readThreadScrollMetrics(page);
    return metrics.canScroll && metrics.atBottom;
  }, timeoutMS, 'the frame list to anchor at the bottom');
}

async function waitFor(predicate, timeoutMS, description) {
  let startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMS) {
    if (await predicate())
      return;

    await delay(50);
  }

  throw new Error(`Timed out waiting for ${description}`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
