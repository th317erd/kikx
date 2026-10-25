'use strict';

// Real-browser coverage for the frame-filter popup's interaction contract.
//
// Every assertion here exists because a person could not make the feature work
// and the unit tests could not see it:
//
//   * Ctrl+Click and Shift+Click were covered by clicking the checkbox <input>,
//     which is the one target a human almost never hits. Clicking the row's
//     text or its badge goes through <label> activation, which dispatches a
//     synthetic click carrying no modifier flags. Those unit tests passed while
//     the gesture was broken for every real click. These tests click the LABEL.
//   * The badges used to be tallied from the frames the browser had loaded, so
//     filtering visibly moved them. They are session totals now, and a total
//     that changes when you filter is, by definition, not a total.
//   * The search box's eye was replaced by a clear button that drops the query
//     AND every popup row, so nobody has to hunt through a menu to reset.

import assert from 'node:assert/strict';
import test from 'node:test';

import puppeteer from 'puppeteer-core';

import { findChromeExecutable, startStagehandUIServer } from '../stagehand/stagehand-test-utils.mjs';

const CATEGORIES = [ 'user', 'agent', 'question', 'session', 'tools', 'commands', 'compaction' ];

test('Puppeteer drives the frame-filter popup by its label, keeps badges absolute, and clears every filter', async (t) => {
  let chromePath = findChromeExecutable();
  if (!chromePath) {
    t.skip('Puppeteer popup coverage requires Chrome');
    return;
  }

  let fixture = await startStagehandUIServer({
    sessions: [ { id: 'session_1', title: 'Alpha Session', messageCount: 1 } ],
  });

  // A session with a known mix, so every category badge has a number that is a
  // fact about the session rather than about what happens to be on screen.
  fixture.frameRuntime.framesBySessionID.set('session_1', [
    frame('f_user_1', 'UserMessage', 1),
    frame('f_user_2', 'UserMessage', 2),
    frame('f_agent_1', 'AgentMessage', 3),
    frame('f_agent_2', 'AgentMessage', 4),
    frame('f_agent_3', 'AgentMessage', 5),
    frame('f_tool_1', 'ShellToolFrame', 6),
    frame('f_tool_2', 'ReadFileToolFrame', 7),
    frame('f_tool_3', 'WriteFileToolFrame', 8),
    frame('f_compact_1', 'CompactionFrame', 9),
  ]);

  let browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: process.env.KIKX_PUPPETEER_HEADLESS === '0' ? false : 'new',
    args: [ '--no-sandbox', '--disable-setuid-sandbox' ],
  });

  try {
    let page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.evaluateOnNewDocument(() => {
      sessionStorage.setItem('kikx.auth.session', JSON.stringify({ token: 'popup-test-token', refresh_token: 'popup-test-refresh' }));
    });
    await page.goto(`${fixture.baseURL}/?session=session_1`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForSelector('.kikx-frame-filter__button', { timeout: 15000 });
    await waitForRenderSettled(page);

    // 3) The search box no longer carries an eye; it carries a clear control.
    assert.equal(await count(page, '.kikx-session-search__eye'), 0, 'the eyeball is gone from the search box');
    assert.equal(await count(page, '.kikx-session-search__clear'), 1, 'the clear control replaced it');
    assert.equal(
      await page.$eval('.kikx-session-search__input', (input) => input.placeholder),
      'Search',
      'the placeholder is generic, since it searches frames too',
    );

    await page.click('.kikx-frame-filter__button');
    await page.waitForSelector('.kikx-frame-filter__row', { timeout: 10000 });
    await waitForCounts(page);

    let initial = await readPopup(page);
    assert.ok(initial.rows.length >= 5, 'the popup lists its rows');

    // 2c) Badges are session totals. Read them now and never expect them to move.
    let badges = badgeSignature(initial);
    assert.match(badges, /\bagent=3\b/, `agent badge is the session total (saw ${badges})`);
    assert.match(badges, /\buser=2\b/, `user badge is the session total (saw ${badges})`);
    assert.match(badges, /\btools=3\b/, `tools badge counts all three tool frames (saw ${badges})`);
    assert.match(badges, /\bcompaction=1\b/, `compaction badge is the session total (saw ${badges})`);

    // 2a) Ctrl+Click the tools row's LABEL: everything else off, tools on.
    await clickRow(page, 'tools', { ctrl: true });
    await waitForRows(page, (rows) => onKeys(rows) === 'tools', 'Ctrl+Click isolates tools');

    let afterCtrl = await readPopup(page);
    assert.equal(onKeys(afterCtrl.rows), 'tools', 'Ctrl+Click forces every other category off');
    assert.equal(badgeSignature(afterCtrl), badges, 'filtering must not move the badges');

    // Ctrl+Clicking the badge -- a different real target inside the same row.
    await clickRow(page, 'user', { ctrl: true }, 'badge');
    await waitForRows(page, (rows) => onKeys(rows) === 'user', 'Ctrl+Click on the badge isolates too');

    // 2b) Shift+Click the user row's LABEL: everything on.
    await clickRow(page, 'user', { shift: true });
    await waitForRows(page, (rows) => allCategoriesOn(rows), 'Shift+Click turns every category on');

    let afterShift = await readPopup(page);
    assert.equal(badgeSignature(afterShift), badges, 'badges still hold their session totals');

    // Shift+Click again turns them all off.
    await clickRow(page, 'user', { shift: true });
    await waitForRows(page, (rows) => allCategoriesOff(rows), 'Shift+Click again turns every category off');

    // A plain click still toggles exactly one row, so the modifiers are additive
    // rather than the row's only behaviour.
    await clickRow(page, 'agent', {});
    await waitForRows(page, (rows) => onKeys(rows) === 'agent', 'a plain click toggles a single row');

    // 3) The clear button resets the query and every popup row at once.
    await page.evaluate(() => {
      let input = document.querySelector('.kikx-session-search__input');
      input.value = 'frame';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await waitForCondition(
      page,
      () => document.querySelector('.kikx-session-search__clear')?.hidden === false,
      'the clear control appears once something is filtered',
    );

    await page.click('.kikx-session-search__clear');
    await waitForRows(page, (rows) => allCategoriesOn(rows), 'clearing restores every category');

    let afterClear = await readPopup(page);
    assert.equal(afterClear.query, '', 'clearing drops the search text');
    assert.equal(afterClear.rows.find((row) => row.key === 'deleted')?.checked, false, 'clearing also hides deleted content again');
    assert.equal(badgeSignature(afterClear), badges, 'badges survived the whole session unchanged');
  } finally {
    await browser.close().catch(() => {});
    await fixture.close().catch(() => {});
  }
});

function frame(id, type, order) {
  return {
    id,
    type,
    sessionID: 'session_1',
    interactionID: `interaction_${order}`,
    parentID: null,
    authorType: type === 'UserMessage' ? 'user' : 'agent',
    authorID: type === 'UserMessage' ? 'user' : 'agent',
    authorDisplayName: type === 'UserMessage' ? 'user' : 'agent',
    hidden: false,
    deleted: false,
    order,
    createdAt: 1781035260000000 + order,
    updatedAt: 1781035260000000 + order,
    content: { text: `${type} ${order}` },
  };
}

async function count(page, selector) {
  return page.evaluate((sel) => document.querySelectorAll(sel).length, selector);
}

async function readPopup(page) {
  return page.evaluate(() => {
    let app = document.querySelector('kikx-app');
    return {
      query: app?._state?.sessionSearch ?? null,
      rows: Array.from(document.querySelectorAll('.kikx-frame-filter__row')).map((row) => ({
        key: row.getAttribute('data-filter-key'),
        checked: row.querySelector('.kikx-frame-filter__checkbox')?.checked ?? null,
        badge: row.querySelector('.kikx-frame-filter__count')?.textContent ?? null,
      })),
    };
  });
}

// The checked categories, sorted and comma joined. The Deleted row is a reveal
// gate rather than a category, so it is excluded.
function onKeys(rows) {
  return rows
    .filter((row) => row.key !== 'deleted')
    .filter((row) => row.checked === true)
    .map((row) => row.key)
    .sort()
    .join(',');
}

function categoryRows(rows) {
  return rows.filter((row) => CATEGORIES.includes(row.key));
}

function allCategoriesOn(rows) {
  let categories = categoryRows(rows);
  return categories.length === CATEGORIES.length && categories.every((row) => row.checked === true);
}

function allCategoriesOff(rows) {
  let categories = categoryRows(rows);
  return categories.length === CATEGORIES.length && categories.every((row) => row.checked === false);
}

function badgeSignature(state) {
  return state.rows
    .map((row) => `${row.key}=${row.badge}`)
    .sort()
    .join(' ');
}

// Click the row's label text -- not the checkbox input. This is the distinction
// the unit tests missed: a label click is forwarded to the input as a synthetic
// click, and that forwarded click carries no ctrlKey/shiftKey.
async function clickRow(page, key, modifiers, target = 'label') {
  let selector = `.kikx-frame-filter__row[data-filter-key="${key}"]`;
  let clicked = await page.evaluate(({ selector, modifiers, target }) => {
    let row = document.querySelector(selector);
    if (!row)
      return 'NO_ROW';
    let hit = target === 'badge'
      ? (row.querySelector('.kikx-frame-filter__count') || row)
      : (row.querySelector('.kikx-frame-filter__label') || row);
    hit.dispatchEvent(new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      composed: true,
      ctrlKey: modifiers.ctrl === true,
      shiftKey: modifiers.shift === true,
      metaKey: false,
    }));
    return 'OK';
  }, { selector, modifiers, target });
  assert.equal(clicked, 'OK', `row ${key} is clickable`);
}

