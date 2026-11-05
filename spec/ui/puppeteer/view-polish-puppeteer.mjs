'use strict';

// Owner polish batch (2026-11-05), each item pinned because it is invisible to
// the unit suite:
//
//   1. "Header doesn't completely span frame on mobile" — the message header
//      is full-bleed via negative margins; mobile.css's max-width:100% group
//      clamped it to the frame's CONTENT box, dropping the over-constrained
//      right margin and leaving a ~24px sliver past the header's right edge.
//   2. "Inbox/Agents/Teams text is NOT vertically centered (along with its
//      count bubble)" — the shared view header aligned items on their
//      baselines; a back button + badge hung high against the title text.
//   3. "The mouse cursor is the text caret over a session name; prefer
//      pointer" — the rename surfaces said `cursor: text` (a passive field)
//      instead of `cursor: pointer` (a double-click target).
//   4. "Double-click to rename doesn't work (possibly related to #3)" —
//      double-click works at rest; it died under page-load lockups (the
//      frozen-input report). This pins it DURING active page loads: jump the
//      thread to force the "Loading page…" pill, then double-click.

import assert from 'node:assert/strict';
import test from 'node:test';

import puppeteer from 'puppeteer-core';

import { findChromeExecutable, startStagehandUIServer } from '../stagehand/stagehand-test-utils.mjs';

function frames(count) {
  return Array.from({ length: count }, (_value, index) => {
    const number = index + 1;
    const timestamp = 1793328600000000 + number * 1000000;
    return {
      id: `polish_${number}`,
      type: number % 3 === 0 ? 'UserMessage' : 'AgentMessage',
      sessionID: 'session_polish',
      interactionID: `polish_i_${number}`,
      authorType: number % 3 === 0 ? 'user' : 'agent',
      authorID: 'agent_1',
      authorDisplayName: 'Polish Agent',
      hidden: false,
      deleted: false,
      order: number,
      timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
      content: { text: `Frame ${number}: ${'polish body '.repeat(12)}` },
    };
  });
}

