'use strict';

// Real-browser coverage for the empty-thread recovery state.
//
// The defect: `kikx-navigation.mjs` catches a frame-load error, records it in
// `state.status`, and re-renders. With no frames loaded, `buildFrameThread` fell
// through to "No messages yet." A session the server could not serve was
// therefore presented as a session with nothing in it — the user was told their
// conversation did not exist, and the only way to learn otherwise was to notice
// an error line in the statusbar.
//
// A DOM unit spec cannot distinguish that from a genuinely empty session,
// because both are the same builder output under the same state shape. What
// matters is what a person sees: the window must say the load failed, must not
// claim the session is empty, and must give them a control they can press.

import assert from 'node:assert/strict';
import test from 'node:test';

import puppeteer from 'puppeteer-core';

import { findChromeExecutable, startStagehandUIServer } from '../stagehand/stagehand-test-utils.mjs';

const FAILING_ID = 'session_load_fails';
const EMPTY_ID = 'session_genuinely_empty';

test('Puppeteer shows a failure state, not an empty session, when the frame load fails', async (t) => {
  let chromePath = findChromeExecutable();
  if (!chromePath) {
    t.skip('Puppeteer empty-thread coverage requires Chrome');
    return;
  }

  let fixture = await startStagehandUIServer({
    sessions: [
      { id: FAILING_ID, title: 'Unreadable Session', messageCount: 2 },
      { id: EMPTY_ID, title: 'Empty Session', messageCount: 0 },
    ],
  });

  // The frame window is the path the real server fails on (a malformed document
  // in the filtered hydrate). Reproduce exactly that: the session exists, but
  // asking for its frames throws. `listFrames` keeps its normal behaviour so the
  // failure comes from the same route the real defect came from.
  fixture.frameRuntime.listFrameWindow = async (sessionID) => {
    if (sessionID === FAILING_ID) {
      let error = new Error('AeorDB multi-fetch returned non-JSON content for /frames/00…-ShellToolFrame-8c07a48d….json: Bad escaped character in JSON at position 5630');
      error.status = 500;
      throw error;
    }

    return { frames: [], total: 0, hasMore: false, oldestOrder: null, newestOrder: null };
  };

  let browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: process.env.KIKX_PUPPETEER_HEADLESS === '0' ? false : 'new',
    args: [ '--no-sandbox', '--disable-setuid-sandbox' ],
  });

  try {
    let page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.evaluateOnNewDocument(() => {
      sessionStorage.setItem('kikx.auth.session', JSON.stringify({ token: 'empty-thread-token', refresh_token: 'empty-thread-refresh' }));
    });

    // --- the failing session ---------------------------------------------

    await page.goto(`${fixture.baseURL}/?session=${FAILING_ID}`, {
      waitUntil: 'domcontentloaded',
      timeout: 15000,
    });
    await page.waitForSelector('.kikx-thread', { timeout: 15000 });
    await waitForRenderSettled(page);

    let failed = await page.evaluate(() => {
      let empty = document.querySelector('.kikx-thread__empty');
      let action = Array.from(document.querySelectorAll('.kikx-inline-action'))
        .find((node) => (node.textContent || '').trim() === 'Show all frames');

      return {
        hasEmpty: Boolean(empty),
        isEmptyClass: Boolean(empty?.classList.contains('kikx-thread__empty--error')),
        emptyText: (empty?.textContent || '').replace(/\s+/g, ' ').trim(),
        hasAction: Boolean(action),
        actionLabel: (action?.textContent || '').trim(),
        actionVisible: action ? action.getBoundingClientRect().width > 0 : false,
      };
    });

    assert.equal(failed.hasEmpty, true, 'the thread renders an empty-state box');
    assert.equal(failed.isEmptyClass, true, 'it is the error variant, not the neutral empty state');
    assert.match(failed.emptyText, /could not be loaded/i, 'it says the session could not be loaded');
    assert.doesNotMatch(failed.emptyText, /No messages yet/i, 'it does not claim the session is empty');
    assert.match(
      failed.emptyText,
      /Bad escaped character|non-JSON/i,
      'the real cause reaches the user rather than being swallowed',
    );
    assert.equal(failed.actionLabel, 'Show all frames', 'the control is present and labelled honestly');
    assert.equal(failed.actionVisible, true, 'the control is actually painted, not display:none');

    // --- a genuinely empty session must not borrow the same wording ------

    await page.goto(`${fixture.baseURL}/?session=${EMPTY_ID}`, {
      waitUntil: 'domcontentloaded',
      timeout: 15000,
    });
    await page.waitForSelector('.kikx-thread', { timeout: 15000 });
    await waitForRenderSettled(page);

    let empty = await page.evaluate(() => {
      let box = document.querySelector('.kikx-thread__empty');
      return {
        text: (box?.textContent || '').replace(/\s+/g, ' ').trim(),
        isError: Boolean(box?.classList.contains('kikx-thread__empty--error')),
        actions: Array.from(box?.querySelectorAll('.kikx-inline-action') || [])
          .map((node) => (node.textContent || '').trim()),
      };
    });

    assert.equal(empty.isError, false, 'an empty session is not presented as a failure');
    assert.match(empty.text, /No messages yet/i);
    assert.deepEqual(empty.actions, [], 'there is nothing to un-filter, so no filter control is offered');
  } finally {
    await browser.close();
    await fixture.close();
  }
});

async function waitForRenderSettled(page, quietMS = 250, timeoutMS = 15000) {
  let delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMS) {
    let settled = await page.evaluate(() => document.querySelector('kikx-app')?._startupSettled === true);
    if (settled)
      break;
    await delay(25);
  }

  let lastShell = Symbol('unset');
  let stableSince = Date.now();
  while (Date.now() - startedAt < timeoutMS) {
    let shell = await page.evaluate(() => document.querySelector('kikx-app')?._renderStats?.shell ?? null);
    if (shell === null)
      return;
    if (shell !== lastShell) {
      lastShell = shell;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= quietMS) {
      return;
    }
    await delay(25);
  }
}
