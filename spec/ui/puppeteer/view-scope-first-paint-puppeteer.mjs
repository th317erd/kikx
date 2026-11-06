'use strict';

// THE DOM HALF of the first-paint invariant, in a real browser.
//
// The unit specs prove the state is narrowed before the first request and that
// the real state module does the seeding. Neither can see the thing the owner
// actually reported: a message that APPEARED AND THEN VANISHED. That is a
// property of the DOM over time, so it needs a browser, and it needs an observer
// that runs from document-start -- checking the settled state would pass even if
// the frame flashed on screen for a second, which is the entire bug.
//
// So the assertion is deliberately not "the frame is absent at the end". It is
// "the frame was NEVER INSERTED AT ANY POINT", recorded by a MutationObserver
// installed before any application script runs. A fix that merely hides the frame
// after the fact -- or defers the paint while still fetching it unfiltered --
// would fail this, and should.
//
// The other two things pinned here:
//   * clearing the filter brings the frame back, so this is a filter and not
//     data loss (the frame must still be fetchable -- the store was never wrong);
//   * a filter set in one session does not follow the user into another, which is
//     the original cross-session report.

import assert from 'node:assert/strict';
import test from 'node:test';

import puppeteer from 'puppeteer-core';

import { findChromeExecutable, startStagehandUIServer } from '../stagehand/stagehand-test-utils.mjs';
import {
  defaultFrameWindowFilters,
  FRAME_FILTER_CATEGORY_KEYS as CATEGORY_KEYS,
} from '../../../src/shared/frame-window-filters.mjs';

const SESSION = 'session_first_paint';
const OTHER = 'session_other_scope';
const HIDDEN_USER_FRAME = 'frame_user_hidden';

function frame(id, type, order, sessionID) {
  return {
    id,
    order,
    type,
    sessionID,
    createdAt: Date.now(),
    content: { text: `${type} frame ${id}` },
  };
}

// The scope a user who switched the User category off would have persisted.
function userOffScope() {
  let filters = defaultFrameWindowFilters();
  filters.user = false;
  return { filters, query: '' };
}