// The predicate runs in Node over the plain data read back from the page, so it
// can use the helpers above without any serialisation.
async function waitForRows(page, predicate, message, timeoutMS = 10000) {
  let startedAt = Date.now();
  let rows = [];
  while (Date.now() - startedAt < timeoutMS) {
    rows = (await readPopup(page)).rows;
    if (predicate(rows) === true)
      return;

    await delay(50);
  }

  throw new Error(`Timed out: ${message} (rows: ${JSON.stringify(rows)})`);
}

// Rows paint immediately; badges wait on the server's /frame-counts answer.
// A null badge is also a legitimate steady state (Deleted has no cheap count),
// so "ready" means the server answered and the numbered rows painted.
async function waitForCounts(page, timeoutMS = 15000) {
  let startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMS) {
    let ready = await page.evaluate(() => {
      let app = document.querySelector('kikx-app');
      let sessionID = app?._state?.selectedSessionID;
      if (!sessionID || !app?._state?.frameCountsBySessionID?.[sessionID])
        return false;

      // The pinned "All frames" row and the Deleted gate carry no number.
      return document.querySelectorAll('.kikx-frame-filter__row .kikx-frame-filter__count').length >= 3;
    });
    if (ready)
      return;

    await delay(50);
  }

  throw new Error('Timed out waiting for the popup badges to arrive from /frame-counts');
}

async function waitForCondition(page, predicate, message, timeoutMS = 10000) {
  let startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMS) {
    if (await page.evaluate(predicate))
      return;

    await delay(50);
  }

  throw new Error(`Timed out: ${message}`);
}

async function waitForRenderSettled(page, quietMS = 250, timeoutMS = 15000) {
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
