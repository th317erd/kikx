'use strict';

// Real-browser coverage for answer feedback.
//
// The defect reported from manual testing: after clicking Answer, "it just sits
// there... doing nothing. No spinner, no success green check mark... as far as I
// know, nothing happened."
//
// The cause was twofold and both halves needed a browser to prove:
//
//   1. The card set `disabled` and `aria-busy` but no CSS reacted to either, so
//      the control was pixel-identical while in flight. Computed style is the
//      only way to assert that; a mini-DOM has no stylesheet.
//   2. A failed answer resolved with `{ ok: false }`, which the card read as
//      success and answered by wiping the textarea and deleting the draft. This
//      spec types into a real textarea and reads the real value back.
//
// Request interception serves a canned open question; the POST is held open so
// the busy phase can be observed, then released.

import assert from 'node:assert/strict';
import test from 'node:test';

import { chromium } from 'playwright';

import {
  findChromeExecutable,
  startStagehandUIServer,
} from '../stagehand/stagehand-test-utils.mjs';

const TYPED = 'Use PostgreSQL for the primary store.';

function openQuestion() {
  return {
    id: 'q-feedback',
    groupID: 'g-feedback',
    index: 1,
    status: 'open',
    mode: 'wait',
    sessionID: 'session_1',
    agentID: 'Zav',
    text: 'Which database should we use?',
    priority: 'normal',
    askedAt: 1_700_000_000_000,
    readAt: 1_700_000_000_100,
    contextRefs: [],
    deleted: false,
  };
}

async function launchBrowser(t) {
  let chromePath = findChromeExecutable();
  if (!chromePath) {
    t.skip('real-browser coverage requires Chrome');
    return null;
  }

  return chromium.launch({
    headless: true,
    executablePath: chromePath,
    chromiumSandbox: false,
    args: [ '--no-sandbox', '--disable-setuid-sandbox' ],
  });
}

// Boot the shell, route the questions API, and open the Inbox. `answerHandler`
// decides what the answer POST does; it is a function of the route so a test can
// hold it open, fulfil it, or fail it.
async function openInbox(browser, answerHandler) {
  let fixture = await startStagehandUIServer({
    sessions: [ { id: 'session_1', title: 'Rack Session', messageCount: 0 } ],
  });

  let page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  await page.route('**/api/v1/questions**', async (route) => {
    let request = route.request();
    let url = new URL(request.url());
    let answerMatch = url.pathname.match(/\/api\/v1\/questions\/([^/]+)\/answer$/);

    if (request.method() === 'POST' && answerMatch)
      return answerHandler(route, decodeURIComponent(answerMatch[1]));

    if (request.method() === 'POST')
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });

    let question = openQuestion();
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        questions: [ question ],
        counts: { open: 1, answered: 0, dismissed: 0 },
      }),
    });
  });

  await page.goto(`${fixture.baseURL}/?code=playwright-test`, {
    waitUntil: 'domcontentloaded',
    timeout: 15000,
  });
  await page.waitForSelector('kikx-session-card', { timeout: 15000 });

  await page.locator('.kikx-sidebar__inbox').click();
  await page.waitForSelector('.kikx-inbox', { timeout: 10000 });

  let card = page.locator('article.kikx-question-card[data-question-id="q-feedback"]');
  await card.waitFor({ state: 'visible', timeout: 10000 });

  return { fixture, page, card };
}

