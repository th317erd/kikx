'use strict';

// =============================================================================
// Settings chrome, measured in real Chrome (owner screenshot, 2026-11-17)
// =============================================================================
// The client spec pins STRUCTURE. This one pins what the owner actually
// complained about on screen: two exit controls, frame/session controls sitting
// over a settings form, and a General block with ZERO vertical separation.
//
// Every measurement is a computed style or a bounding box in a real browser, and
// the vertical-rhythm test carries a NEGATIVE CONTROL that re-creates the old
// DOM (bare <p> siblings, no container) and proves the probe would have reported
// 0px for it. Without that control, "gap > 0" could pass for a reason unrelated
// to the fix.

import assert from 'node:assert/strict';
import test from 'node:test';

import puppeteer from 'puppeteer-core';

import { findChromeExecutable, startStagehandUIServer } from '../stagehand/stagehand-test-utils.mjs';

function frames(count) {
  return Array.from({ length: count }, (_value, index) => {
    const number = index + 1;
    const timestamp = 1793328600000000 + number * 1000000;
    return {
      id: `identity_${number}`,
      type: number % 3 === 0 ? 'UserMessage' : 'AgentMessage',
      sessionID: 'session_identity',
      interactionID: `identity_i_${number}`,
      authorType: number % 3 === 0 ? 'user' : 'agent',
      authorID: 'agent_1',
      authorDisplayName: 'Identity Agent',
      hidden: false,
      deleted: false,
      order: number,
      timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
      content: { text: `Frame ${number}: identity body` },
    };
  });
}

async function withPage(t, run) {
  const chromePath = findChromeExecutable();
  if (!chromePath) {
    t.skip('Settings chrome coverage requires Chrome');
    return;
  }

  const fixture = await startStagehandUIServer({
    sessions: [ { id: 'session_identity', title: 'Identity Session', messageCount: 20 } ],
    agents: [ { id: 'agent_1', name: 'Identity Agent', pluginID: 'test-agent', enabled: true } ],
  });
  fixture.frameRuntime.framesBySessionID.set('session_identity', frames(20));
  const port = new URL(fixture.baseURL).port;

  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: process.env.KIKX_PUPPETEER_HEADLESS === '0' ? false : 'new',
    args: [ '--no-sandbox', '--disable-setuid-sandbox' ],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(String(error?.message || error)));
    await page.evaluateOnNewDocument(() => {
      sessionStorage.setItem('kikx.auth.session',
        JSON.stringify({ token: 'identity-token', refresh_token: 'identity-refresh' }));
    });
    await run(page, port);
    assert.deepEqual(pageErrors, [], 'no page errors');
  } finally {
    await browser.close();
    fixture.close();
  }
}

