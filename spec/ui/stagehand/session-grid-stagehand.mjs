'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { Stagehand } from '@browserbasehq/stagehand';

import {
  findChromeExecutable,
  loadStagehandOpenAIAPIKey,
  startStagehandUIServer,
} from './stagehand-test-utils.mjs';

test('Stagehand renders session cards in the workspace grid and expands a card into the full chat', async (t) => {
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
      { id: 'session_1', title: 'Alpha Session', messageCount: 3 },
      { id: 'session_2', title: 'Beta Session', messageCount: 2 },
    ],
  });
  fixture.frameRuntime.framesBySessionID.set('session_1', [
    visibleFrame('s1_user', 'UserMessage', 'user', 'Alpha question', 1, 'session_1'),
    visibleFrame('s1_agent', 'AgentMessage', 'agent_1', 'Alpha answer', 2, 'session_1'),
    visibleFrame('s1_tool', 'ShellToolFrame', 'agent_1', '', 3, 'session_1', {
      content: { toolName: 'exec', phase: 'result', status: 'success', input: {}, preview: 'ok' },
    }),
  ]);
  fixture.frameRuntime.framesBySessionID.set('session_2', [
    visibleFrame('s2_user', 'UserMessage', 'user', 'Beta question', 1, 'session_2'),
    visibleFrame('s2_agent', 'AgentMessage', 'agent_1', 'Beta answer', 2, 'session_2'),
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

    await page.waitForSelector('kikx-session-grid > kikx-session-card', { timeout: 10000 });
    await waitForCardText(page, 'Alpha Session', 'Alpha Session');
    await waitForCardFrameCount(page, 3);

    let gridState = await page.evaluate(() => ({
      stack: document.querySelector('kikx-app')?._state?.navigationStack,
      cards: Array.from(document.querySelectorAll('kikx-session-grid > kikx-session-card')).map((card) => ({
        title: card.querySelector('.kikx-session-card__title')?.textContent || '',
        meta: card.querySelector('.kikx-session-card__meta')?.textContent || '',
        mode: card.querySelector('kikx-chat-view')?.mode || '',
        frames: card.querySelectorAll('kikx-frame-item[data-frame-id]').length,
      })),
    }));

    assert.equal(gridState.stack.length, 1);
    assert.equal(gridState.cards.length, 2);
    assert.deepEqual(gridState.cards.map((card) => card.title), [ 'Alpha Session', 'Beta Session' ]);
    assert.equal(gridState.cards.every((card) => card.mode === 'mini'), true);
    assert.equal(gridState.cards[0].frames, 3);
    assert.equal(gridState.cards[1].frames, 2);
    assert.match(gridState.cards[0].meta, /3 messages/);

    // The root grid begins with an "Add Project" card, and the window header has
    // no "+" add button (Add lives in the grid).
    let addState = await page.evaluate(() => {
      let children = Array.from(document.querySelectorAll('kikx-session-grid > *'));
      let add = children[0];
      return {
        firstIsAdd: add?.classList.contains('kikx-session-card--add') || false,
        addLabel: add?.textContent?.trim() || '',
        headerAddButtons: Array.from(document.querySelectorAll('.kikx-window__actions button'))
          .filter((b) => b.textContent.trim() === '+').length,
      };
    });
    assert.equal(addState.firstIsAdd, true);
    assert.equal(addState.addLabel, '+ Add Project');
    assert.equal(addState.headerAddButtons, 0);

    // Mini cards render the real chat thread scaled down via a transform.
    let scalerState = await page.evaluate(() => {
      let view = document.querySelector('kikx-session-card kikx-chat-view');
      let scaler = view?.querySelector('.kikx-chat-view__scaler');
      let list = scaler?.querySelector('.kikx-frame-list');
      let transform = scaler ? getComputedStyle(scaler).transform : '';
      let scaleValue = scaler ? scaler.style.getPropertyValue('--kikx-mini-scale') : '';
      return {
        hasScaler: Boolean(scaler),
        hasFrameList: Boolean(list),
        transform,
        scaleValue: Number(scaleValue),
      };
    });

    assert.equal(scalerState.hasScaler, true);
    assert.equal(scalerState.hasFrameList, true);
    assert.match(scalerState.transform, /^matrix\(/);
    assert.ok(scalerState.scaleValue > 0 && scalerState.scaleValue < 1, `mini scale in (0,1): ${scalerState.scaleValue}`);

    // Expand the Alpha card into the full chat.
    await page.evaluate(() => {
      let card = Array.from(document.querySelectorAll('kikx-session-grid > kikx-session-card'))
        .find((candidate) => candidate.querySelector('.kikx-session-card__title')?.textContent === 'Alpha Session');
      card.querySelector('.kikx-session-card').click();
    });

    await waitForThreadTitle(page, 'Alpha Session');
    await waitForThreadFrames(page, [ 's1_user', 's1_agent', 's1_tool' ]);
    let threadState = await page.evaluate(() => ({
      stack: document.querySelector('kikx-app')?._state?.navigationStack,
      title: document.querySelector('.kikx-window__header h2, .kikx-window__header .kikx-window__title')?.textContent || '',
      frameIDs: Array.from(document.querySelectorAll('.kikx-thread__body kikx-frame-item[data-frame-id]')).map((node) => node.dataset.frameId),
      composer: Boolean(document.querySelector('.kikx-composer textarea')),
    }));

    assert.equal(threadState.stack.length, 2);
    assert.equal(threadState.stack[1].sessionID, 'session_1');
    assert.deepEqual(threadState.stack[1].collapsed, false);
    assert.equal(threadState.title, 'Alpha Session');
    assert.deepEqual(threadState.frameIDs, [ 's1_user', 's1_agent', 's1_tool' ]);
    assert.equal(threadState.composer, true);

    // Return to the grid.
    await page.evaluate(() => document.querySelector('.kikx-window__close')?.click());
    await waitForGridCardCount(page, 2);

    let backState = await page.evaluate(() => ({
      stack: document.querySelector('kikx-app')?._state?.navigationStack,
      cards: document.querySelectorAll('kikx-session-grid > kikx-session-card').length,
    }));
    assert.equal(backState.stack.length, 1);
    assert.equal(backState.cards, 2);
  } finally {
    await stagehand.close().catch(() => {});
    await fixture.close().catch(() => {});
    if (previousOpenAIAPIKey == null)
      delete process.env.OPENAI_API_KEY;
    else
      process.env.OPENAI_API_KEY = previousOpenAIAPIKey;
  }
});

