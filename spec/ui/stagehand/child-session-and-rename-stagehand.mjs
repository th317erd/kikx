'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { Stagehand } from '@browserbasehq/stagehand';

import {
  findChromeExecutable,
  loadStagehandOpenAIAPIKey,
  startStagehandUIServer,
} from './stagehand-test-utils.mjs';

test('Stagehand adds a child session under a project and renames it from the breadcrumb', async (t) => {
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
      { id: 'project_1', title: 'Root Project', messageCount: 0 },
    ],
  });
  // Track created sessions and their parentSessionID on the stub runtime.
  let created = [];
  let originalCreate = fixture.frameRuntime.createSession.bind(fixture.frameRuntime);
  fixture.frameRuntime.createSession = async (input = {}) => {
    let session = await originalCreate(input);
    created.push({ id: session.id, parentSessionID: session.parentSessionID || null, title: session.title });
    return session;
  };

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
    await page.goto(`${fixture.baseURL}/?code=stagehand-test`, { waitUntil: 'domcontentloaded', timeout: 10000 });
    await page.waitForSelector('kikx-session-grid > kikx-session-card', { timeout: 10000 });

    // Enter the project, then its sub-session grid, and add a child there.
    await page.evaluate(() => document.querySelector('kikx-session-grid > kikx-session-card .kikx-session-card').click());
    await waitForTitle(page, 'Root Project');
    await page.evaluate(() => document.querySelector('.kikx-window__view-toggle').click());
    await waitForCollapsed(page, true);
    await page.evaluate(() => document.querySelector('kikx-session-grid > .kikx-session-card--add').click());
    await waitForTitle(page, 'Session 2');

    assert.equal(created.length, 1);
    assert.equal(created[0].parentSessionID, 'project_1');

    // The new child opens its thread; rename it from the active breadcrumb crumb.
    await page.evaluate(() => document.querySelector('.kikx-breadcrumb__crumb--editable').click());
    await page.waitForSelector('.kikx-breadcrumb input[name="breadcrumb-title"]', { timeout: 5000 });
    await page.evaluate(() => {
      let field = document.querySelector('.kikx-breadcrumb input[name="breadcrumb-title"]');
      field.value = 'Renamed Child';
      field.dispatchEvent(new Event('input', { bubbles: true }));
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await waitForCrumb(page, 'Renamed Child');

    // Close back to the project. The project entry was left collapsed, so closing
    // returns directly to its sub-session grid listing the renamed child.
    await page.evaluate(() => document.querySelector('.kikx-window__close').click());
    await waitForTitle(page, 'Root Project');
    await waitForCollapsed(page, true);
    await waitForChildTitles(page, [ 'Renamed Child' ]);
  } finally {
    await stagehand.close().catch(() => {});
    await fixture.close().catch(() => {});
    if (previousOpenAIAPIKey == null)
      delete process.env.OPENAI_API_KEY;
    else
      process.env.OPENAI_API_KEY = previousOpenAIAPIKey;
  }
});

async function waitForTitle(page, expectedTitle, timeoutMS = 10000) {
  await waitFor(page, () => document.querySelector('.kikx-window__header h2')?.textContent || '', expectedTitle, timeoutMS, `title ${expectedTitle}`);
}

async function waitForCrumb(page, expected, timeoutMS = 10000) {
  await waitFor(page, () => document.querySelector('.kikx-breadcrumb__crumb--active')?.textContent || '', expected, timeoutMS, `crumb ${expected}`);
}

async function waitForCollapsed(page, expected, timeoutMS = 10000) {
  await waitFor(page, () => document.querySelector('kikx-app')?._state?.navigationStack?.at(-1)?.collapsed === true, expected, timeoutMS, `collapsed ${expected}`);
}

async function waitForChildTitles(page, expected, timeoutMS = 10000) {
  await waitFor(
    page,
    () => JSON.stringify(Array.from(document.querySelectorAll('kikx-session-grid > kikx-session-card'))
      .map((card) => card.querySelector('.kikx-session-card__title')?.textContent)),
    JSON.stringify(expected),
    timeoutMS,
    `child titles ${expected.join(', ')}`,
  );
}

async function waitFor(page, getter, expected, timeoutMS, label) {
  let startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMS) {
    let value = await page.evaluate(getter);
    if (value === expected)
      return;

    await delay(50);
  }

  throw new Error(`Timed out waiting for ${label}`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
