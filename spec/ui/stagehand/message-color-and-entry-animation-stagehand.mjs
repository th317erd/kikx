'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { Stagehand } from '@browserbasehq/stagehand';

import {
  findChromeExecutable,
  loadStagehandOpenAIAPIKey,
  startStagehandUIServer,
} from './stagehand-test-utils.mjs';

test('Stagehand renders colored message chrome and animates new anchored messages', async (t) => {
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
      { id: 'session_1', title: 'Styled Thread', messageCount: 36 },
    ],
    agents: [
      { id: 'agent_style', name: 'Style Agent', pluginID: 'test-agent', enabled: true },
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
      viewport: { width: 1280, height: 820 },
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
    await page.waitForSelector('kikx-frame-item[data-frame-id="frame_36"]', { timeout: 10000 });
    await waitForFrameListBottom(page);
    await installFrameEntryObserver(page, 'animated_agent_message');
    await installScrollTracker(page);

    fixture.frameRuntime.emitEvent('frame.added', {
      sessionID: 'session_1',
      frame: {
        id: 'animated_agent_message',
        type: 'AgentMessage',
        sessionID: 'session_1',
        interactionID: 'interaction_animated',
        parentID: 'frame_35',
        authorType: 'agent',
        authorID: 'agent_style',
        authorDisplayName: 'Style Agent',
        hidden: false,
        deleted: false,
        order: 37,
        createdAt: 1781035400000000,
        updatedAt: 1781035400000000,
        content: {
          text: 'I will run `npm test` next.\n\n```bash\nnpm test\n```',
        },
      },
    });

    await page.waitForSelector('kikx-frame-item[data-frame-id="animated_agent_message"] code', { timeout: 10000 });
    await waitForFrameListBottom(page);
    await delay(450);

    let result = await page.evaluate(() => {
      let list = document.querySelector('.kikx-frame-list');
      let samples = window.__kikxScrollSamples || [];
      let entry = window.__kikxFrameEntryAnimation || {};
      let userName = document.querySelector('kikx-frame-item[data-frame-id="frame_1"] .kikx-frame__meta-main strong');
      let agentName = document.querySelector('kikx-frame-item[data-frame-id="animated_agent_message"] .kikx-frame__meta-main strong');
      let inlineCode = document.querySelector('kikx-frame-item[data-frame-id="animated_agent_message"] .kikx-markdown code');
      let jumpedToTop = samples.some((sample) => sample.canScroll && sample.scrollTop <= 5 && sample.distanceFromBottom > 50);
      let scrollTopDropped = samples.some((sample, index) => index > 0 && sample.scrollTop < samples[index - 1].scrollTop - 2);
      let distanceFromBottom = list.scrollHeight - list.scrollTop - list.clientHeight;
      return {
        entry,
        scrollBehavior: getComputedStyle(list).scrollBehavior,
        userNameColor: getComputedStyle(userName).color,
        agentNameColor: getComputedStyle(agentName).color,
        codeColor: getComputedStyle(inlineCode).color,
        codeBackground: getComputedStyle(inlineCode).backgroundColor,
        atBottom: distanceFromBottom <= 5,
        jumpedToTop,
        scrollTopDropped,
      };
    });

    assert.equal(result.entry.sawEnteringClass, true);
    assert.equal(result.entry.sawAnimatingClass, true);
    assert.notEqual(result.scrollBehavior, 'smooth');
    assert.equal(result.userNameColor !== result.agentNameColor, true);
    assert.equal(isOrangeRGB(result.codeColor), true, `expected orange code color, got ${result.codeColor}`);
    assert.equal(result.codeBackground.includes('rgba') || result.codeBackground.includes('rgb'), true);
    assert.equal(result.atBottom, true);
    assert.equal(result.jumpedToTop, false);
    assert.equal(result.scrollTopDropped, false);
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
  return Array.from({ length: 36 }, (_value, index) => {
    let number = index + 1;
    let isUser = number % 2 === 1;
    let timestamp = 1781035260000000 + (number * 1000000);
    return {
      id: `frame_${number}`,
      type: isUser ? 'UserMessage' : 'AgentMessage',
      sessionID: 'session_1',
      interactionID: `interaction_${number}`,
      authorType: isUser ? 'user' : 'agent',
      authorID: isUser ? 'stagehand-user' : 'agent_style',
      authorDisplayName: isUser ? 'Wyatt' : 'Style Agent',
      hidden: false,
      deleted: false,
      order: number,
      createdAt: timestamp,
      updatedAt: timestamp,
      content: {
        text: `Frame ${number}: enough content to keep the message list scrollable while testing anchored entry animation.`,
      },
    };
  });
}

async function installFrameEntryObserver(page, frameID) {
  await page.evaluate((targetFrameID) => {
    window.__kikxFrameEntryAnimation = {
      sawEnteringClass: false,
      sawAnimatingClass: false,
    };
    let observer = new MutationObserver((mutations) => {
      for (let mutation of mutations) {
        for (let node of mutation.addedNodes) {
          if (!node.matches?.(`kikx-frame-item[data-frame-id="${targetFrameID}"]`))
            continue;

          window.__kikxFrameEntryAnimation = {
            sawEnteringClass: node.classList.contains('kikx-frame--entering'),
            sawAnimatingClass: node.classList.contains('kikx-frame--animating'),
            maxHeight: getComputedStyle(node).maxHeight,
          };
        }
      }
    });
    observer.observe(document.querySelector('.kikx-frame-stream'), { childList: true });
  }, frameID);
}

async function installScrollTracker(page) {
  await page.evaluate(() => {
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
  let lastMetrics = null;
  while (Date.now() - startedAt < timeoutMS) {
    let metrics = await readFrameListMetrics(page);
    lastMetrics = metrics;
    if (metrics.canScroll && metrics.atBottom)
      return;

    await delay(100);
  }

  throw new Error(`Timed out waiting for the frame list to anchor at the bottom: ${JSON.stringify(lastMetrics)}`);
}

function isOrangeRGB(value) {
  let match = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/u.exec(value || '');
  if (!match)
    return false;

  let red = Number(match[1]);
  let green = Number(match[2]);
  let blue = Number(match[3]);
  return red >= 220 && green >= 120 && green <= 220 && blue <= 180;
}

async function delay(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
