'use strict';

// Real-browser coverage for the two draft-loss defects reported from manual
// testing:
//
//   1. Answering ONE question cleared the unsent answer typed into the OTHER
//      question in the same batch.
//   2. The questions all "reset" and the badge stayed at (2).
//
// Why this spec exists and why it is a browser spec: the mini-DOM specs call
// `bindAnswerForm` with a hand-made node and assert on `inputNode.value`, so
// they can pass while the real shell rebuilds a real card and the real
// textarea's value is lost. The user's report was about a real textarea in a
// real page, so the check has to be the same thing. `playwright` `fill()` sets
// `value` and dispatches `input`, which is the path the draft store listens on
// (`kikx-question-card.mjs`), so if restoring or saving is wired wrong the
// `value` read here comes back empty.
//
// The stagehand fixture has no question routes, so request interception serves
// a canned open-question payload and captures the POSTs, same approach as
// `inbox-question-playwright.mjs`.

import assert from 'node:assert/strict';
import test from 'node:test';

import { chromium } from 'playwright';

import {
  findChromeExecutable,
  startStagehandUIServer,
} from '../stagehand/stagehand-test-utils.mjs';

const DRAFT_B = 'Keep this draft: it must survive answering the other question.';

function openQuestions() {
  return [
    {
      id: 'q-draft-a',
      groupID: 'g-draft',
      index: 1,
      status: 'open',
      mode: 'wait',
      sessionID: 'session_1',
      agentID: 'Zav',
      text: 'Question A — the one that gets answered.',
      priority: 'normal',
      askedAt: 1_700_000_000_000,
      readAt: 1_700_000_000_100,
      contextRefs: [],
      deleted: false,
    },
    {
      id: 'q-draft-b',
      groupID: 'g-draft',
      index: 2,
      status: 'open',
      mode: 'wait',
      sessionID: 'session_1',
      agentID: 'Zav',
      text: 'Question B — holds a typed, unsent answer.',
      priority: 'normal',
      askedAt: 1_700_000_000_200,
      readAt: 1_700_000_000_300,
      contextRefs: [],
      deleted: false,
    },
  ];
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

/** Answer the card whose text matches, then leave every other card alone. */
function cardFor(page, questionID) {
  return page.locator(`article.kikx-question-card[data-question-id="${questionID}"]`);
}

test('answering one question keeps the unsent answer typed into another', async (t) => {
  let browser = await launchBrowser(t);
  if (!browser)
    return;

  let fixture = await startStagehandUIServer({
    sessions: [ { id: 'session_1', title: 'Rack Session', messageCount: 0 } ],
  });

  let answerPosts = [];

  try {
    let page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

    await page.route('**/api/v1/questions**', async (route) => {
      let request = route.request();
      let url = new URL(request.url());
      let answerMatch = url.pathname.match(/\/api\/v1\/questions\/([^/]+)\/answer$/);

      if (request.method() === 'POST' && answerMatch) {
        answerPosts.push({
          questionID: decodeURIComponent(answerMatch[1]),
          body: request.postDataJSON(),
        });
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, delivered: true }),
        });
        return;
      }

      if (request.method() === 'POST') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
        return;
      }

      // Always serve both questions as open. This is the nasty case: a GET that
      // predates the answer must not resurrect the answered row, because the
      // closed-id set is what suppresses it.
      let questions = openQuestions();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          questions,
          counts: { open: questions.length, answered: 0, dismissed: 0 },
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

    let cardA = cardFor(page, 'q-draft-a');
    let cardB = cardFor(page, 'q-draft-b');
    await cardA.waitFor({ state: 'visible', timeout: 10000 });
    await cardB.waitFor({ state: 'visible', timeout: 10000 });

    // Type (do not submit) into B. This is the "queued response" the user had
    // written and did not want disturbed.
    let inputB = cardB.locator('.kikx-question-card__input');
    await inputB.fill(DRAFT_B);
    assert.equal(await inputB.inputValue(), DRAFT_B, 'the draft is in the box before answering A');

    // Answer A.
    await cardA.locator('.kikx-question-card__input').fill('Answer for A.');
    await cardA.locator('.kikx-question-card__submit').click();

    await page.waitForFunction(
      () => document.querySelectorAll('article.kikx-question-card[data-question-id="q-draft-a"]').length === 0,
      null,
      { timeout: 10000 },
    );

    assert.equal(answerPosts.length, 1, 'exactly one answer POST');
    assert.equal(answerPosts[0].questionID, 'q-draft-a', 'A is the question that was answered');

    // THE REGRESSION: B's typed text must still be there.
    let cardBAfter = cardFor(page, 'q-draft-b');
    await cardBAfter.waitFor({ state: 'visible', timeout: 10000 });
    assert.equal(
      await cardBAfter.locator('.kikx-question-card__input').inputValue(),
      DRAFT_B,
      'answering question A must not clear the draft typed into question B',
    );

    // B is still answerable — the same text can actually be submitted.
    await cardBAfter.locator('.kikx-question-card__submit').click();
    await page.waitForFunction(
      () => document.querySelectorAll('article.kikx-question-card').length === 0,
      null,
      { timeout: 10000 },
    );
    assert.equal(answerPosts.length, 2, 'the preserved draft could be submitted');
    assert.equal(answerPosts[1].questionID, 'q-draft-b');
    assert.equal(answerPosts[1].body?.answer, DRAFT_B, 'the preserved text is what gets sent');
  } finally {
    await browser.close().catch(() => {});
    await fixture.close();
  }
});