test('Settings bar carries ONE exit control and no search / Add Project (owner 2026-11-17)', async (t) => {
  await withPage(t, async (page, port) => {
    // Enter from a real session so the push has a depth-2 stack behind it --
    // that is the condition that produced the duplicate chevron.
    await page.goto(`http://127.0.0.1:${port}/?session=session_identity`,
      { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForSelector('.kikx-thread-scrollview', { timeout: 15000 });
    await new Promise((resolve) => setTimeout(resolve, 300));

    const before = await page.evaluate(() => ({
      close: document.querySelectorAll('.kikx-window__close').length,
      search: document.querySelectorAll('.kikx-topbar__search-group').length,
      add: document.querySelectorAll('.kikx-topbar__trailing-actions').length,
    }));
    assert.deepEqual(before, { close: 1, search: 1, add: 1 },
      'precondition: a nested session shows chevron + search + Add');

    await page.click('.kikx-brand__mark');
    await page.waitForSelector('.kikx-system-settings', { timeout: 10000 });
    await new Promise((resolve) => setTimeout(resolve, 300));

    const inSettings = await page.evaluate(() => ({
      close: document.querySelectorAll('.kikx-window__close').length,
      exit: document.querySelectorAll('.kikx-breadcrumb__exit-settings').length,
      search: document.querySelectorAll('.kikx-topbar__search-group').length,
      searchInput: document.querySelectorAll('input[name="session-search"]').length,
      add: document.querySelectorAll('.kikx-topbar__trailing-actions').length,
      addText: (document.querySelector('.kikx-topbar')?.innerText || '').includes('Add Project'),
      exitText: (document.querySelector('.kikx-breadcrumb__exit-settings')?.textContent || '').trim(),
    }));

    // Defect 1: the two-in-one exit. Exactly one affordance, and it is the crumb.
    assert.equal(inSettings.close, 0, 'no duplicate session-close chevron inside Settings');
    assert.equal(inSettings.exit, 1, 'exactly one exit control remains');
    assert.equal(inSettings.exitText, '< Exit Settings', 'and it is the owner\'s labelled control');

    // Defect 2: session/frame controls over a settings form.
    assert.equal(inSettings.search, 0, 'no search group');
    assert.equal(inSettings.searchInput, 0, 'no search field in the DOM');
    assert.equal(inSettings.add, 0, 'no trailing Add container');
    assert.equal(inSettings.addText, false, 'and no "Add Project" label rendered');
  });
});

test('the single exit control actually leaves Settings (not just relabelled)', async (t) => {
  await withPage(t, async (page, port) => {
    await page.goto(`http://127.0.0.1:${port}/?session=session_identity`,
      { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForSelector('.kikx-thread-scrollview', { timeout: 15000 });
    await page.click('.kikx-brand__mark');
    await page.waitForSelector('.kikx-system-settings', { timeout: 10000 });

    // Dispatch INSIDE the page, not via page.click(). page.click resolves an
    // ElementHandle and THEN scrolls/intersects it; the topbar re-renders when
    // the mode drops, so the handle went stale mid-click and the run died with
    // "Node is detached from document" (puppeteer ElementHandle.js:1300).
    // One synchronous evaluate resolves, checks and clicks the SAME node in a
    // single JS turn, so no re-render can slip in between. This tests the
    // product, not the race in the harness.
    await page.evaluate(() => {
      const exit = document.querySelector('.kikx-breadcrumb__exit-settings');
      if (!exit)
        throw new Error('exit control missing before click');
      exit.click();
    });
    let left = false;
    for (let attempt = 0; attempt < 40 && !left; attempt += 1) {
      left = await page.evaluate(() => !document.querySelector('.kikx-system-settings'));
      if (!left)
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(left, true, 'clicking the crumb leaves the mode — the exit is wired, not decorative');

    const after = await page.evaluate(() => ({
      thread: Boolean(document.querySelector('.kikx-thread-scrollview')),
      close: document.querySelectorAll('.kikx-window__close').length,
      search: document.querySelectorAll('.kikx-topbar__search-group').length,
      searchParam: location.search.includes('view=settings'),
    }));
    assert.equal(after.thread, true, 'the session it came from is back');
    assert.equal(after.close, 1, 'and the nested-session chevron returns with it');
    assert.equal(after.search, 1, 'as does the search group');
    assert.equal(after.searchParam, false, 'the URL drops the mode');
  });
});

test('General has real vertical rhythm, proven against a re-created broken DOM (owner 2026-11-17)', async (t) => {
  await withPage(t, async (page, port) => {
    await page.goto(`http://127.0.0.1:${port}/?view=settings`,
      { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForSelector('.kikx-settings-general', { timeout: 15000 });

    const measured = await page.evaluate(() => {
      const stack = document.querySelector('.kikx-settings-general');
      const cards = [ ...document.querySelectorAll('.kikx-settings-general__card') ];
      const facts = document.querySelector('.kikx-settings-general__facts');
      const terms = [ ...document.querySelectorAll('.kikx-settings-general__facts dt') ];
      const defs = [ ...document.querySelectorAll('.kikx-settings-general__facts dd') ];

      const rect = (node) => {
        const box = node.getBoundingClientRect();
        return { top: box.top, bottom: box.bottom, left: box.left, right: box.right, height: box.height };
      };

      // The old defect, re-created INSIDE the live page: two bare <p> siblings
      // with no container, exactly the structure that read as run-on text.
      const probe = document.createElement('section');
      const heading = document.createElement('h3');
      heading.textContent = 'Account';
      const first = document.createElement('p');
      first.textContent = 'Name: Wyatt';
      const second = document.createElement('p');
      second.textContent = 'Email: weg@example.com';
      probe.append(heading, first, second);
      stack.parentElement.appendChild(probe);
      const controlSeparation = Math.round(rect(second).top - rect(first).bottom);
      probe.remove();

      return {
        stackDisplay: getComputedStyle(stack).display,
        stackGap: getComputedStyle(stack).rowGap,
        cardGap: cards.length > 0 ? getComputedStyle(cards[0]).rowGap : null,
        cardPaddingTop: cards.length > 0 ? getComputedStyle(cards[0]).paddingTop : null,
        cards: cards.map(rect),
        terms: terms.map(rect),
        defs: defs.map(rect),
        factsTop: facts ? rect(facts).top : null,
        controlSeparation,
        firstHeadingBottom: cards.length > 0
          ? Math.round(rect(cards[0].querySelector('h3')).bottom)
          : null,
        controlTop: controlSeparation,
      };
    });

    // The card stack is a real flex column with a gap, not a block box.
    assert.equal(measured.stackDisplay, 'flex', 'General is a flex column');
    assert.ok(parseFloat(measured.stackGap) > 0,
      `the cards are separated (rowGap=${measured.stackGap}); 0px is the reported defect`);
    assert.ok(parseFloat(measured.cardGap) > 0,
      `each card spaces its children (rowGap=${measured.cardGap})`);
    assert.ok(parseFloat(measured.cardPaddingTop) > 0,
      `and has padding so text is off the border (${measured.cardPaddingTop})`);

    assert.equal(measured.cards.length, 2, 'Account and Theme cards both render');

    // Cards must not overlap: the lower card starts BELOW the upper one ends.
    assert.ok(measured.cards[1].top >= measured.cards[0].bottom,
      `cards do not overlap (card1.bottom=${measured.cards[0].bottom}, card2.top=${measured.cards[1].top})`);

    // THE LAYOUT CLAIM: label cells share a column, value cells share a column.
    // This is what turns two sentences into aligned fields.
    assert.equal(measured.terms.length, 2, 'two label cells');
    assert.equal(measured.defs.length, 2, 'two value cells');
    assert.equal(Math.round(measured.terms[0].left), Math.round(measured.terms[1].left),
      'both labels start at the same x — they form one column');
    assert.equal(Math.round(measured.defs[0].left), Math.round(measured.defs[1].left),
      'both values start at the same x — they form a second column');
    assert.ok(measured.defs[0].left > measured.terms[0].right,
      `values sit to the RIGHT of their labels (label right=${measured.terms[0].right}, value left=${measured.defs[0].left})`);

    // NEGATIVE CONTROL: the old structure measures 0px separation. If the probe
    // reported > 0 here, the positive assertions above would prove nothing.
    assert.equal(measured.controlSeparation, 0,
      `the pre-fix DOM shape measures 0px between rows — the probe discriminates (got ${measured.controlSeparation})`);
  });
});
