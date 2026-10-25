'use strict';

// Real-browser coverage for "view & recover soft-deleted sessions", per project
// convention (`.codex/quirks.md`: every UI update needs browser coverage of the
// intended user-facing behavior).
//
// This is the Puppeteer smoke (no LLM key required). The Stagehand variant
// (spec/ui/stagehand/deleted-sessions-stagehand.mjs) covers the same flow when
// an OpenAI key is available; Puppeteer is the runnable-anywhere path.
//
// Flow: a soft-deleted session is hidden by default; the workspace search filters
// cards by title; the eye toggle reveals soft-deleted sessions with a reddish
// tint and a Recycle action; activating Recycle undeletes the session and it
// returns to the live list, untinted, with a Delete action again.

import assert from 'node:assert/strict';
import test from 'node:test';

import puppeteer from 'puppeteer-core';

import { findChromeExecutable, startStagehandUIServer } from '../stagehand/stagehand-test-utils.mjs';

test('Puppeteer filters sessions, reveals soft-deleted ones with the eye, and recycles one back to life', async (t) => {
  let chromePath = findChromeExecutable();
  if (!chromePath) {
    t.skip('Puppeteer local smoke requires Chrome');
    return;
  }

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

  let browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: process.env.KIKX_PUPPETEER_HEADLESS === '0' ? false : 'new',
    args: [ '--no-sandbox', '--disable-setuid-sandbox' ],
  });

  try {
    let page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    // The app gates its initial session load on an auth token read from
    // sessionStorage at module load; seed one so the workspace grid renders
    // against the fixture's open session routes.
    await page.evaluateOnNewDocument(() => {
      sessionStorage.setItem('kikx.auth.session', JSON.stringify({ token: 'puppeteer-test-token', refresh_token: 'puppeteer-test-refresh' }));
    });
    await page.goto(`${fixture.baseURL}/`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForSelector('kikx-session-grid > kikx-session-card', { timeout: 15000 });
    await waitForCardTitles(page, [ 'Alpha Session', 'Beta Session' ]);
    // The startup loaders (account/agents/token-usage) each schedule a full shell
    // rebuild and can resolve AFTER the grid first paints; interacting now would
    // type/press into a node about to be swapped out. Let the shell settle (no new
    // rebuild for a quiet window) before driving the UI.
    await waitForRenderSettled(page);

    // The centered search bar and its floating eye live in the window header.
    assert.equal(await count(page, '.kikx-window__header .kikx-session-search__input'), 1, 'search input is in the header');
    assert.equal(await count(page, '.kikx-window__header .kikx-frame-filter__button'), 1, 'the frame-filter control is in the header');
    assert.equal(await count(page, 'kikx-session-card .kikx-session-card.is-deleted'), 0, 'no deleted session is shown by default');

    // 1) Typing filters by title as you go.
    await page.type('.kikx-session-search__input', 'beta');
    await waitForCardTitles(page, [ 'Beta Session' ]);

    await setSearchInput(page, 'alpha');
    await waitForCardTitles(page, [ 'Alpha Session' ]);

    await setSearchInput(page, '');
    await waitForCardTitles(page, [ 'Alpha Session', 'Beta Session' ]);

    // 2) The eye reveals the soft-deleted session, tinted, with a Recycle action.
    await revealDeletedSessions(page);
    await waitForCardTitles(page, [ 'Alpha Session', 'Beta Session', 'Gamma Deleted' ]);

    let deletedState = await readCardState(page, 'Gamma Deleted');
    assert.equal(deletedState.tinted, true, 'the deleted card is reddish-tinted');
    assert.equal(deletedState.icon, 'recycle', 'the delete action becomes recycle');
    assert.equal(deletedState.duration, '0', 'recycle is click-to-activate');
    assert.equal(await page.evaluate(() => document.querySelector('.kikx-frame-filter__row[data-filter-key="deleted"] .kikx-frame-filter__checkbox')?.checked === true), true, 'the Deleted row reads as on');

    // 3) Activating Recycle undeletes the session: it returns to life, untinted,
    //    with a Delete action again, and leaves the deleted view.
    await waitForRenderSettled(page);
    await pressProgressButton(page, 'Gamma Deleted');

    await waitForCondition(page, (wanted) => {
      let card = Array.from(document.querySelectorAll('kikx-session-grid > kikx-session-card'))
        .find((candidate) => (candidate.querySelector('.kikx-session-card__title')?.textContent || '') === wanted);
      return Boolean(card)
        && !card.querySelector('.kikx-session-card')?.classList.contains('is-deleted')
        && card.querySelector('.kikx-session-card__action--delete')?.getAttribute('icon') === 'delete'
        && document.querySelectorAll('kikx-session-card .kikx-session-card.is-deleted').length === 0;
    }, 'restored card returns to the live list, untinted, with a Delete action', 'Gamma Deleted');

    let restoredState = await readCardState(page, 'Gamma Deleted');
    assert.equal(restoredState.tinted, false, 'a restored card is no longer tinted');
    assert.equal(restoredState.icon, 'delete', 'the action is a Delete again');
    assert.equal(restoredState.duration, '1000', 'delete requires the 1s hold again');
    assert.equal(restoredState.anyDeleted, 0, 'no card remains in the deleted view');

    // 4) Server truth: the delete stamp is cleared (undeleted), not hard-deleted.
    let live = await page.evaluate(async () => (await (await fetch('/api/v1/sessions')).json()).data.sessions.map((session) => ({ id: session.id, deletedAt: session.deletedAt })));
    let gamma = live.find((session) => session.id === 'session_deleted');
    assert.ok(gamma, 'the restored session is back in the live list');
    assert.equal(gamma.deletedAt, null, 'the restore cleared deletedAt');
  } finally {
    await browser.close().catch(() => {});
    await fixture.close().catch(() => {});
  }
});

