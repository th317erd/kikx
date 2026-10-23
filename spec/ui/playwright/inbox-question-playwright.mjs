'use strict';

// Real-browser coverage for the ask-user Inbox (plan §15 DoD requires a browser
// e2e before a phase is called done; mini-DOM render specs are not browser
// proof).
//
// Why this spec exists: the mini-DOM specs call `bindAnswerForm` directly, so
// they pass even when the shell forgets to wire it. This spec drives the real
// module graph in real Chrome, through the real shell, so an unwired or
// mis-wired answer form fails here.
//
// The stagehand fixture (`stagehand-test-utils.mjs`) is a stub with no question
// routes, and it is already 796 lines. Rather than extend it, this spec uses
// Playwright request interception to serve a canned open-question payload and to
// capture what the client actually POSTs. No product or fixture changes.

import assert from 'node:assert/strict';
import test from 'node:test';

import { chromium } from 'playwright';

import {
  findChromeExecutable,
  startStagehandUIServer,
} from '../stagehand/stagehand-test-utils.mjs';

const OPEN_QUESTIONS = [
  {
    id: 'q-1',
    groupID: 'g-1',
    index: 1,
    status: 'open',
    mode: 'wait',
    sessionID: 'session_1',
    agentID: 'Zav',
    text: 'Ship the Inbox as-is, or split the card renderer first?',
    priority: 'normal',
    askedAt: 1_700_000_000_000,
    readAt: null,
    contextRefs: [ { type: 'session', id: 'session_1', label: 'Rack Session' } ],
    deleted: false,
  },
  {
    id: 'q-2',
    groupID: 'g-1',
    index: 2,
    status: 'open',
    mode: 'wait',
    sessionID: 'session_1',
    agentID: 'Zav',
    text: 'Is the badge meant to count unread or all open questions?',
    priority: 'normal',
    askedAt: 1_700_000_000_500,
    readAt: null,
    contextRefs: [],
    deleted: false,
  },
];

