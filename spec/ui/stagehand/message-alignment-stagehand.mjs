'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { Stagehand } from '@browserbasehq/stagehand';

import {
  findChromeExecutable,
  loadStagehandOpenAIAPIKey,
  startStagehandUIServer,
} from './stagehand-test-utils.mjs';

test('Stagehand aligns user messages left and other messages right with bounded width', async (t) => {
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
      { id: 'session_1', title: 'Alignment Smoke', messageCount: 3 },
    ],
    agents: [
      { id: 'agent_layout', name: 'Layout Agent', pluginID: 'test-agent', enabled: true },
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
      createdAt: 1781035260000000,
      updatedAt: 1781035260000000,
      content: {
        text: 'Please compare these layout constraints and keep this user message left aligned.',
      },
    },
    {
      id: 'agent_msg_1',
      type: 'AgentMessage',
      sessionID: 'session_1',
      interactionID: 'interaction_2',
      parentID: 'user_msg_1',
      authorType: 'agent',
      authorID: 'agent_layout',
      authorDisplayName: 'Layout Agent',
      hidden: false,
      deleted: false,
      order: 2,
      createdAt: 1781035261000000,
      updatedAt: 1781035261000000,
      content: {
        text: 'This agent response should sit on the right side and remain narrower than the full container.',
      },
    },
    {
      id: 'command_result_1',
      type: 'CommandResult',
      sessionID: 'session_1',
      interactionID: 'interaction_3',
      parentID: 'user_msg_1',
      authorType: 'internal',
      authorID: 'internal:test',
      authorDisplayName: 'internal:test',
      hidden: false,
      deleted: false,
      order: 3,
      createdAt: 1781035262000000,
      updatedAt: 1781035262000000,
      content: {
        text: 'Non-user messages should use the right edge too.',
      },
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
      viewport: { width: 1280, height: 800 },
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
    await page.waitForSelector('kikx-frame-item[data-frame-id="command_result_1"]', { timeout: 10000 });

    let layout = await page.evaluate(() => {
      let list = document.querySelector('.kikx-frame-list').getBoundingClientRect();
      let frames = {};
      for (let id of [ 'user_msg_1', 'agent_msg_1', 'command_result_1' ]) {
        let rect = document.querySelector(`kikx-frame-item[data-frame-id="${id}"]`).getBoundingClientRect();
        frames[id] = {
          left: rect.left,
          right: rect.right,
          width: rect.width,
        };
      }

      return {
        list: {
          left: list.left,
          right: list.right,
          width: list.width,
        },
        frames,
      };
    });

    let maxMessageWidth = layout.list.width * 0.80;
    let edgeTolerance = 3;
    assert.equal(layout.frames.user_msg_1.left <= layout.list.left + edgeTolerance, true);
    assert.equal(layout.frames.user_msg_1.right < layout.list.right - layout.list.width * 0.10, true);
    assert.equal(layout.frames.agent_msg_1.right >= layout.list.right - edgeTolerance, true);
    assert.equal(layout.frames.command_result_1.right >= layout.list.right - edgeTolerance, true);
    assert.equal(layout.frames.agent_msg_1.left > layout.list.left + layout.list.width * 0.10, true);
    assert.equal(layout.frames.command_result_1.left > layout.list.left + layout.list.width * 0.10, true);

    for (let frame of Object.values(layout.frames))
      assert.equal(frame.width <= maxMessageWidth, true);
  } finally {
    await stagehand.close().catch(() => {});
    await fixture.close().catch(() => {});
    if (previousOpenAIAPIKey == null)
      delete process.env.OPENAI_API_KEY;
    else
      process.env.OPENAI_API_KEY = previousOpenAIAPIKey;
  }
});