test('the click is acknowledged at once, before the server replies', async (t) => {
  let browser = await launchBrowser(t);
  if (!browser)
    return;

  let release;
  let fixture = null;

  try {
    // Hold the POST open so the acknowledgement window is observable.
    let held = new Promise((resolve) => { release = resolve; });
    let opened = await openInbox(browser, async (route) => {
      await held;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: { delivered: true } }),
      });
    });
    fixture = opened.fixture;
    let { page, card } = opened;

    let submit = card.locator('.kikx-question-card__submit');
    let input = card.locator('.kikx-question-card__input');

    // Release the held POST even if an assertion throws. Without this, a failed
    // assertion leaves the intercepted route pending forever and the test dies
    // as an opaque timeout instead of naming the assertion that failed.
    t.after(() => { try { release?.(); } catch {} });

    let idleLabel = (await submit.textContent())?.trim();
    assert.equal(idleLabel, 'Answer', 'the control reads "Answer" when idle');

    await input.fill(TYPED);
    await submit.click();

    // WHAT THIS TEST GUARDS, and where it moved.
    //
    // The original defect was a send that looked like a dead button: the control
    // was disabled with no visual change, so a working click was indistinguishable
    // from a missed one. That guarantee still holds, but the evidence changed
    // twice since it was written:
    //
    //   1. The spinner/busy phase belongs to the card builder's control
    //      (data-answer-state="busy" on the CARD element). An Inbox row is a
    //      <kikx-question-frame> inside an <article>, and the frame sets the
    //      phase on itself -- so the attribute is not on the row being clicked.
    //   2. The answer settles optimistically ON THE CLICK, so the row becomes a
    //      "You replied." receipt immediately and the submit control is gone
    //      before a busy phase could ever be read from it.
    //
    // So the acknowledgement is asserted where it now lives: the row turns into
    // a receipt on the click, while the POST is still held open. That is a
    // stronger statement than a spinner, because it proves the click landed
    // before the server answered.
    await page.waitForFunction(
      () => document.querySelector('article.kikx-question-card[data-question-id="q-feedback"]')
        ?.getAttribute('data-question-settled') === 'true',
      null,
      { timeout: 5000 },
    );

    // Asserted on the DOM, not the locator: the old submit node is legitimately
    // detached once the receipt replaces it.
    let acknowledged = await page.evaluate(() => {
      let row = document.querySelector('article.kikx-question-card[data-question-id="q-feedback"]');
      let button = row?.querySelector('.kikx-question-card__submit');
      return {
        status: row?.getAttribute('data-question-status') ?? null,
        settled: row?.getAttribute('data-question-settled') ?? null,
        submitStillThere: !!button,
        receipt: (row?.querySelector('.kikx-question-card__receipt')?.textContent || '').trim(),
      };
    });

    assert.equal(acknowledged.status, 'answered', 'the click is acknowledged as an answer');
    assert.equal(acknowledged.submitStillThere, false, 'the answer control is replaced, so it cannot be submitted twice');
    assert.match(acknowledged.receipt, /You replied/, 'the receipt says what the row now holds');

    release();

    // And the send is confirmed on screen. The settled row is not the
    // confirmation by itself -- the notice is, and it reads the same whether the
    // row lingers or not.
    let notice = page.locator('.kikx-answer-notice--visible');
    await notice.waitFor({ state: 'visible', timeout: 10000 });

    let noticeText = (await notice.textContent())?.trim();
    assert.match(noticeText, /Answer sent/, 'a successful send is confirmed on screen');

    let noticeStyle = await notice.evaluate((node) => {
      let style = getComputedStyle(node);
      return { opacity: style.opacity, border: style.borderTopColor };
    });
    assert.equal(noticeStyle.opacity, '1', 'the notice is actually visible, not merely present');
  } finally {
    release?.();
    // Browser first: the page's keep-alive sockets would otherwise keep
    // `server.close()` pending, and a hung teardown turns any real assertion
    // failure into an opaque 'test timed out after 45000ms'.
    await browser.close().catch(() => {});
    await fixture?.close?.();
  }
});

test('a failed answer reports the error and keeps the typed text', async (t) => {
  let browser = await launchBrowser(t);
  if (!browser)
    return;

  let fixture = null;

  try {
    // A 409 is what the server returns for an already-answered question — the
    // most likely real failure, and the one that used to erase the draft.
    let opened = await openInbox(browser, (route) => route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({ error: { message: 'Question already answered' } }),
    }));
    fixture = opened.fixture;
    let { page, card } = opened;

    let input = card.locator('.kikx-question-card__input');
    await input.fill(TYPED);
    await card.locator('.kikx-question-card__submit').click();

    // The rejected write reopens the row. The phase attribute is the FRAME's,
    // and the row above it must go back to being an answerable question: the
    // optimistic receipt was a promise the server broke.
    await page.waitForFunction(
      () => document.querySelector('article.kikx-question-card[data-question-id="q-feedback"]')
        ?.getAttribute('data-question-status') === 'open',
      null,
      { timeout: 10000 },
    );

    // THE REGRESSION: this used to come back '' with the draft deleted.
    assert.equal(
      await input.inputValue(),
      TYPED,
      'a failed send must not discard the answer that was typed',
    );

    // The reason is surfaced by the Inbox notice, not by the re-created row's
    // hint: reopening rebuilds the card from the model, and the model carries no
    // per-row error text.
    let notice = page.locator('.kikx-answer-notice--visible');
    await notice.waitFor({ state: 'visible', timeout: 5000 });
    assert.match((await notice.textContent()) ?? '', /already answered/, 'the reason is shown');

    // And the control is usable again, so the send can be retried.
    assert.equal(await card.locator('.kikx-question-card__submit').isDisabled(), false);
  } finally {
    await browser.close().catch(() => {});
    await fixture?.close?.();
  }
});
