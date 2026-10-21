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

test('the Answer control visibly changes while a send is in flight', async (t) => {
  let browser = await launchBrowser(t);
  if (!browser)
    return;

  let release;
  let fixture = null;

  try {
    // Hold the POST open so the busy phase is stable long enough to measure.
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
    // as an opaque 90s timeout instead of naming the assertion that failed.
    t.after(() => { try { release?.(); } catch {} });

    // The idle baseline, so the assertion below is a real comparison rather
    // than a hard-coded colour.
    let idleBackground = await submit.evaluate((node) => getComputedStyle(node).backgroundColor);
    let idleLabel = (await submit.textContent())?.trim();
    assert.equal(idleLabel, 'Answer', 'the control reads "Answer" when idle');

    await input.fill(TYPED);
    await submit.click();

    // Wait for the busy phase to be observable in the real DOM.
    await page.waitForFunction(
      () => document.querySelector('article.kikx-question-card[data-question-id="q-feedback"]')
        ?.getAttribute('data-answer-state') === 'busy',
      null,
      { timeout: 5000 },
    );

    let busyLabel = (await submit.textContent())?.trim();
    assert.notEqual(busyLabel, idleLabel, 'the label changes while sending, so the click is acknowledged');
    assert.match(busyLabel, /Sending/, 'the label says what is happening');

    assert.equal(await submit.isDisabled(), true, 'the control cannot be double-submitted');

    // `cursor` is not transitioned, but the background is
    // (`transition: background 160ms ease` on the base rule), so a computed
    // style read the instant `busy` lands returns the START of the
    // interpolation — byte-identical to idle. Wait for it to settle, which
    // also proves the difference is reached rather than merely scheduled.
    await page.waitForFunction(
      ([ selector, idle ]) => {
        let node = document.querySelector(selector);
        return node && getComputedStyle(node).backgroundColor !== idle;
      },
      [ 'article.kikx-question-card[data-question-id="q-feedback"] .kikx-question-card__submit', idleBackground ],
      { timeout: 3000 },
    );

    let busyStyles = await submit.evaluate((node) => {
      let style = getComputedStyle(node);
      let spinner = getComputedStyle(node, '::before');
      return {
        background: style.backgroundColor,
        cursor: style.cursor,
        spinnerContent: spinner.content,
        spinnerWidth: spinner.width,
        spinnerAnimation: spinner.animationName,
      };
    });

    // THE REGRESSION: these were identical to idle, which is why a working send
    // looked like a dead button.
    assert.notEqual(busyStyles.background, idleBackground, 'the button is visibly different while busy');
    assert.equal(busyStyles.cursor, 'progress', 'the cursor signals work in progress');
    // `content` is the real signal: without it there is no pseudo-element at
    // all, and `width` merely echoes the button's own, so asserting on width
    // alone passes vacuously on an idle control.
    assert.ok(busyStyles.spinnerContent && busyStyles.spinnerContent !== 'none',
      `a spinner pseudo-element exists (content = ${busyStyles.spinnerContent})`);
    assert.equal(busyStyles.spinnerAnimation, 'kikx-answer-spin', 'the spinner is animated');

    release();

    // And it resolves to a visible confirmation.
    await page.waitForFunction(
      () => document.querySelector('article.kikx-question-card[data-question-id="q-feedback"]')
        ?.getAttribute('data-answer-state') === 'sent'
        || !document.querySelector('article.kikx-question-card[data-question-id="q-feedback"]'),
      null,
      { timeout: 10000 },
    );

    // The answered row leaves the Inbox, so confirmation has to come from the
    // notice rather than the row.
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

    await page.waitForFunction(
      () => document.querySelector('article.kikx-question-card[data-question-id="q-feedback"]')
        ?.getAttribute('data-answer-state') === 'error',
      null,
      { timeout: 10000 },
    );

    // THE REGRESSION: this used to come back '' with the draft deleted.
    assert.equal(
      await input.inputValue(),
      TYPED,
      'a failed send must not discard the answer that was typed',
    );

    let hint = card.locator('.kikx-question-card__hint');
    await hint.waitFor({ state: 'visible', timeout: 5000 });
    assert.match((await hint.textContent()) ?? '', /already answered/, 'the reason is shown');

    // And the control is usable again, so the send can be retried.
    assert.equal(await card.locator('.kikx-question-card__submit').isDisabled(), false);
  } finally {
    await browser.close().catch(() => {});
    await fixture?.close?.();
  }
});
