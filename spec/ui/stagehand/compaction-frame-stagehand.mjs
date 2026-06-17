'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { Stagehand } from '@browserbasehq/stagehand';

import {
  findChromeExecutable,
  loadStagehandOpenAIAPIKey,
  startStagehandUIServer,
} from './stagehand-test-utils.mjs';

test('Stagehand renders manual compaction running state and updates it to complete', async (t) => {
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
      { id: 'session_1', title: 'Compaction', messageCount: 2 },
    ],
  });
  let runningFrame = createCompactionFrame({
    status: 'running',
    text: 'Compacting session context...',
    summary: '',
  });
  fixture.frameRuntime.framesBySessionID.set('session_1', [
    createUserFrame(),
    runningFrame,
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
    await page.waitForSelector('kikx-compaction-frame', { timeout: 10000 });

    let runningText = await page.locator('kikx-compaction-frame').first().textContent();
    assert.match(runningText, /Compaction/);
    assert.match(runningText, /running/);
    assert.match(runningText, /Compacting session context across 3 frames/);

    let completedFrame = createCompactionFrame({
      status: 'complete',
      text: 'Compaction complete.',
      summary: 'Keep /tmp/manual/app.mjs and the current implementation plan.',
    });
    fixture.frameRuntime.framesBySessionID.set('session_1', [
      createUserFrame(),
      completedFrame,
    ]);
    fixture.frameRuntime.emitEvent('frame.updated', {
      sessionID: 'session_1',
      frame: completedFrame,
      commit: { id: 'commit_2', order: 2 },
    });

    await waitForPageCondition(page, () => {
      let node = document.querySelector('kikx-compaction-frame');
      return Boolean(node && /success/.test(node.textContent || ''));
    });

    let completedText = await page.locator('kikx-compaction-frame').first().textContent();
    assert.match(completedText, /success/);
    assert.match(completedText, /Compaction complete\. 3 frames compressed\./);
    assert.match(completedText, /Compacted memory/);
    assert.match(completedText, /\/tmp\/manual\/app\.mjs/);
  } finally {
    await stagehand.close().catch(() => {});
    await fixture.close().catch(() => {});
    if (previousOpenAIAPIKey == null)
      delete process.env.OPENAI_API_KEY;
    else
      process.env.OPENAI_API_KEY = previousOpenAIAPIKey;
  }
});

function createUserFrame() {
  return {
    id: 'msg_1',
    type: 'UserMessage',
    sessionID: 'session_1',
    interactionID: 'int_1',
    authorType: 'user',
    authorID: 'stagehand-test',
    order: 1,
    timestamp: 1000,
    createdAt: 1000,
    updatedAt: 1000,
    hidden: false,
    deleted: false,
    content: {
      text: '/compact',
    },
  };
}

function createCompactionFrame({ status, text, summary }) {
  return {
    id: 'compaction_1',
    type: 'CompactionFrame',
    sessionID: 'session_1',
    interactionID: 'compact_1',
    parentID: 'msg_1',
    authorType: 'system',
    authorID: 'internal:compaction',
    authorDisplayName: 'Kikx compaction',
    order: 2,
    timestamp: 1001,
    createdAt: 1001,
    updatedAt: status === 'running' ? 1001 : 1002,
    hidden: false,
    deleted: false,
    content: {
      kind: 'compaction_frame',
      status,
      text,
      summary,
      manual: true,
      frameCount: 3,
      startFrameID: 'old_1',
      boundaryFrameID: 'old_3',
      boundaryOrder: 3,
    },
  };
}

async function waitForPageCondition(page, predicate, options = {}) {
  let timeout = options.timeout || 10000;
  let deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await page.evaluate(predicate))
      return;

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error('Timed out waiting for page condition');
}