test('a full shell rebuild restores the draft instead of erasing it', async (t) => {
  let browser = await launchBrowser(t);
  if (!browser)
    return;

  let fixture = await startStagehandUIServer({
    sessions: [
      { id: 'session_1', title: 'Rack Session', messageCount: 0 },
      { id: 'session_2', title: 'Second Session', messageCount: 0 },
    ],
  });

  try {
    let page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

    await page.route('**/api/v1/questions**', async (route) => {
      let request = route.request();
      if (request.method() === 'POST') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, delivered: true }) });
        return;
      }
      let questions = openQuestions();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          questions,
          counts: { open: questions.length, answered: 0, dismissed: 0 },
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

    let cardB = cardFor(page, 'q-draft-b');
    await cardB.waitFor({ state: 'visible', timeout: 10000 });
    await cardB.locator('.kikx-question-card__input').fill(DRAFT_B);

    // Leave the view entirely — this destroys every card node. The draft store
    // is what makes that non-destructive.
    let back = page.locator('.kikx-inbox-header .kikx-view__back');
    await back.waitFor({ state: 'visible', timeout: 10000 });
    await back.click();

    // The Back control must actually return to the session list, not just hide
    // the view.
    await page.waitForFunction(
      () => document.querySelectorAll('.kikx-inbox').length === 0,
      null,
      { timeout: 10000 },
    );
    await page.waitForSelector('kikx-session-card', { timeout: 10000 });

    // Re-enter: fresh nodes, restored text.
    await page.locator('.kikx-sidebar__inbox').click();
    await page.waitForSelector('.kikx-inbox', { timeout: 10000 });

    let restored = cardFor(page, 'q-draft-b');
    await restored.waitFor({ state: 'visible', timeout: 10000 });
    assert.equal(
      await restored.locator('.kikx-question-card__input').inputValue(),
      DRAFT_B,
      'a rebuild of the shell must restore the unsent draft, not erase it',
    );

    // A question with no draft stays empty — restoring must not copy one
    // question's text onto another.
    let other = cardFor(page, 'q-draft-a');
    await other.waitFor({ state: 'visible', timeout: 10000 });
    assert.equal(
      await other.locator('.kikx-question-card__input').inputValue(),
      '',
      'an untouched question must not inherit another question draft',
    );
  } finally {
    await browser.close().catch(() => {});
    await fixture.close();
  }
});