async function count(page, selector) {
  return page.evaluate((sel) => document.querySelectorAll(sel).length, selector);
}

async function readCardState(page, title) {
  return page.evaluate((wanted) => {
    let card = Array.from(document.querySelectorAll('kikx-session-grid > kikx-session-card'))
      .find((candidate) => (candidate.querySelector('.kikx-session-card__title')?.textContent || '') === wanted);
    let root = card?.querySelector('.kikx-session-card');
    let action = card?.querySelector('.kikx-session-card__action--delete');
    return {
      tinted: root?.classList.contains('is-deleted') || false,
      icon: action?.getAttribute('icon') || '',
      duration: action?.getAttribute('duration') || '',
      anyDeleted: document.querySelectorAll('kikx-session-card .kikx-session-card.is-deleted').length,
    };
  }, title);
}

async function setSearchInput(page, value) {
  await page.evaluate((next) => {
    let input = document.querySelector('.kikx-session-search__input');
    input.value = next;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}

// aeor-progress-button activates on pointerdown (not click). Drive a real
// pointer press over the card's Recycle control; duration=0 confirms on press.
async function pressProgressButton(page, title) {
  let handle = await page.evaluateHandle((wanted) => {
    let card = Array.from(document.querySelectorAll('kikx-session-grid > kikx-session-card'))
      .find((candidate) => (candidate.querySelector('.kikx-session-card__title')?.textContent || '') === wanted);
    return card?.querySelector('.kikx-session-card__action--delete .aeor-progress-btn') || null;
  }, title);
  let element = handle.asElement();
  assert.ok(element, 'recycle progress button is present');
  // The card toolbar can sit below the fold when several cards are listed; a
  // real mouse press must land on the control, so bring it into view first.
  await element.evaluate((node) => node.scrollIntoView({ block: 'center', inline: 'center' }));
  await delay(100);
  let box = await element.boundingBox();
  assert.ok(box, 'recycle progress button has a box');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await delay(60);
  await page.mouse.up();
}

async function waitForCardTitles(page, expected, timeoutMS = 10000) {
  let startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMS) {
    let titles = await cardTitles(page);
    if (JSON.stringify(titles) === JSON.stringify(expected))
      return;

    await delay(50);
  }

  throw new Error(`Timed out waiting for card titles: ${expected.join(', ')} (saw: ${(await cardTitles(page)).join(', ')})`);
}

async function cardTitles(page) {
  return page.evaluate(() => Array.from(document.querySelectorAll('kikx-session-grid > kikx-session-card'))
    .map((card) => card.querySelector('.kikx-session-card__title')?.textContent || ''));
}

// Wait until the app stops rebuilding its shell. The startup loaders each fire a
// full-shell rebuild and can land just after the grid first paints; driving the
// UI before that settles types/presses into a node about to be swapped out.
async function waitForRenderSettled(page, quietMS = 250, timeoutMS = 15000) {
  let startedAt = Date.now();

  // Startup loaders (account/agents/sessions/token-usage/client-components) each
  // end in a full shell rebuild. Wait until they have all SETTLED before we
  // type or press: a rebuild landing just after we focus the search field would
  // detach the focused node and swallow the keystrokes. The app sets
  // `_startupSettled` once every loader has resolved.
  while (Date.now() - startedAt < timeoutMS) {
    let settled = await page.evaluate(() => document.querySelector('kikx-app')?._startupSettled === true);
    if (settled)
      break;

    await delay(25);
  }

  // Then require a quiet window on the shell-rebuild counter, in case a settled
  // startup still scheduled a trailing animation-frame rebuild.
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

async function waitForCondition(page, predicate, message, arg, timeoutMS = 10000) {
  let startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMS) {
    if (await page.evaluate(predicate, arg))
      return;

    await delay(50);
  }

  throw new Error(`Timed out: ${message}`);
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

// "Show deleted sessions" lives in the frame-filter popup now: one control for
// every kind of visibility, instead of an eye bolted onto the search field that
// could disagree with the popup's own Deleted row. Open the popup, then tick
// the row.
async function revealDeletedSessions(page) {
  let open = await page.evaluate(() => {
    let button = document.querySelector('.kikx-frame-filter__button');
    if (!button)
      return 'NO_BUTTON';
    if (button.getAttribute('aria-expanded') !== 'true')
      button.click();
    return 'OK';
  });
  if (open !== 'OK')
    throw new Error('frame-filter button is missing from the header');

  // The row is painted synchronously when the panel opens, but allow a frame in
  // case the popup is rebuilt.
  for (let attempt = 0; attempt < 40; attempt += 1) {
    let clicked = await page.evaluate(() => {
      let row = document.querySelector('.kikx-frame-filter__row[data-filter-key="deleted"]');
      if (!row)
        return 'NO_ROW';
      if (row.querySelector('.kikx-frame-filter__checkbox')?.checked === true)
        return 'ALREADY_ON';
      (row.querySelector('.kikx-frame-filter__label') || row).click();
      return 'OK';
    });
    if (clicked === 'OK' || clicked === 'ALREADY_ON')
      return;

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error('the Deleted row never appeared in the frame-filter popup');
}