test('a stored filter never lets an excluded frame reach the DOM, not even transiently', async (t) => {
  let chromePath = findChromeExecutable();
  if (!chromePath) {
    t.skip('first-paint browser coverage requires Chrome');
    return;
  }

  let fixture = await startStagehandUIServer({
    sessions: [
      { id: SESSION, title: 'First Paint Session', messageCount: 3 },
      { id: OTHER, title: 'Other Session', messageCount: 2 },
    ],
  });

  fixture.frameRuntime.framesBySessionID.set(SESSION, [
    frame(HIDDEN_USER_FRAME, 'UserMessage', 1, SESSION),
    frame('frame_agent_visible', 'AgentMessage', 2, SESSION),
    frame('frame_tool_visible', 'ShellToolFrame', 3, SESSION),
  ]);
  fixture.frameRuntime.framesBySessionID.set(OTHER, [
    frame('frame_other_user', 'UserMessage', 1, OTHER),
    frame('frame_other_agent', 'AgentMessage', 2, OTHER),
  ]);

  let browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: process.env.KIKX_PUPPETEER_HEADLESS === '0' ? false : 'new',
    args: [ '--no-sandbox', '--disable-setuid-sandbox' ],
  });

  try {
    let page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });

    // Runs on EVERY document, before any app script. Installing the recorder here
    // is the whole point: an observer added later would miss the flash.
    await page.evaluateOnNewDocument(({ sessionID, excludedFrameID, scope }) => {
      sessionStorage.setItem('kikx.auth.session', JSON.stringify({
        token: 'first-paint-token',
        refresh_token: 'first-paint-refresh',
      }));

      // Seed the stored scope exactly once, on the first document, so the reload
      // path still has something to restore.
      if (sessionStorage.getItem('firstPaintSeeded') !== '1') {
        localStorage.clear();
        localStorage.setItem(`kikx.viewScope.${sessionID}`, JSON.stringify(scope));
        sessionStorage.setItem('firstPaintSeeded', '1');
      }

      globalThis.__excludedInsertions = 0;
      globalThis.__excludedFrameIDs = new Set();
      globalThis.__sawExcludedText = 0;
      globalThis.__filterPopupFirstSeen = null;
      // Anti-vacuity counters. The excluded-frame assertions below assert
      // ABSENCE, so they also pass when the observer is broken and records
      // nothing. These prove it actually watched the thread being built, and
      // that its predicate did not throw mid-flight -- which it did, once,
      // swallowing the real verdict entirely.
      globalThis.__observerRecords = 0;
      globalThis.__observerRecordErrors = 0;
      globalThis.__frameItemsSeen = 0;

      // NB: this must not be called `record`. The observer callback below
      // iterates `for (let record of records)`, which shadows a helper of that
      // name inside the block, so `record(node)` called a MutationRecord and
      // threw TypeError. The throw aborted the scan on the first record of every
      // callback, so "the frame was never inserted" passed without ever being
      // evaluated. Measured: the popup is really inserted at ~158ms with
      // is-all-on honest (false), while this predicate reported it never seen.
      let inspectAddedNode = (node) => {
        if (!node || node.nodeType !== 1)
          return;

        // A frame item carries its id in `data-frame-id`. Count any insertion of
        // the excluded frame, plus any descendant that mentions it, so a wrapper
        // element cannot smuggle it in unseen.
        let items = [];
        if (node.matches?.('kikx-frame-item'))
          items.push(node);
        items.push(...(node.querySelectorAll?.('kikx-frame-item') || []));

        globalThis.__frameItemsSeen += items.length;

        for (let item of items) {
          let id = item.dataset?.frameId || '';
          if (id === excludedFrameID) {
            globalThis.__excludedInsertions += 1;
            globalThis.__excludedFrameIDs.add(id);
          }
        }

        // Belt and braces: the frame's visible text. A frame that is in the DOM
        // under a different wrapper still shows its content.
        if (typeof node.textContent === 'string' && node.textContent.includes('UserMessage frame'))
          globalThis.__sawExcludedText += 1;

        // First sight of the filter popup, to catch a badge that lies at first
        // paint and is corrected later.
        if (globalThis.__filterPopupFirstSeen === null) {
          let popup = node.matches?.('kikx-frame-filter-popup')
            ? node
            : node.querySelector?.('kikx-frame-filter-popup');
          if (popup)
            globalThis.__filterPopupFirstSeen = popup.classList.contains('is-all-on');
        }
      };

      let observer = new MutationObserver((records) => {
        for (let mutation of records) {
          globalThis.__observerRecords += 1;
          for (let node of mutation.addedNodes) {
            // Count a throw instead of escaping into it: an escaped throw aborts
            // the remaining records and turns every absence assertion into a pass.
            try {
              inspectAddedNode(node);
            } catch (error) {
              globalThis.__observerRecordErrors += 1;
            }
          }
        }
      });
      // Observe from the document itself: `document.body` does not exist yet at
      // document-start, and observing it later would miss the first paint.
      observer.observe(document, { childList: true, subtree: true });
      globalThis.__firstPaintObserver = observer;
    }, { sessionID: SESSION, excludedFrameID: HIDDEN_USER_FRAME, scope: userOffScope() });

    // --- 1. Load the session directly, as a reload or a bookmark would.
    await page.goto(`${fixture.baseURL}/?session=${SESSION}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForSelector('.kikx-frame-filter__button', { timeout: 15000 });
    await waitForRenderSettled(page);

    // --- 2. THE INVARIANT. The excluded frame was never inserted.
    let observed = await page.evaluate(() => ({
      insertions: globalThis.__excludedInsertions,
      ids: [ ...globalThis.__excludedFrameIDs ],
      excludedTextSeen: globalThis.__sawExcludedText,
      popupWasAllOnAtFirstSight: globalThis.__filterPopupFirstSeen,
      observerRecords: globalThis.__observerRecords,
      observerRecordErrors: globalThis.__observerRecordErrors,
      frameItemsSeen: globalThis.__frameItemsSeen,
    }));

    // The lane must be able to see anything at all before its absences mean
    // something: a dead observer satisfies every assertion below.
    assert.ok(
      observed.observerRecords > 0,
      'the document-start observer recorded no mutations, so nothing below proves anything',
    );
    assert.equal(
      observed.observerRecordErrors,
      0,
      `the observer predicate threw ${observed.observerRecordErrors} time(s); a throw aborts the scan and `
      + 'lets the absence assertions pass vacuously',
    );
    assert.ok(
      observed.frameItemsSeen > 0,
      'the observer never saw an inserted kikx-frame-item, so it cannot say the excluded one was absent',
    );

    assert.equal(
      observed.insertions,
      0,
      `the filtered UserMessage was inserted into the DOM ${observed.insertions} time(s) -- it must never appear, not even transiently`,
    );
    assert.equal(
      observed.excludedTextSeen,
      0,
      'the filtered frame\'s text reached the DOM, so it was painted before being filtered',
    );

    // --- 3. Badge honesty: the filter is active from the first paint, so the
    //        button is dimmed (not `is-all-on`) the moment the popup exists.
    assert.equal(
      observed.popupWasAllOnAtFirstSight,
      false,
      'the filter badge claimed "all on" at first paint while a stored filter was active '
      + `(popup first sight: ${observed.popupWasAllOnAtFirstSight})`,
    );
    let allOnNow = await page.evaluate(() => document.querySelector('kikx-frame-filter-popup')?.classList.contains('is-all-on'));
    assert.equal(allOnNow, false, 'the badge reflects the active filter');

    // --- 4. The rest of the thread is intact: only the filtered frame is gone,
    //        which separates "filtered" from "the session failed to load".
    let renderedIDs = await page.evaluate(() => Array.from(document.querySelectorAll('kikx-frame-item'))
      .map((item) => item.dataset.frameId));
    assert.ok(
      renderedIDs.includes('frame_agent_visible'),
      `the unfiltered frames still render (saw ${JSON.stringify(renderedIDs)})`,
    );
    assert.ok(
      !renderedIDs.includes(HIDDEN_USER_FRAME),
      'the filtered frame is not in the settled DOM',
    );

    // --- 5. Clearing the filter restores it. This is the proof it is a filter
    //        and not data loss -- the frame was always available.
    await page.evaluate(() => {
      let app = document.querySelector('kikx-app');
      let allOn = {};
      for (let key of Object.keys(app._state.frameFilters || {}))
        allOn[key] = true;
      allOn.deleted = false;
      app._setFrameFilters(allOn);
    });
    await waitForCondition(
      page,
      (frameID) => Array.from(document.querySelectorAll('kikx-frame-item'))
        .some((item) => item.dataset.frameId === frameID),
      'clearing the filter brings the excluded frame back',
      10000,
      HIDDEN_USER_FRAME,
    );

    // --- 6. A filter in one session never follows the user into another.
    await page.evaluate(async (otherID) => {
      await document.querySelector('kikx-app')._openSessionFromCard(otherID);
    }, OTHER);
    let otherState = await page.evaluate(() => {
      let app = document.querySelector('kikx-app');
      return {
        user: app._state.frameFilters?.user,
        selected: app._state.selectedSessionID,
        rendered: Array.from(document.querySelectorAll('kikx-frame-item')).map((item) => item.dataset.frameId),
      };
    });

    assert.equal(otherState.selected, OTHER, 'navigated to the second session');
    assert.equal(otherState.user, true, 'the second session opens with every category on');
    assert.ok(
      otherState.rendered.includes('frame_other_user'),
      'the second session\'s own UserMessage renders -- it did not inherit session one\'s filter',
    );
    assert.ok(!CATEGORY_KEYS.includes(undefined), 'category keys resolved from the shared module');
  } finally {
    await browser.close();
    await fixture.close?.();
  }
});

async function waitForCondition(page, predicate, message, timeoutMS = 10000, argument = undefined) {
  let startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMS) {
    if (await page.evaluate(predicate, argument).catch(() => false))
      return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(`timed out waiting for: ${message}`);
}

async function waitForRenderSettled(page, quietMS = 250, timeoutMS = 15000) {
  let startedAt = Date.now();
  let lastMutation = Date.now();
  await page.evaluate(() => {
    if (globalThis.__settleObserver)
      return;
    globalThis.__settleObserver = new MutationObserver(() => { globalThis.__settleLast = Date.now(); });
    globalThis.__settleObserver.observe(document, { childList: true, subtree: true, attributes: true });
    globalThis.__settleLast = Date.now();
  });

  while (Date.now() - startedAt < timeoutMS) {
    let last = await page.evaluate(() => globalThis.__settleLast || 0);
    if (last > lastMutation)
      lastMutation = last;
    if (Date.now() - lastMutation >= quietMS)
      return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
