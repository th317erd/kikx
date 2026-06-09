'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { Stagehand } from '@browserbasehq/stagehand';

import {
  findChromeExecutable,
  loadStagehandOpenAIAPIKey,
  startStagehandUIServer,
} from './stagehand-test-utils.mjs';

test('Stagehand renders agent message labels with configured agent names', async (t) => {
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
      { id: 'session_1', title: 'Agent Label Smoke', messageCount: 2 },
    ],
    agents: [
      { id: 'agent_bennett', name: 'Mr. Bennett', pluginID: 'test-agent', enabled: true },
    ],
  });
  fixture.frameRuntime.framesBySessionID.set('session_1', [
    {
      id: 'legacy_agent_msg_1',
      type: 'AgentMessage',
      sessionID: 'session_1',
      interactionID: 'interaction_1',
      parentID: 'user_msg_1',
      authorType: 'agent',
      authorID: 'agent_bennett',
      hidden: false,
      deleted: false,
      order: 1,
      createdAt: 1000,
      updatedAt: 1000,
      content: { text: 'A legacy answer without embedded display data.' },
    },
    {
      id: 'agent_msg_1',
      type: 'AgentMessage',
      sessionID: 'session_1',
      interactionID: 'interaction_2',
      parentID: 'user_msg_2',
      authorType: 'agent',
      authorID: 'agent_bennett',
      authorDisplayName: 'Mr. Bennett',
      hidden: false,
      deleted: false,
      order: 2,
      createdAt: 1001,
      updatedAt: 1001,
      content: { text: 'A civil answer from a configured agent.' },
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
    await page.waitForSelector('.kikx-frame--AgentMessage', { timeout: 10000 });

    await waitForAgentLabels(page, [ 'Mr. Bennett', 'Mr. Bennett' ]);

    let rendered = await readRenderedAgentMessages(page);

    assert.deepEqual(rendered.labels, [ 'Mr. Bennett', 'Mr. Bennett' ]);
    assert.deepEqual(rendered.secondary, [ 'AgentMessage', 'AgentMessage' ]);
    assert.deepEqual(rendered.bodies, [
      'A legacy answer without embedded display data.',
      'A civil answer from a configured agent.',
    ]);
  } finally {
    await stagehand.close().catch(() => {});
    await fixture.close().catch(() => {});
    if (previousOpenAIAPIKey == null)
      delete process.env.OPENAI_API_KEY;
    else
      process.env.OPENAI_API_KEY = previousOpenAIAPIKey;
  }
});

async function waitForAgentLabels(page, expectedLabels, timeoutMS = 10000) {
  let startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMS) {
    let labels = (await readRenderedAgentMessages(page)).labels;
    if (JSON.stringify(labels) === JSON.stringify(expectedLabels))
      return;

    await delay(100);
  }

  throw new Error(`Timed out waiting for agent message labels: ${expectedLabels.join(', ')}`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readRenderedAgentMessages(page) {
  return await page.evaluate(() => ({
    labels: Array.from(document.querySelectorAll('.kikx-frame--AgentMessage .kikx-frame__meta strong')).map((node) => node.textContent),
    secondary: Array.from(document.querySelectorAll('.kikx-frame--AgentMessage .kikx-frame__meta span')).map((node) => node.textContent),
    bodies: Array.from(document.querySelectorAll('.kikx-frame--AgentMessage .kikx-frame__content')).map((node) => node.textContent),
  }));
}