async function waitForCardFrameCount(page, expectedCount, timeoutMS = 10000) {
  let startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMS) {
    let counts = await page.evaluate(() => Array.from(document.querySelectorAll('kikx-session-grid > kikx-session-card'))
      .map((card) => card.querySelectorAll('kikx-frame-item[data-frame-id]').length));
    if (counts[0] >= expectedCount)
      return;

    await delay(50);
  }

  throw new Error(`Timed out waiting for card frame counts: ${expectedCount}`);
}

async function waitForCardText(page, expectedText, expectedTitle, timeoutMS = 10000) {
  let startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMS) {
    let found = await page.evaluate(({ text, title }) => {
      let card = Array.from(document.querySelectorAll('kikx-session-grid > kikx-session-card'))
        .find((candidate) => candidate.querySelector('.kikx-session-card__title')?.textContent === title);
      return Boolean(card?.textContent.includes(text));
    }, { text: expectedText, title: expectedTitle });
    if (found)
      return;

    await delay(50);
  }

  throw new Error(`Timed out waiting for card text: ${expectedText}`);
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

async function waitForThreadTitle(page, expectedTitle, timeoutMS = 10000) {
  let startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMS) {
    let title = await page.evaluate(() => document.querySelector('.kikx-window__header h2, .kikx-window__header .kikx-window__title')?.textContent || '');
    if (title === expectedTitle)
      return;

    await delay(50);
  }

  throw new Error(`Timed out waiting for thread title: ${expectedTitle}`);
}

async function waitForGridCardCount(page, expectedCount, timeoutMS = 10000) {
  let startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMS) {
    let count = await page.evaluate(() => document.querySelectorAll('kikx-session-grid > kikx-session-card').length);
    if (count === expectedCount)
      return;

    await delay(50);
  }

  throw new Error(`Timed out waiting for ${expectedCount} cards`);
}

function visibleFrame(id, type, authorID, text, order, sessionID, overrides = {}) {
  return {
    id,
    type,
    sessionID,
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
