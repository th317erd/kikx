'use strict';

// Real-browser coverage for view & recover soft-deleted sessions, per project
// convention (see .codex/quirks.md: every UI update needs Stagehand coverage).
//
// Flow: a soft-deleted session is hidden by default; the workspace search filters
// cards by title; the eye toggle reveals soft-deleted sessions with a reddish
// tint and a Recycle action; activating Recycle undeletes the session and it
// returns to the live list, untinted, with a Delete action again.

import assert from 'node:assert/strict';
import test from 'node:test';

import { Stagehand } from '@browserbasehq/stagehand';

import {
  findChromeExecutable,
  loadStagehandOpenAIAPIKey,
  startStagehandUIServer,
} from './stagehand-test-utils.mjs';

test('Stagehand filters sessions, reveals soft-deleted ones with the eye, and recycles one back to life', async (t) => {
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
      { id: 'session_1', title: 'Alpha Session', messageCount: 1 },
      { id: 'session_2', title: 'Beta Session', messageCount: 1 },
      { id: 'session_deleted', title: 'Gamma Deleted', messageCount: 1, deletedAt: 1700000000000 },
    ],
  });
  fixture.frameRuntime.framesBySessionID.set('session_1', [ visibleFrame('s1_user', 'Session 1 message', 1, 'session_1') ]);
  fixture.frameRuntime.framesBySessionID.set('session_2', [ visibleFrame('s2_user', 'Session 2 message', 1, 'session_2') ]);
  fixture.frameRuntime.framesBySessionID.set('session_deleted', [ visibleFrame('sd_user', 'Session deleted message', 1, 'session_deleted') ]);

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
    await page.goto(`${fixture.baseURL}/?code=stagehand-test`, {
      waitUntil: 'domcontentloaded',
      timeout: 10000,
    });

    await page.waitForSelector('kikx-session-grid > kikx-session-card', { timeout: 10000 });
    await waitForCardTitles(page, [ 'Alpha Session', 'Beta Session' ]);

    // The centered search bar and its floating eye live in the window header.
    assert.equal(await page.locator('.kikx-window__header .kikx-session-search__input').count(), 1, 'search input is in the header');
    assert.equal(await page.locator('.kikx-window__header .kikx-session-search__eye').count(), 1, 'eye toggle is in the header');
    assert.equal(await page.locator('kikx-session-card .kikx-session-card.is-deleted').count(), 0, 'no deleted session is shown by default');

    // 1) Typing filters by title as you go.
    await page.fill('.kikx-session-search__input', 'beta');
    await waitForCardTitles(page, [ 'Beta Session' ]);

    await page.fill('.kikx-session-search__input', 'alpha');
    await waitForCardTitles(page, [ 'Alpha Session' ]);

    await page.fill('.kikx-session-search__input', '');
    await waitForCardTitles(page, [ 'Alpha Session', 'Beta Session' ]);

    // 2) The eye reveals the soft-deleted session, tinted, with a Recycle action.
    await page.click('.kikx-session-search__eye');
    await waitForCardTitles(page, [ 'Alpha Session', 'Beta Session', 'Gamma Deleted' ]);

    let deletedState = await page.evaluate(() => {
      let card = Array.from(document.querySelectorAll('kikx-session-card'))
        .find((candidate) => candidate.querySelector('.kikx-session-card__title')?.textContent === 'Gamma Deleted');
      let root = card?.querySelector('.kikx-session-card');
      let action = card?.querySelector('.kikx-session-card__action--delete');
      return {
        tinted: root?.classList.contains('is-deleted') || false,
        icon: action?.getAttribute('icon') || '',
        duration: action?.getAttribute('duration') || '',
        label: action?.getAttribute('label') || '',
        eyeOn: document.querySelector('.kikx-session-search__eye')?.classList.contains('is-on') || false,
      };
    });
    assert.equal(deletedState.tinted, true, 'the deleted card is reddish-tinted');
    assert.equal(deletedState.icon, 'recycle', 'the delete action becomes recycle');
    assert.equal(deletedState.duration, '0', 'recycle is click-to-activate');
    assert.equal(deletedState.eyeOn, true, 'the eye reads as on');

    // 3) Activating Recycle undeletes the session: it returns to life, untinted,
    //    with a Delete action again, and leaves the deleted view.
    await page.evaluate(() => {
      let card = Array.from(document.querySelectorAll('kikx-session-card'))
        .find((candidate) => candidate.querySelector('.kikx-session-card__title')?.textContent === 'Gamma Deleted');
      card.querySelector('.kikx-session-card__action--delete .aeor-progress-btn')?.click();
    });

    await waitForCardTitles(page, [ 'Gamma Deleted', 'Alpha Session', 'Beta Session' ]);

    let restoredState = await page.evaluate(() => {
      let card = Array.from(document.querySelectorAll('kikx-session-card'))
        .find((candidate) => candidate.querySelector('.kikx-session-card__title')?.textContent === 'Gamma Deleted');
      let root = card?.querySelector('.kikx-session-card');
      let action = card?.querySelector('.kikx-session-card__action--delete');
      return {
        tinted: root?.classList.contains('is-deleted') || false,
        icon: action?.getAttribute('icon') || '',
        duration: action?.getAttribute('duration') || '',
        anyDeleted: document.querySelectorAll('kikx-session-card .kikx-session-card.is-deleted').length,
      };
    });
    assert.equal(restoredState.tinted, false, 'a restored card is no longer tinted');
    assert.equal(restoredState.icon, 'delete', 'the action is a Delete again');
    assert.equal(restoredState.duration, '1000', 'delete requires the 1s hold again');
    assert.equal(restoredState.anyDeleted, 0, 'no card remains in the deleted view');
  } finally {
    await stagehand.close().catch(() => {});
    await fixture.close().catch(() => {});
    if (previousOpenAIAPIKey == null)
      delete process.env.OPENAI_API_KEY;
    else
      process.env.OPENAI_API_KEY = previousOpenAIAPIKey;
  }
});

async function waitForCardTitles(page, expected, timeoutMS = 10000) {
  let startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMS) {
    let titles = await page.evaluate(() => Array.from(document.querySelectorAll('kikx-session-grid > kikx-session-card'))
      .map((card) => card.querySelector('.kikx-session-card__title')?.textContent || ''));
    if (JSON.stringify(titles) === JSON.stringify(expected))
      return;

    await delay(50);
  }

  throw new Error(`Timed out waiting for card titles: ${expected.join(', ')}`);
}

function visibleFrame(id, text, order, sessionID) {
  return {
    id,
    type: 'UserMessage',
    sessionID,
    interactionID: `interaction_${order}`,
    parentID: null,
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
