'use strict';

// The owner's own gesture, in a real browser: eyeball popup -> Ctrl+Click "Child
// Sessions" -> open the child session that appears -> it was EMPTY.
//
// The unit specs pin the state logic and the wiring. This one exists because the
// bug was reported as something a person SAW, and the two things that could still
// be wrong here are invisible to a unit test:
//
//   * the popup's checkboxes are painted from live state, so a scope switch that
//     did not repaint would leave the child session filtered on screen even
//     though its state was correct, and
//   * a reload has to restore the child's own scope, not the parent's.
//
// It also asserts the negative control inline: if the fix were absent, the child
// thread would render zero frames. That is the exact symptom.

import assert from 'node:assert/strict';
import test from 'node:test';

import puppeteer from 'puppeteer-core';

import { findChromeExecutable, startStagehandUIServer } from '../stagehand/stagehand-test-utils.mjs';
import { FRAME_FILTER_CATEGORY_KEYS as CATEGORY_KEYS } from '../../../src/shared/frame-window-filters.mjs';

const PARENT = 'session_parent';
const CHILD = 'session_child';

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

test('per-session view filters: a child session opens with its own filters, not the parent\'s', async (t) => {
  let chromePath = findChromeExecutable();
  if (!chromePath) {
    t.skip('per-session filter browser coverage requires Chrome');
    return;
  }

  let fixture = await startStagehandUIServer({
    sessions: [
      { id: PARENT, title: 'Parent Session', messageCount: 4 },
      { id: CHILD, title: 'Child Session', messageCount: 2, parentSessionID: PARENT, generation: 1 },
    ],
  });

  // The parent holds four ordinary frames and NO nested session reference of its
  // own besides the child, which is what "Child Sessions" is meant to surface.
  fixture.frameRuntime.framesBySessionID.set(PARENT, [
    frame('p_user_1', 'UserMessage', 1, PARENT),
    frame('p_agent_1', 'AgentMessage', 2, PARENT),
    frame('p_agent_2', 'AgentMessage', 3, PARENT),
    frame('p_tool_1', 'ShellToolFrame', 4, PARENT),
  ]);

  // The child holds two frames and references no further session -- precisely the
  // situation in which a lingering "Child Sessions only" filter matches NOTHING.
  fixture.frameRuntime.framesBySessionID.set(CHILD, [
    frame('c_user_1', 'UserMessage', 1, CHILD),
    frame('c_agent_1', 'AgentMessage', 2, CHILD),
  ]);

  let browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: process.env.KIKX_PUPPETEER_HEADLESS === '0' ? false : 'new',
    args: [ '--no-sandbox', '--disable-setuid-sandbox' ],
  });

  try {
    let page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    // NOTE: evaluateOnNewDocument runs on EVERY navigation, including the reload
    // in step 7. Clearing localStorage unconditionally here wiped the very scope
    // the reload is supposed to restore, which made a correct implementation look
    // broken. Clear once, on the first document only.
    await page.evaluateOnNewDocument(() => {
      sessionStorage.setItem('kikx.auth.session', JSON.stringify({ token: 'scope-test-token', refresh_token: 'scope-test-refresh' }));
      if (sessionStorage.getItem('scopeTestSeeded') !== '1') {
        localStorage.clear();
        sessionStorage.setItem('scopeTestSeeded', '1');
      }
    });

    await page.goto(`${fixture.baseURL}/?session=${PARENT}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForSelector('.kikx-frame-filter__button', { timeout: 15000 });
    await waitForRenderSettled(page);

    // --- 1. Isolate the parent to "Child Sessions", the way the owner did.
    await page.click('.kikx-frame-filter__button');
    await page.waitForSelector('.kikx-frame-filter__row', { timeout: 10000 });

    await page.evaluate(() => {
      let row = document.querySelector('.kikx-frame-filter__row[data-filter-key="session"]');
      row.querySelector('.kikx-frame-filter__label').dispatchEvent(new MouseEvent('click', {
        bubbles: true, cancelable: true, composed: true, ctrlKey: true,
      }));
    });
    await waitForCondition(page, (categories) => {
      let rows = Array.from(document.querySelectorAll('.kikx-frame-filter__row[data-filter-key]'));
      let on = rows.filter((row) => categories.includes(row.getAttribute('data-filter-key'))
        && row.querySelector('.kikx-frame-filter__checkbox')?.checked === true);
      return on.length === 1 && on[0].getAttribute('data-filter-key') === 'session';
    }, 'Ctrl+Click isolates the parent to Child Sessions', 10000, CATEGORY_KEYS);

    // The parent scope is now persisted under the parent's id.
    let parentStored = await readScope(page, PARENT);
    assert.ok(parentStored, 'the parent scope was written to localStorage');
    assert.equal(parentStored.filters.session, true, 'parent stored Child Sessions on');

    // --- 2. Open the child session through the app's real entry point.
    //
    // `kikx-session-card` elements carry a `sessionID` property (grid reads them
    // at kikx-session-grid.mjs:121), and the app exposes `_openSessionFromCard`,
    // which is exactly what a card click dispatches (kikx-app.mjs:562). Driving
    // that is closer to the user's gesture than synthesising a DOM click on a
    // card whose internal hit target is not part of the public contract.
    let openedVia = await page.evaluate(async (childID) => {
      let app = document.querySelector('kikx-app');
      if (typeof app?._openSessionFromCard === 'function') {
        await app._openSessionFromCard(childID);
        return 'openSessionFromCard';
      }
      if (typeof app?._selectSession === 'function') {
        await app._selectSession(childID);
        return 'selectSession';
      }
      return 'none';
    }, CHILD);

    assert.notEqual(openedVia, 'none', 'the app exposes a session-opening entry point');


    // The call above is awaited, so the selection has already been applied.
    // Asserting on it directly is both simpler and stricter than polling; an
    // earlier version polled with `(childID) => ...` while `waitForCondition`
    // called `page.evaluate(predicate)` with no argument, so the predicate
    // compared against `undefined` and could never become true.
    let selectedNow = await page.evaluate(() => document.querySelector('kikx-app')?._state?.selectedSessionID);
    assert.equal(selectedNow, CHILD, 'the child session is selected');

    // --- 3. THE BUG: the child must not still be filtered to Child Sessions.
    let childState = await page.evaluate(() => {
      let app = document.querySelector('kikx-app');
      return {
        filters: { ...app._state.frameFilters },
        query: app._state.sessionSearch,
      };
    });
    let onCategories = Object.entries(childState.filters)
      .filter(([ key, value ]) => key !== 'deleted' && value === true)
      .map(([ key ]) => key)
      .sort();

    assert.deepEqual(onCategories, [ 'agent', 'commands', 'compaction', 'question', 'session', 'tools', 'user' ],
      'the child opens with EVERY category on, not the parent\'s Child Sessions isolation');

    // --- 4. The rendered thread is the proof the user actually cares about.
    let rendered = await countFrames(page);
    assert.ok(rendered > 0, `the child thread rendered frames, not an empty view (saw ${rendered})`);

    // --- 5. The popup's checkboxes agree with the child's state (it was repainted).
    await page.click('.kikx-frame-filter__button');
    await page.waitForSelector('.kikx-frame-filter__row', { timeout: 10000 });
    let rows = await page.evaluate(() => Array.from(document.querySelectorAll('.kikx-frame-filter__row[data-filter-key]'))
      .map((row) => ({
        key: row.getAttribute('data-filter-key'),
        checked: row.querySelector('.kikx-frame-filter__checkbox')?.checked ?? null,
      })));
    let checkedCategories = rows
      // `all` is the pinned master row and `deleted` is a reveal gate; neither is
      // a category, so neither belongs in this comparison.
      .filter((row) => CATEGORY_KEYS.includes(row.key) && row.checked === true)
      .map((row) => row.key)
      .sort();
    assert.deepEqual(checkedCategories, onCategories, 'the popup was repainted to match the child scope');

    // --- 6. Now make a DELIBERATE change inside the child: isolate it to Tools.
    //
    // Merely viewing the child persists nothing, which is correct -- an untouched
    // session has no scope to remember. A scope is written when the user actually
    // narrows the view, or when they navigate away.
    await page.evaluate(() => {
      let row = document.querySelector('.kikx-frame-filter__row[data-filter-key="tools"]');
      row.querySelector('.kikx-frame-filter__label').dispatchEvent(new MouseEvent('click', {
        bubbles: true, cancelable: true, composed: true, ctrlKey: true,
      }));
    });
    await waitForCondition(page, () => {
      let app = document.querySelector('kikx-app');
      let filters = app?._state?.frameFilters || {};
      return filters.tools === true && filters.session === false && filters.user === false;
    }, 'the child is isolated to Tools');

    let childStored = await readScope(page, CHILD);
    assert.ok(childStored, 'the child scope was persisted once it changed');
    assert.equal(childStored.filters.tools, true, 'the child stored Tools on');
    assert.equal(childStored.filters.session, false, 'the child stored Child Sessions off');
    assert.equal(parentStored.filters.session, true, 'the parent still has its own, different scope');
    assert.notEqual(JSON.stringify(childStored.filters), JSON.stringify(parentStored.filters),
      'parent and child hold DIFFERENT filter sets -- the whole point');

    // --- 7. SURVIVAL: a reload restores the CHILD's scope, not the parent's and
    //        not the default.
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForSelector('.kikx-frame-filter__button', { timeout: 15000 });
    await waitForRenderSettled(page);

    let afterReload = await page.evaluate(() => {
      let app = document.querySelector('kikx-app');
      return { selected: app?._state?.selectedSessionID, filters: { ...app?._state?.frameFilters } };
    });
    assert.equal(afterReload.selected, CHILD, 'the reload came back to the child session');
    assert.equal(afterReload.filters.tools, true, 'the child scope survived the reload (Tools still on)');
    assert.equal(afterReload.filters.session, false, 'the child scope did not revert to all-on');

    // --- 8. And the parent's scope is untouched by all of that.
    await page.evaluate(async (parentID) => {
      await document.querySelector('kikx-app')._openSessionFromCard(parentID);
    }, PARENT);
    let backOnParent = await page.evaluate(() => {
      let app = document.querySelector('kikx-app');
      return { selected: app?._state?.selectedSessionID, filters: { ...app?._state?.frameFilters } };
    });
    assert.equal(backOnParent.selected, PARENT, 'navigated back to the parent');
    assert.equal(backOnParent.filters.session, true, 'the parent regained its Child Sessions isolation');
    assert.equal(backOnParent.filters.tools, false, 'and did NOT inherit the child\'s Tools isolation');
  } finally {
    await browser.close();
    await fixture.close?.();
  }
});

async function readScope(page, sessionID) {
  return page.evaluate((key) => {
    let raw = localStorage.getItem(`kikx.viewScope.${key}`);
    if (!raw)
      return null;
    try {
      return JSON.parse(raw);
    } catch (_error) {
      return null;
    }
  }, sessionID);
}

async function countFrames(page) {
  return page.evaluate(() => document.querySelectorAll('kikx-frame-item, .kikx-frame').length);
}

// `argument` is forwarded to page.evaluate, because a predicate that closes over
// a value from Node cannot see it otherwise -- passing `(param) => ...` without
// this silently compares against undefined and can never become true.
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
    if (globalThis.__scopeObserver)
      return;
    globalThis.__scopeObserver = new MutationObserver(() => { globalThis.__scopeLast = Date.now(); });
    globalThis.__scopeObserver.observe(document.body, { childList: true, subtree: true, attributes: true });
    globalThis.__scopeLast = Date.now();
  });

  while (Date.now() - startedAt < timeoutMS) {
    let last = await page.evaluate(() => globalThis.__scopeLast || 0);
    if (last > lastMutation)
      lastMutation = last;
    if (Date.now() - lastMutation >= quietMS)
      return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