async function openPage(browser, { port, viewport, mobile = false }) {
  const page = await browser.newPage();
  await page.setViewport(viewport);
  if (mobile) {
    await page.setViewport({ ...viewport, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1');
  }
  await page.evaluateOnNewDocument(() => {
    sessionStorage.setItem('kikx.auth.session', JSON.stringify({ token: 'polish-token', refresh_token: 'polish-refresh' }));
  });
  await page.goto(`http://127.0.0.1:${port}/?session=session_polish`, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForSelector('.kikx-thread-scrollview', { timeout: 15000 });
  await new Promise((resolve) => setTimeout(resolve, 400));
  return page;
}

test('Puppeteer view polish: header span, view-header centering, pointer cursor, rename during load', async (t) => {
  let chromePath = findChromeExecutable();
  if (!chromePath) {
    t.skip('Puppeteer view-polish coverage requires Chrome');
    return;
  }

  const fixture = await startStagehandUIServer({
    sessions: [ { id: 'session_polish', title: 'Polish Session', messageCount: 600 } ],
    agents: [ { id: 'agent_1', name: 'Polish Agent', pluginID: 'test-agent', enabled: true } ],
  });
  fixture.frameRuntime.framesBySessionID.set('session_polish', frames(600));
  const port = new URL(fixture.baseURL).port;

  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: process.env.KIKX_PUPPETEER_HEADLESS === '0' ? false : 'new',
    args: [ '--no-sandbox', '--disable-setuid-sandbox' ],
  });

  try {
    // ---- 1. mobile: the message header is flush with the frame ------------
    const mobile = await openPage(browser, { port, viewport: { width: 390, height: 844 }, mobile: true });
    const headerSpan = await mobile.evaluate(() => {
      const frame = document.querySelector('.kikx-frame--AgentMessage');
      const meta = frame?.querySelector('.kikx-frame__meta');
      if (!frame || !meta) return null;
      const f = frame.getBoundingClientRect();
      const m = meta.getBoundingClientRect();
      return { leftGap: Math.round((m.left - f.left) * 10) / 10, rightGap: Math.round((f.right - m.right) * 10) / 10 };
    });
    assert.ok(headerSpan, 'a message frame with a header must render on mobile');
    assert.ok(headerSpan.rightGap <= 2,
      `the header must reach the frame's right edge (rightGap=${headerSpan.rightGap}px — the old clamp left ~24px)`);
    assert.ok(headerSpan.leftGap <= 2, `header stays full-bleed on the left too (leftGap=${headerSpan.leftGap}px)`);
    await mobile.close();

    // ---- 2 + 3 + 4: desktop ------------------------------------------------
    const desktop = await openPage(browser, { port, viewport: { width: 1280, height: 800 } });

    // 2. Agents view header: back button, title and count share one center line.
    await desktop.evaluate(() => {
      const agents = [ ...document.querySelectorAll('.kikx-sidebar__view') ]
        .find((button) => button.textContent.trim() === 'Agents');
      agents?.click();
    });
    await desktop.waitForSelector('.kikx-view-header', { timeout: 10000 });
    const centering = await desktop.evaluate(() => {
      const header = document.querySelector('.kikx-view-header');
      // Measure the children against THEIR OWN row: the header wraps the scope
      // line onto a second row, so the whole-box center is below row one and
      // every child shifts together (uniformly) — the property that matters is
      // that back/title/count share ONE vertical center (baseline alignment
      // spreads them by their differing box heights).
      const children = [ ...header.children ]
        .filter((child) => getComputedStyle(child).flex !== '1 1 100%')
        .map((child) => {
          const c = child.getBoundingClientRect();
          return { cls: String(child.className).slice(0, 40), center: (c.top + c.bottom) / 2 };
        });
      const centers = children.map((child) => child.center);
      return {
        align: getComputedStyle(header).alignItems,
        children,
        spread: centers.length ? Math.round((Math.max(...centers) - Math.min(...centers)) * 10) / 10 : null,
      };
    });
    assert.equal(centering.align, 'center', 'the view header centers its boxes, not baselines');
    assert.ok(centering.children.length >= 3, `back/title/count must share the header row: ${JSON.stringify(centering.children)}`);
    assert.ok(centering.spread <= 2,
      `back button, title and count must share one vertical center (spread=${centering.spread}px): ${JSON.stringify(centering.children.map((c) => c.cls))}`);

    // Back to the thread for 3 + 4.
    await desktop.evaluate(() => document.querySelector('.kikx-window__close')?.click());
    await desktop.waitForSelector('.kikx-thread-scrollview', { timeout: 10000 });
    await new Promise((resolve) => setTimeout(resolve, 300));

    // 3. cursor: pointer over the session name.
    const cursor = await desktop.evaluate(() => {
      const crumb = document.querySelector('.kikx-breadcrumb__crumb--active');
      return crumb ? getComputedStyle(crumb).cursor : null;
    });
    assert.equal(cursor, 'pointer', 'the session name advertises a click target, not a text caret');

    // 4. double-click WHILE pages are loading (the frozen-input report).
    const jump = (fraction) => desktop.evaluate((f) => {
      const list = document.querySelector('.kikx-frame-list');
      list.scrollTop = (list.scrollHeight - list.clientHeight) * f;
    }, fraction);
    let loading = false;
    for (let attempt = 0; attempt < 8 && !loading; attempt++) {
      await jump(attempt % 2 === 0 ? 0.1 : 0.7);
      loading = await desktop.waitForFunction(() => {
        const pill = document.querySelector('.aeor-scrollview__status--top');
        return Boolean(pill && !pill.hidden && pill.textContent);
      }, { timeout: 2500 }).then(() => true).catch(() => false);
    }
    assert.ok(loading, 'the Loading page pill must appear so the rename runs under load');
    const crumbBox = await desktop.evaluate(() => {
      const node = document.querySelector('.kikx-breadcrumb__crumb--active');
      const r = node.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    // Retry the double-click: under a parallel batch the first click pair can
    // land across a load task boundary and fail to pair. Every attempt still
    // happens inside the loading window — the property under test.
    let renameState = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      await desktop.mouse.click(crumbBox.x, crumbBox.y, { clickCount: 2 });
      await desktop.waitForFunction(
        () => Boolean(document.querySelector('input[name="session-name"]')),
        { timeout: 1200 },
      ).catch(() => {});
      renameState = await desktop.evaluate(() => ({
        editing: document.querySelector('kikx-app')._state.editingSessionNameID || null,
        input: Boolean(document.querySelector('input[name="session-name"]')),
      }));
      if (renameState.editing && renameState.input)
        break;
    }
    assert.ok(renameState.editing && renameState.input,
      `double-click during a page load must open the rename editor (got ${JSON.stringify(renameState)})`);
    await desktop.close();
  } finally {
    await browser.close();
    await fixture.close();
  }
});
