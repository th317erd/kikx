'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { Stagehand } from '@browserbasehq/stagehand';

import {
  findChromeExecutable,
  loadStagehandOpenAIAPIKey,
  startStagehandUIServer,
} from './stagehand-test-utils.mjs';

test('Stagehand batches phantom frame bursts without rerendering the full thread', async (t) => {
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
      { id: 'session_1', title: 'Phantom Burst', messageCount: 48 },
    ],
    agents: [
      { id: 'agent_stream', name: 'Stream Agent', pluginID: 'test-agent', enabled: true },
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
    await page.waitForSelector('kikx-frame-item[data-frame-id="stable_1"] .kikx-markdown', { timeout: 10000 });
    await page.waitForSelector('kikx-frame-item[data-frame-id="stable_48"]', { timeout: 10000 });
    await waitForFrameListBottom(page);
    await page.waitForTimeout(100);
    await installFrameUpdateCounter(page);
    await installScrollTracker(page);

    let text = '';
    for (let index = 1; index <= 120; index++) {
      text += `${index} `;
      fixture.frameRuntime.emitEvent('frame.phantom', {
        sessionID: 'session_1',
        frame: {
          id: `response_1:delta:${index}`,
          type: 'AgentMessageDelta',
          sessionID: 'session_1',
          interactionID: 'interaction_stream',
          parentID: 'stable_1',
          responseFrameID: 'response_1',
          authorType: 'agent',
          authorID: 'agent_stream',
          authorDisplayName: 'Stream Agent',
          phantom: true,
          hidden: true,
          deleted: false,
          order: 49,
          createdAt: 1781035360000000 + index,
          updatedAt: 1781035360000000 + index,
          content: {
            text: `${text}\n${text}\n${text}`,
            status: 'streaming',
          },
        },
      });
      if (index % 10 === 0) {
        fixture.frameRuntime.emitEvent('session.saved', {
          sessionID: 'session_1',
          session: {
            ...fixture.frameRuntime.sessions[0],
            updatedAt: Date.now() + index,
          },
        });
        await delay(5);
      }
    }

    await page.waitForSelector('kikx-frame-item[data-frame-id="response_1"]', { timeout: 10000 });
    await waitForResponseText(page, '120');
    await waitForFrameListBottom(page);

    let result = await page.evaluate(() => {
      let counts = window.__kikxFrameUpdateCounts || {};
      let response = document.querySelector('kikx-frame-item[data-frame-id="response_1"]');
      let stable = document.querySelector('kikx-frame-item[data-frame-id="stable_1"]');
      let list = document.querySelector('.kikx-frame-list');
      let samples = window.__kikxScrollSamples || [];
      let scrollTopDropped = samples.some((sample, index) => index > 0 && sample.scrollTop < samples[index - 1].scrollTop - 2);
      let jumpedToTop = samples.some((sample) => sample.canScroll && sample.scrollTop <= 5 && sample.distanceFromBottom > 50);
      let distanceFromBottom = list.scrollHeight - list.scrollTop - list.clientHeight;
      return {
        stableCount: counts.stable_1 || 0,
        responseCount: counts.response_1 || 0,
        frameIDs: Array.from(document.querySelectorAll('kikx-frame-item')).map((node) => node.dataset.frameId),
        responseText: response?.textContent || '',
        stableStillMarkdown: Boolean(stable?.querySelector('.kikx-markdown strong')),
        responseRenderedAsStreamText: Boolean(response?.querySelector('.kikx-frame__stream')),
        canScroll: list.scrollHeight > list.clientHeight,
        atBottom: distanceFromBottom <= 5,
        scrollTopDropped,
        jumpedToTop,
      };
    });

    assert.equal(result.stableCount, 0);
    assert.equal(result.responseCount < 30, true, `response frame updated ${result.responseCount} times for 120 phantom events`);
    assert.equal(result.frameIDs[0], 'stable_1');
    assert.equal(result.frameIDs.at(-1), 'response_1');
    assert.match(result.responseText, /120/);
    assert.equal(result.stableStillMarkdown, true);
    assert.equal(result.responseRenderedAsStreamText, true);
    assert.equal(result.canScroll, true);
    assert.equal(result.atBottom, true);
    assert.equal(result.scrollTopDropped, false);
    assert.equal(result.jumpedToTop, false);
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
      id: `stable_${number}`,
      type: 'AgentMessage',
      sessionID: 'session_1',
      interactionID: `interaction_${number}`,
      authorType: 'agent',
      authorID: 'agent_stream',
      authorDisplayName: 'Stream Agent',
      hidden: false,
      deleted: false,
      order: number,
      createdAt: timestamp,
      updatedAt: timestamp,
      content: {
        text: `Stable **markdown** message ${number}. This line gives the scroll container enough height to prove streaming stays anchored to the bottom.`,
      },
    };
  });
}

async function installFrameUpdateCounter(page) {
  await page.evaluate(() => {
    let FrameItem = customElements.get('kikx-frame-item');
    if (!FrameItem)
      throw new Error('kikx-frame-item is not registered');

    window.__kikxFrameUpdateCounts = {};
    if (FrameItem.prototype.__kikxOriginalUpdateFrame)
      return;

    FrameItem.prototype.__kikxOriginalUpdateFrame = FrameItem.prototype.updateFrame;
    FrameItem.prototype.updateFrame = function updateFrameWithCount(frame, appState) {
      if (frame?.id) {
        window.__kikxFrameUpdateCounts[frame.id] = (window.__kikxFrameUpdateCounts[frame.id] || 0) + 1;
      }

      return this.__kikxOriginalUpdateFrame(frame, appState);
    };
  });
}

async function installScrollTracker(page) {
  await page.evaluate(() => {
    if (!document.querySelector('.kikx-frame-list'))
      throw new Error('Missing frame list');

    window.__kikxScrollSamples = [];
    window.__kikxScrollTracker = setInterval(() => {
      let list = document.querySelector('.kikx-frame-list');
      if (!list)
        return;

      window.__kikxScrollSamples.push({
        scrollTop: list.scrollTop,
        canScroll: list.scrollHeight > list.clientHeight,
        distanceFromBottom: list.scrollHeight - list.scrollTop - list.clientHeight,
      });
    }, 10);
  });
}

async function waitForResponseText(page, pattern, timeoutMS = 10000) {
  let startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMS) {
    let text = await page.locator('kikx-frame-item[data-frame-id="response_1"]').textContent();
    if (text?.includes(pattern))
      return;

    await delay(100);
  }

  throw new Error(`Timed out waiting for response text containing ${pattern}`);
}

async function readFrameListMetrics(page) {
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

async function waitForFrameListBottom(page, timeoutMS = 10000) {
  let startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMS) {
    let metrics = await readFrameListMetrics(page);
    if (metrics.canScroll && metrics.atBottom)
      return;

    await delay(100);
  }

  throw new Error('Timed out waiting for the frame list to anchor at the bottom');
}

async function delay(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
