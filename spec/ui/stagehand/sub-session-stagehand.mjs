'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { Stagehand } from '@browserbasehq/stagehand';

import {
  findChromeExecutable,
  loadStagehandOpenAIAPIKey,
  startStagehandUIServer,
} from './stagehand-test-utils.mjs';

test('Stagehand enters a sub-session card and collapses a session to a sub-session grid', async (t) => {
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
      { id: 'parent', title: 'Parent Project', messageCount: 2 },
      { id: 'child', title: 'Child Session', parentSessionID: 'parent', generation: 1, messageCount: 1 },
    ],
  });

  // Parent thread contains a session-create result frame referencing the child.
  fixture.frameRuntime.framesBySessionID.set('parent', [
    userFrame('p_user', 'parent', 'Please build the child.', 1),
    {
      id: 'p_child_ref',
      type: 'SessionCreateToolFrame',
      sessionID: 'parent',
      interactionID: 'i_child',
      authorType: 'agent',
      authorID: 'agent_1',
      authorDisplayName: 'DeepSeek 1',
      hidden: false,
      deleted: false,
      order: 2,
      createdAt: 1781035260000002,
      updatedAt: 1781035260000002,
      content: {
        toolName: 'session-create',
        phase: 'result',
        status: 'success',
        input: {},
        references: [ { type: 'session', id: 'child', parentSessionID: 'parent', title: 'Child Session' } ],
      },
    },
  ]);
  fixture.frameRuntime.framesBySessionID.set('child', [
    userFrame('c_user', 'child', 'Child work.', 1),
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
      args: [ '--no-sandbox', '--disable-setuid-sandbox' ],
      connectTimeoutMs: 30000,
    },
  });

  try {
    await stagehand.init();
    let page = stagehand.context.pages()[0];
    // Root grid shows only top-level sessions (parent, not child).
    await page.goto(`${fixture.baseURL}/?code=stagehand-test`, { waitUntil: 'domcontentloaded', timeout: 10000 });
    await page.waitForSelector('kikx-session-card', { timeout: 10000 });

    // Read each direct grid card's own title. A plain descendant selector would
    // also match sub-session cards nested inside a card's mini preview.
    let rootTitles = await page.evaluate(() => Array.from(
      document.querySelectorAll('kikx-session-grid > kikx-session-card'),
    ).map((card) => card.querySelector('.kikx-session-card__title')?.textContent));
    assert.deepEqual(rootTitles, [ 'Parent Project' ]);

    // Enter the parent.
    await page.evaluate(() => document.querySelector('kikx-session-card .kikx-session-card').click());
    await waitForThreadTitle(page, 'Parent Project');
    await page.waitForSelector('kikx-sub-session-frame kikx-session-card', { timeout: 10000 });

    let stackAfterEnter = await page.evaluate(() => document.querySelector('kikx-app')?._state?.navigationStack?.map((e) => e.sessionID));
    assert.deepEqual(stackAfterEnter, [ null, 'parent' ]);

    // Click the embedded sub-session card -> enter child.
    await page.evaluate(() => document.querySelector('kikx-sub-session-frame kikx-session-card .kikx-session-card').click());
    await waitForThreadTitle(page, 'Child Session');
    await waitForThreadFrames(page, [ 'c_user' ]);

    let stackAfterChild = await page.evaluate(() => document.querySelector('kikx-app')?._state?.navigationStack?.map((e) => e.sessionID));
    assert.deepEqual(stackAfterChild, [ null, 'parent', 'child' ]);

    // Close child -> back to parent.
    await page.evaluate(() => document.querySelector('.kikx-thread__back').click());
    await waitForThreadTitle(page, 'Parent Project');

    // Toggle "Show sub-sessions" -> collapsed grid of parent's children.
    await page.evaluate(() => document.querySelector('.kikx-thread__subsessions').click());
    await waitForCollapsed(page, true);

    let childGridTitles = await page.evaluate(() => Array.from(
      document.querySelectorAll('kikx-session-grid > kikx-session-card'),
    ).map((card) => card.querySelector('.kikx-session-card__title')?.textContent));
    assert.deepEqual(childGridTitles, [ 'Child Session' ]);
  } finally {
    await stagehand.close().catch(() => {});
    await fixture.close().catch(() => {});
    if (previousOpenAIAPIKey == null)
      delete process.env.OPENAI_API_KEY;
    else
      process.env.OPENAI_API_KEY = previousOpenAIAPIKey;
  }
});

function userFrame(id, sessionID, text, order) {
  return {
    id,
    type: 'UserMessage',
    sessionID,
    interactionID: `i_${order}`,
    authorType: 'user',
    authorID: 'user',
    authorDisplayName: 'user',
    hidden: false,
    deleted: false,
    order,
    createdAt: 1781035260000000 + order,
    updatedAt: 1781035260000000 + order,
    content: { text },
  };
}

async function waitForThreadTitle(page, expectedTitle, timeoutMS = 10000) {
  let startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMS) {
    let title = await page.evaluate(() => document.querySelector('.kikx-thread__header h2')?.textContent || '');
    if (title === expectedTitle)
      return;

    await delay(50);
  }

  throw new Error(`Timed out waiting for thread title: ${expectedTitle}`);
}

async function waitForThreadFrames(page, expectedIDs, timeoutMS = 10000) {
  let startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMS) {
    let ids = await page.evaluate(() => Array.from(
      document.querySelectorAll('.kikx-thread__body kikx-frame-item[data-frame-id]'),
    ).map((node) => node.dataset.frameId));
    if (JSON.stringify(ids) === JSON.stringify(expectedIDs))
      return;

    await delay(50);
  }

  throw new Error(`Timed out waiting for thread frames: ${expectedIDs.join(', ')}`);
}

async function waitForCollapsed(page, expected, timeoutMS = 10000) {
  let startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMS) {
    let collapsed = await page.evaluate(() => document.querySelector('kikx-app')?._state?.navigationStack?.at(-1)?.collapsed);
    if (collapsed === expected)
      return;

    await delay(50);
  }

  throw new Error(`Timed out waiting for collapsed=${expected}`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
