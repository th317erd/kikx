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
      () => document.querySelectorAll('article.kikx-question-card').length === 1,
      null,
      { timeout: 10000 },
    );

    assert.equal(answerPosts.length, 1, 'exactly one answer request was sent');
    assert.equal(answerPosts[0].questionID, OPEN_QUESTIONS[0].id, 'the answered question id is in the URL');
    assert.equal(answerPosts[0].body?.answer, answerText, 'the typed text is what gets POSTed');

    // The answered row leaves the open list, and the badge follows it down.
    assert.equal(await page.locator('article.kikx-question-card').count(), 1,
      'the answered question is removed from the open list');
    let badgeAfter = page.locator('.kikx-sidebar__inbox-badge');
    if (await badgeAfter.count() > 0)
      assert.equal((await badgeAfter.textContent()).trim(), '1', 'the badge drops with the open count');
  } finally {
    await browser.close().catch(() => {});
    await fixture.close();
  }
});
