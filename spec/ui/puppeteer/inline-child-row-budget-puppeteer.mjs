'use strict';

// The child-session row must leave the conversation usable.
//
// This exists because the inline row shipped a regression that every other test
// in the suite passed. `inline-child-sessions-puppeteer.mjs` asserts that the
// thread and the children are on screen together, which was true and remained
// true. What it never asked was HOW MUCH of the window the row took.
//
// With a two-child fixture the row was small and the thread was fine. The
// owner's real session has nine direct children, and at `aspect-ratio: 1 / 1`
// per card preview those nine became two rows of 347px cards -- 668px of a 896px
// window, 74.6%, leaving the thread a 36px sliver. The person looking at the
// screen called it a split view, and they were right.
//
// So the budget below is the point of this file. It is expressed as a share of
// the session window rather than in pixels, so it holds on a laptop and on a
// large display, and it is measured after layout rather than inferred from CSS.

import assert from 'node:assert/strict';
import test from 'node:test';

import puppeteer from 'puppeteer-core';

import { findChromeExecutable, startStagehandUIServer } from '../stagehand/stagehand-test-utils.mjs';

const PARENT_ID = 'session_budget_parent';
const CHILD_COUNT = 9;

// Generous enough not to fail on a font or padding change, tight enough that the
// regression above (74.6%) cannot come back.
const MAX_CHILDREN_SHARE = 0.5;
const MIN_THREAD_SHARE = 0.2;

// The viewport the regression was observed at, so the numbers are comparable to
// the report rather than to a convenient test size.
const VIEWPORT = { width: 1600, height: 1000 };

test('an inline child row with many children leaves the thread a usable share of the window', async (t) => {
  let chromePath = findChromeExecutable();
  if (!chromePath) {
    t.skip('Puppeteer child-row budget coverage requires Chrome');
    return;
  }

  let children = Array.from({ length: CHILD_COUNT }, (_, index) => ({
    id: `session_budget_child_${index}`,
    title: `Child ${index} of a large family`,
    parentSessionID: PARENT_ID,
    messageCount: 2,
  }));

  let fixture = await startStagehandUIServer({
    sessions: [
      { id: PARENT_ID, title: 'Parent With Many Children', messageCount: 3 },
      ...children,
    ],
  });

  // A real conversation in the parent, so the thread body has content and its
  // height is the window's decision rather than its children's.
  fixture.frameRuntime.framesBySessionID.set(PARENT_ID, [
    frame('f_budget_1', 'UserMessage', 1, PARENT_ID, 'first question in the parent thread'),
    frame('f_budget_2', 'AgentMessage', 2, PARENT_ID, 'first answer in the parent thread'),
    frame('f_budget_3', 'UserMessage', 3, PARENT_ID, 'second question in the parent thread'),
  ]);

  let browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: process.env.KIKX_PUPPETEER_HEADLESS === '0' ? false : 'new',
    args: [ '--no-sandbox', '--disable-setuid-sandbox' ],
  });

  try {
    let page = await browser.newPage();
    await page.setViewport(VIEWPORT);
    await page.evaluateOnNewDocument(() => {
      sessionStorage.setItem('kikx.auth.session', JSON.stringify({ token: 'budget-token', refresh_token: 'budget-refresh' }));
    });

    await page.goto(`${fixture.baseURL}/?session=${PARENT_ID}`, {
      waitUntil: 'domcontentloaded',
      timeout: 15000,
    });
    await page.waitForSelector('.kikx-thread__children kikx-session-card', { timeout: 15000 });
    await page.waitForSelector('.kikx-thread__body .kikx-frame', { timeout: 15000 });
    await waitForRenderSettled(page);

    let layout = await page.evaluate(() => {
      let height = (selector) => {
        let el = document.querySelector(selector);
        return el ? el.getBoundingClientRect().height : null;
      };
      let region = document.querySelector('.kikx-thread__children');
      let cards = Array.from(region?.querySelectorAll('kikx-session-card') || [])
        .filter((card) => !card.classList.contains('kikx-session-card--add'));

      // Row structure, so "compact" cannot be achieved by stacking the cards
      // into one long column. Distinct `top` values are the rows.
      let tops = [ ...new Set(cards.map((card) => Math.round(card.getBoundingClientRect().top))) ];

      // The row must still not be a scroll pane: that was the original defect and
      // shrinking the cards is not a licence to bring the scroller back.
      let scrollers = [];
      for (let el of [ region, ...(region?.querySelectorAll('*') || []) ]) {
        if (!el)
          continue;
        let style = getComputedStyle(el);
        if (style.overflowY === 'auto' || style.overflowY === 'scroll')
          scrollers.push(el.className || el.tagName.toLowerCase());
      }

      // The preview inside a card must stay bounded. `aspect-ratio: 1 / 1` on a
      // 176px host would still be a 176px band, but a later widening of the host
      // would silently grow every card again, so the card height itself is
      // asserted.
      let cardHeights = cards.map((card) => Math.round(card.getBoundingClientRect().height));
      let cardWidths = cards.map((card) => Math.round(card.getBoundingClientRect().width));

      return {
        windowHeight: height('.kikx-thread'),
        childrenHeight: height('.kikx-thread__children'),
        threadBodyHeight: height('.kikx-thread__body'),
        cardCount: cards.length,
        rowCount: tops.length,
        scrollers,
        maxCardHeight: cardHeights.length ? Math.max(...cardHeights) : 0,
        maxCardWidth: cardWidths.length ? Math.max(...cardWidths) : 0,
      };
    });

    // Guard the fixture itself: if this is not nine cards, the shares below mean
    // nothing and the test would pass while measuring the wrong page.
    assert.equal(layout.cardCount, CHILD_COUNT,
      `the fixture renders all ${CHILD_COUNT} child cards (saw ${layout.cardCount})`);
    assert.ok(layout.windowHeight > 0 && layout.childrenHeight > 0 && layout.threadBodyHeight > 0,
      `all three regions are laid out (window ${layout.windowHeight}, row ${layout.childrenHeight}, thread ${layout.threadBodyHeight})`);

    let childrenShare = layout.childrenHeight / layout.windowHeight;
    let threadShare = layout.threadBodyHeight / layout.windowHeight;

    assert.ok(
      childrenShare <= MAX_CHILDREN_SHARE,
      `the child row stays under ${MAX_CHILDREN_SHARE * 100}% of the window with ${CHILD_COUNT} children `
      + `(saw ${(childrenShare * 100).toFixed(1)}%: ${layout.childrenHeight}px of ${layout.windowHeight}px)`,
    );
    assert.ok(
      threadShare >= MIN_THREAD_SHARE,
      `the thread keeps at least ${MIN_THREAD_SHARE * 100}% of the window so the conversation is readable `
      + `(saw ${(threadShare * 100).toFixed(1)}%: ${layout.threadBodyHeight}px of ${layout.windowHeight}px)`,
    );

    // Compact, not stacked into a column, and not shrunk into unclickable slivers.
    assert.ok(layout.rowCount >= 2,
      `cards still wrap into rows rather than stacking one per line (saw ${layout.rowCount} row(s))`);
    assert.ok(layout.maxCardHeight <= 220,
      `a child card stays a compact navigation target (saw ${layout.maxCardHeight}px tall)`);
    assert.ok(layout.maxCardWidth >= 120 && layout.maxCardWidth <= 260,
      `a child card stays wide enough to read its title (saw ${layout.maxCardWidth}px wide)`);

    assert.deepEqual(layout.scrollers, [],
      `the child row is not a scroll pane (saw scrollers ${JSON.stringify(layout.scrollers)})`);
  }
  finally {
    await browser.close();
    await fixture.close();
  }
});

