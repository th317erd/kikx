'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { Stagehand } from '@browserbasehq/stagehand';

import {
  findChromeExecutable,
  loadStagehandOpenAIAPIKey,
  startStagehandUIServer,
} from './stagehand-test-utils.mjs';

test('Stagehand repairs stale session counts from loaded visible frames on the workspace card', async (t) => {
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
      { id: 'session_1', title: 'Stale Count', messageCount: 0 },
    ],
    agents: [
      { id: 'agent_1', name: 'Agent One', pluginID: 'test-agent', enabled: true },
    ],
  });

  fixture.frameRuntime.framesBySessionID.set('session_1', [
    visibleFrame('user_1', 'UserMessage', 'user', 'first', 1),
    visibleFrame('agent_1', 'AgentMessage', 'agent_1', 'second', 2),
    visibleFrame('tool_1', 'ShellToolFrame', 'agent_1', '', 3, {
      content: { toolName: 'exec', phase: 'result', status: 'success', input: {}, preview: 'done' },
    }),
    {
      ...visibleFrame('hidden_1', 'AgentMessage', 'agent_1', 'hidden', 4),
      hidden: true,
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
      viewport: { width: 1100, height: 760 },
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
    await page.waitForSelector('kikx-session-card', { timeout: 10000 });
    await waitForCardText(page, '3 messages');
    await waitForPreviewFrames(page, [ 'user_1', 'agent_1', 'tool_1' ]);

    let result = await page.evaluate(() => {
      let card = document.querySelector('kikx-session-card');
      return {
        cardText: card?.textContent || '',
        previewFrameIDs: Array.from(card?.querySelectorAll('kikx-frame-item') || []).map((node) => node.dataset.frameId),
      };
    });

    assert.match(result.cardText, /Stale Count/);
    assert.match(result.cardText, /3 messages/);
    assert.deepEqual(result.previewFrameIDs, [ 'user_1', 'agent_1', 'tool_1' ]);
  } finally {
    await stagehand.close().catch(() => {});
    await fixture.close().catch(() => {});
    if (previousOpenAIAPIKey == null)
      delete process.env.OPENAI_API_KEY;
    else
      process.env.OPENAI_API_KEY = previousOpenAIAPIKey;
  }
});

async function waitForCardText(page, expectedText, timeoutMS = 10000) {
  let startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMS) {
    let found = await page.evaluate((text) => document.querySelector('kikx-session-card')?.textContent.includes(text), expectedText);
    if (found)
      return;

    await delay(50);
  }

  throw new Error(`Timed out waiting for card text: ${expectedText}`);
}

async function waitForPreviewFrames(page, expectedIDs, timeoutMS = 10000) {
  let startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMS) {
    let ids = await page.evaluate(() => Array.from(
      document.querySelectorAll('kikx-session-grid > kikx-session-card kikx-frame-item[data-frame-id]'),
    ).map((node) => node.dataset.frameId));
    if (JSON.stringify(ids) === JSON.stringify(expectedIDs))
      return;

    await delay(50);
  }

  throw new Error(`Timed out waiting for preview frames: ${expectedIDs.join(', ')}`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function visibleFrame(id, type, authorID, text, order, overrides = {}) {
  return {
    id,
    type,
    sessionID: 'session_1',
    interactionID: `interaction_${order}`,
    parentID: null,
    authorType: type === 'UserMessage' ? 'user' : 'agent',
    authorID,
    authorDisplayName: authorID,
    hidden: false,
    deleted: false,
    order,
    createdAt: 1781035260000000 + order,
    updatedAt: 1781035260000000 + order,
    content: { text },
    ...overrides,
  };
}
