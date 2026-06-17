'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { Stagehand } from '@browserbasehq/stagehand';

import {
  findChromeExecutable,
  loadStagehandOpenAIAPIKey,
  startStagehandUIServer,
} from './stagehand-test-utils.mjs';

test('Stagehand preserves an active draft when live agent frames arrive', async (t) => {
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
      { id: 'session_1', title: 'Draft Preservation', messageCount: 1 },
    ],
    agents: [
      { id: 'agent_live', name: 'Live Agent', pluginID: 'test-agent', enabled: true },
    ],
  });
  let existingFrame = {
    id: 'agent_msg_1',
    type: 'AgentMessage',
    sessionID: 'session_1',
    interactionID: 'interaction_1',
    authorType: 'agent',
    authorID: 'agent_live',
    authorDisplayName: 'Live Agent',
    hidden: false,
    deleted: false,
    order: 1,
    createdAt: 1781035262345678,
    updatedAt: 1781035262345678,
    content: { text: 'Existing **markdown** message.' },
  };
  fixture.frameRuntime.framesBySessionID.set('session_1', [ existingFrame ]);

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
    await page.waitForSelector('kikx-frame-item[data-frame-id="agent_msg_1"] .kikx-markdown', { timeout: 10000 });
    await page.waitForSelector('.kikx-composer textarea:not([disabled])', { timeout: 10000 });

    let draft = [
      'This is a long draft that must not be removed while another actor is thinking.',
      'It has enough text to resemble a real message in progress.',
      'The composer should keep focus and preserve the caret.',
    ].join(' ');

    await page.evaluate(() => {
      window.__kikxOriginalFrameNode = document.querySelector('kikx-frame-item[data-frame-id="agent_msg_1"]');
    });
    await page.locator('.kikx-composer textarea').fill(draft);
    await page.locator('.kikx-composer textarea').click();

    let thinkingFrame = {
      id: 'agent_thinking_1',
      type: 'AgentThinking',
      sessionID: 'session_1',
      interactionID: 'interaction_2',
      parentID: 'agent_msg_1',
      authorType: 'agent',
      authorID: 'agent_live',
      authorDisplayName: 'Live Agent',
      phantom: true,
      hidden: false,
      deleted: false,
      order: 2,
      createdAt: 1781035263345678,
      updatedAt: 1781035263345678,
      content: { text: 'Thinking about the request...' },
    };
    fixture.frameRuntime.framesBySessionID.set('session_1', [ existingFrame, thinkingFrame ]);
    fixture.frameRuntime.emitEvent('frame.phantom', {
      sessionID: 'session_1',
      frame: thinkingFrame,
    });

    await page.waitForSelector('kikx-frame-item[data-frame-id="agent_thinking_1"]', { timeout: 10000 });
    let result = await page.evaluate(() => {
      let textarea = document.querySelector('.kikx-composer textarea');
      return {
        draft: textarea?.value || '',
        focused: document.activeElement === textarea,
        existingFrameStillSame: window.__kikxOriginalFrameNode === document.querySelector('kikx-frame-item[data-frame-id="agent_msg_1"]'),
        frameIDs: Array.from(document.querySelectorAll('kikx-frame-item')).map((node) => node.dataset.frameId),
      };
    });

    assert.equal(result.draft, draft);
    assert.equal(result.focused, true);
    assert.equal(result.existingFrameStillSame, true);
    assert.deepEqual(result.frameIDs, [ 'agent_msg_1', 'agent_thinking_1' ]);
  } finally {
    await stagehand.close().catch(() => {});
    await fixture.close().catch(() => {});
    if (previousOpenAIAPIKey == null)
      delete process.env.OPENAI_API_KEY;
    else
      process.env.OPENAI_API_KEY = previousOpenAIAPIKey;
  }
});