test('the compact child card rules do not reach the root Projects grid', async (t) => {
  let chromePath = findChromeExecutable();
  if (!chromePath) {
    t.skip('Puppeteer child-row budget coverage requires Chrome');
    return;
  }

  let fixture = await startStagehandUIServer({
    sessions: [
      { id: PARENT_ID, title: 'Parent With Many Children', messageCount: 3 },
      ...Array.from({ length: CHILD_COUNT }, (_, index) => ({
        id: `session_budget_child_${index}`,
        title: `Child ${index} of a large family`,
        parentSessionID: PARENT_ID,
        messageCount: 2,
      })),
    ],
  });

  let browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: process.env.KIKX_PUPPETEER_HEADLESS === '0' ? false : 'new',
    args: [ '--no-sandbox', '--disable-setuid-sandbox' ],
  });

  try {
    let page = await browser.newPage();
    await page.setViewport(VIEWPORT);
    await page.evaluateOnNewDocument(() => {
      sessionStorage.setItem('kikx.auth.session', JSON.stringify({ token: 'budget-token', refresh_token: 'budget-refresh' }));
    });

    await page.goto(`${fixture.baseURL}/`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForSelector('.kikx-workspace kikx-session-card', { timeout: 15000 });
    await waitForRenderSettled(page);

    let root = await page.evaluate(() => {
      let card = document.querySelector('.kikx-workspace kikx-session-card:not(.kikx-session-card--add)');
      if (!card)
        return null;
      let body = card.querySelector('.kikx-session-card__body');
      let host = getComputedStyle(card);
      let bodyStyle = body ? getComputedStyle(body) : null;
      let box = card.getBoundingClientRect();
      return {
        hostDisplay: host.display,
        hostWidth: Math.round(box.width),
        bodyAspectRatio: bodyStyle ? bodyStyle.aspectRatio : null,
        bodyHeight: body ? Math.round(body.getBoundingClientRect().height) : null,
        hasChildrenRow: document.querySelectorAll('.kikx-thread__children').length,
      };
    });

    assert.ok(root, 'the root Projects grid renders a session card');
    assert.equal(root.hasChildrenRow, 0, 'the root grid does not render the inline child row');

    // The Projects grid keeps the square preview. It is a chooser across the full
    // width, and the compact variant is scoped to the inline row only.
    assert.ok(/^[1-9]/.test(String(root.bodyAspectRatio || '')),
      `the root grid card keeps its square preview (saw aspect-ratio: ${root.bodyAspectRatio})`);
  }
  finally {
    await browser.close();
    await fixture.close();
  }
});

function frame(id, type, order, sessionID, text) {
  return {
    id,
    type,
    sessionID,
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
    content: { text },
  };
}

async function waitForRenderSettled(page, quietMS = 300, timeoutMS = 15000) {
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
    }
    else if (Date.now() - stableSince >= quietMS) {
      return;
    }
    await delay(25);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