test('the Inbox lists open questions in the browser and posts a free-form answer', async (t) => {
  let chromePath = findChromeExecutable();
  if (!chromePath) {
    t.skip('real-browser coverage requires Chrome');
    return;
  }

  let fixture = await startStagehandUIServer({
    sessions: [ { id: 'session_1', title: 'Rack Session', messageCount: 0 } ],
  });

  let browser = await chromium.launch({
    headless: true,
    executablePath: chromePath,
    chromiumSandbox: false,
    args: [ '--no-sandbox', '--disable-setuid-sandbox' ],
  });

  // What the client actually sent, captured before any assertion so a failure
  // message can quote the real request instead of "expected 1, got 0".
  let answerPosts = [];

  try {
    let page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

    // One route for the whole question surface, branched on path+method so the
    // list, read and answer endpoints cannot shadow each other.
    await page.route('**/api/v1/questions**', async (route) => {
      let request = route.request();
      let url = new URL(request.url());
      let method = request.method();
      let answerMatch = url.pathname.match(/\/api\/v1\/questions\/([^/]+)\/answer$/);

      if (method === 'POST' && answerMatch) {
        answerPosts.push({
          questionID: decodeURIComponent(answerMatch[1]),
          body: request.postDataJSON(),
        });
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, delivered: true, question: { id: decodeURIComponent(answerMatch[1]), status: 'answered' } }),
        });
        return;
      }

      if (method === 'POST') {
        // `/read` and `/dismiss` are cosmetic for this spec; acknowledge them so
        // the client does not surface an error banner.
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          questions: OPEN_QUESTIONS,
          counts: { open: OPEN_QUESTIONS.length, answered: 0, dismissed: 0 },
        }),
      });
    });

    await page.goto(`${fixture.baseURL}/?code=playwright-test`, {
      waitUntil: 'domcontentloaded',
      timeout: 15000,
    });
    await page.waitForSelector('kikx-session-card', { timeout: 15000 });

    // (1) The pinned sidebar entry shows the unread badge count. Both seeded
    // questions are open with `readAt: null`, so the badge must read 2.
    let badge = page.locator('.kikx-sidebar__inbox-badge');
    await badge.waitFor({ state: 'visible', timeout: 10000 });
    assert.equal((await badge.textContent()).trim(), '2', 'the badge counts unread open questions');

    // (2) Opening the Inbox renders one row per open question, with text visible.
    await page.locator('.kikx-sidebar__inbox').click();
    await page.waitForSelector('.kikx-inbox', { timeout: 10000 });

    let cards = page.locator('article.kikx-question-card');
    await cards.first().waitFor({ state: 'visible', timeout: 10000 });
    assert.equal(await cards.count(), OPEN_QUESTIONS.length, 'one card per open question');

    let renderedText = (await page.locator('.kikx-question-card__text').allTextContents())
      .map((text) => text.trim());
    for (let question of OPEN_QUESTIONS)
      assert.ok(renderedText.includes(question.text), `question text should be visible: ${question.text}`);

    // (3) The answer control is free-form text (decision D-4). No yes/no, radio,
    // checkbox or quick-pick control may exist — the whole point of D-4 is that
    // a toggle is not an acceptable substitute for typing.
    assert.equal(await page.locator('.kikx-question-card__input').count(), OPEN_QUESTIONS.length,
      'every open card offers an answer box');
    assert.equal(await page.locator('.kikx-question-card textarea').count(), OPEN_QUESTIONS.length,
      'the answer box is a textarea');
    assert.equal(await page.locator('.kikx-question-card input[type="radio"], .kikx-question-card input[type="checkbox"], .kikx-question-card select').count(), 0,
      'no toggle or quick-pick control: answers are free-form text (D-4)');

    // (3b) Dismiss and Answer are the same size.
    //
    // Regression: the text Dismiss is an aeor-confirm-button, whose inner
    // .aeor-confirm-btn is a deliberately compact control (font-size 0.75rem,
    // line-height normal, padding 0.125rem 0.625rem, min-height 1.75rem).
    // Dropped in beside Answer — a plain <button> at font-size 13px * 1.25,
    // line-height 1.5, padding 7px 16px — it measured 35px tall against 40.38px
    // and rendered as an undersized pill floating in the row. questions.css now
    // gives the dismiss control the same box, so the heights must agree.
    //
    // Measured, not inferred: this reads real layout boxes in real Chrome with
    // the real stylesheets, which is the only thing that catches a cascade
    // regression here. Sub-pixel tolerance because Chrome rounds border-box
    // heights to 1/64px.
    let sizing = await page.evaluate(() => {
      // The custom element wraps its button; the fallback <button> is the box.
      let visible = (host) => (host && host.querySelector('.aeor-confirm-btn')) || host;
      let box = (node) => (node ? node.getBoundingClientRect() : null);
      let submit = box(document.querySelector('.kikx-question-card__submit'));
      let dismiss = box(visible(document.querySelector('.kikx-question-card__dismiss')));
      if (!submit || !dismiss) return null;
      return {
        submitHeight: submit.height,
        dismissHeight: dismiss.height,
        heightDelta: Math.abs(submit.height - dismiss.height),
        topDelta: Math.abs(submit.top - dismiss.top),
        bottomDelta: Math.abs(submit.bottom - dismiss.bottom),
      };
    });

    assert.ok(sizing, 'both Answer and Dismiss render a box to measure');
    // Chrome lays out in 1/64px: 40.375 -> 40.38, so allow a quarter pixel.
    let TOLERANCE = 0.5;
    assert.ok(sizing.heightDelta <= TOLERANCE,
      `Dismiss should be the same height as Answer (Answer ${sizing.submitHeight}px, ` +
      `Dismiss ${sizing.dismissHeight}px, delta ${sizing.heightDelta}px)`);
    assert.ok(sizing.topDelta <= TOLERANCE,
      `Dismiss should be level with Answer at the top edge (delta ${sizing.topDelta}px)`);
    assert.ok(sizing.bottomDelta <= TOLERANCE,
      `Dismiss should be level with Answer at the bottom edge (delta ${sizing.bottomDelta}px)`);

    // (4) Submitting posts the typed text to the answer endpoint. This is the
    // assertion that fails when the shell never wires `bindAnswerForm`.
    let answerText = 'Split the renderer first, then ship.';
    let firstCard = cards.first();
    await firstCard.locator('.kikx-question-card__input').fill(answerText);
    await firstCard.locator('.kikx-question-card__submit').click();

    await page.waitForFunction(
      () => document.querySelectorAll('article.kikx-question-card').length === 2,
      null,
      { timeout: 10000 },
    );

    assert.equal(answerPosts.length, 1, 'exactly one answer request was sent');
    assert.equal(answerPosts[0].questionID, OPEN_QUESTIONS[0].id, 'the answered question id is in the URL');
    assert.equal(answerPosts[0].body?.answer, answerText, 'the typed text is what gets POSTed');

    // (5) The settle window: an answered row is NOT removed on the click.
    //
    // This block replaces an assertion that the row count drops to 1. That
    // expectation predates the 60s settle window and went red the moment the
    // receipt shipped (535d2d0) -- invisibly, because this lane is not part of
    // `npm test`. The row stays, with a receipt; only the open list and the
    // badge shrink.
    let answeredCard = page.locator('article.kikx-question-card[data-question-id="q-1"]');
    await answeredCard.waitFor({ state: 'visible', timeout: 10000 });

    assert.equal(await page.locator('article.kikx-question-card').count(), OPEN_QUESTIONS.length,
      'the answered row is retained for its receipt window, not deleted on the click');

    assert.equal(await answeredCard.getAttribute('data-question-status'), 'answered',
      'the retained row is marked with the status the user chose');
    assert.equal(await answeredCard.getAttribute('data-question-settled'), 'true',
      'the retained row carries the settled flag that swaps the form for a receipt');

    // The receipt itself. This is the complaint -- "there is no green 'You
    // replied!' status, nothing. Just WHAM! Gone." -- asserted in a real browser.
    let receipt = ((await answeredCard.locator('.kikx-question-card__closed').textContent()) || '').trim();
    assert.equal(receipt, 'You replied.', 'the answered row shows a receipt instead of silently vanishing');

    // The form is gone from the settled row: nothing left to submit.
    assert.equal(await answeredCard.locator('.kikx-question-card__input').count(), 0,
      'a settled row offers no answer box');

    // The close control is the auto-complete fuse: a 60s window, and duration="0"
    // so the NEXT press closes at once after the first press cancels the fuse.
    let fuse = await answeredCard.evaluate((card) => {
      let node = card.querySelector('.kikx-question-card__dismiss-close--settle');
      if (!node)
        return null;

      // The drained ring is painted on the SVG circle, not on the `progress`
      // attribute -- that attribute exists for an external caller to drive the
      // ring, and the internal countdown never writes it. A full ring has
      // strokeDashoffset 0; draining pushes the offset toward RING_LENGTH, so
      // "time remaining" shrinking means the offset GROWING.
      let ring = node.querySelector('.aeor-progress-btn__progress');
      let raw = ring ? ring.style.strokeDashoffset : '';
      let offset = raw === '' ? 0 : parseFloat(raw);

      return {
        autoCompleteAfter: node.getAttribute('auto-complete-after'),
        duration: node.getAttribute('duration'),
        countingDown: node.countingDown === true,
        offset: Number.isFinite(offset) ? offset : null,
      };
    });

    assert.ok(fuse, 'a settled row keeps a close control to end the receipt window');
    assert.equal(fuse.autoCompleteAfter, '60000', 'the receipt window is 60s');
    assert.equal(fuse.duration, '0', 'a press during the countdown closes immediately');
    assert.equal(fuse.countingDown, true, 'the fuse counts down by itself, with no interaction');

    // The ring reads as time REMAINING, so it drains toward zero. Sampled twice:
    // the direction of travel is the assertion, not one absolute value.
    await page.waitForTimeout(400);
    let drained = await answeredCard.evaluate((card) => {
      let node = card.querySelector('.kikx-question-card__dismiss-close--settle');
      let ring = node ? node.querySelector('.aeor-progress-btn__progress') : null;
      if (!ring)
        return null;

      let raw = ring.style.strokeDashoffset;
      let offset = raw === '' ? 0 : parseFloat(raw);
      return Number.isFinite(offset) ? offset : null;
    });

    assert.ok(typeof drained === 'number' && drained > fuse.offset,
      `the countdown must visibly drain (ring offset started ${fuse.offset}, then ${drained})`);

    // (6) The caret survives a runtime event while the Inbox is open.
    //
    // mini-DOM has no focus emulation, so "the node was not replaced" was only
    // ever a proxy for "the caret was not stolen". This is the thing itself:
    // type into the still-open card, push a `session.saved` through the SAME
    // dispatcher the SSE stream uses, and require the same element to still hold
    // focus at the same offset. If `syncSessionShell` ever regresses to returning
    // false for an active view, the shell rebuilds and this fails.
    let secondCard = page.locator('article.kikx-question-card[data-question-id="q-2"]');
    let typed = 'Badge should count unread only.';
    await secondCard.locator('.kikx-question-card__input').fill(typed);
    await secondCard.locator('.kikx-question-card__input').evaluate((node) => {
      node.focus();
      node.setSelectionRange(4, 4);
    });

    await page.evaluate(() => {
      document.querySelector('kikx-app')._onRuntimeEvent({
        data: JSON.stringify({
          type: 'session.saved',
          session: { id: 'session_1', title: 'Rack Session', messageCount: 0 },
        }),
      });
    });
    await page.waitForTimeout(150);

    let caret = await page.evaluate(() => {
      let node = document.querySelector(
        'article.kikx-question-card[data-question-id="q-2"] .kikx-question-card__input',
      );

      return {
        focused: document.activeElement === node,
        value: node ? node.value : null,
        selectionStart: node ? node.selectionStart : null,
      };
    });

    assert.equal(caret.focused, true,
      'a session.saved repaint must not steal focus from the answer box');
    assert.equal(caret.value, typed, 'the draft survives the repaint');
    assert.equal(caret.selectionStart, 4, 'the caret keeps its position inside the draft');

    // The open list really did shrink, even though the answered row stayed.
    let badgeAfter = page.locator('.kikx-sidebar__inbox-badge');
    if (await badgeAfter.count() > 0)
      assert.equal((await badgeAfter.textContent()).trim(), '1', 'the badge counts open questions only');
  } finally {
    await browser.close().catch(() => {});
    await fixture.close();
  }
});
