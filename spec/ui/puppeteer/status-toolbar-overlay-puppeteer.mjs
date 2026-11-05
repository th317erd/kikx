'use strict';

// Status-bar + toolbar + STOP overhaul (owner change, 2026-11-05):
//
//   1. mobile status bar keeps the connection DOT, drops the words;
//   2. the tokens WORD is the traced SVG icon (desktop and mobile);
//   3. Debug moved out of the status bar, next to Raw in the toolbar;
//   4. counts collapse to bare slash-joined numbers: `1 / 0 / 1234 / 234`;
//   A. mobile toolbar: the eye becomes a ⋮ popup carrying every toolbar action
//      with the filter checkboxes underneath them;
//   B. STOP floats horizontally centered ABOVE the input field, never beside
//      Send, on both desktop and mobile.
//
// Geometry and visibility are the point here — mini-dom cannot see either.

import assert from 'node:assert/strict';
import test from 'node:test';

import puppeteer from 'puppeteer-core';

import { findChromeExecutable, startStagehandUIServer } from '../stagehand/stagehand-test-utils.mjs';

function frames(count) {
  return Array.from({ length: count }, (_value, index) => {
    let number = index + 1;
    let timestamp = 1781035260000000 + number * 1000000;
    return {
      id: `ovl_frame_${number}`,
      type: number % 2 === 0 ? 'UserMessage' : 'AgentMessage',
      sessionID: 'session_ovl',
      interactionID: `ovl_interaction_${number}`,
      authorType: number % 2 === 0 ? 'user' : 'agent',
      authorID: number % 2 === 0 ? 'ovl_user' : 'ovl_agent',
      authorDisplayName: number % 2 === 0 ? 'Wyatt' : 'Overlay Agent',
      hidden: false,
      deleted: false,
      order: number,
      timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
      content: { text: `Overlay message ${number}` },
    };
  });
}

function rectProbe(page) {
  return page.evaluate(() => {
    const rect = (selector) => {
      const node = document.querySelector(selector);
      if (!node) return null;
      const box = node.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height, right: box.right, bottom: box.bottom };
    };
    const display = (selector) => {
      const node = document.querySelector(selector);
      return node ? getComputedStyle(node).display : null;
    };
    const stats = document.querySelector('.kikx-statusbar__stats');
    const tokens = document.querySelector('.kikx-statusbar__tokens');
    return {
      connectionDisplay: display('.kikx-statusbar__connection'),
      dotRect: rect('.kikx-statusbar__dot'),
      labelCount: document.querySelectorAll('.kikx-statusbar__stat-label').length,
      sepCount: document.querySelectorAll('.kikx-statusbar__stat-sep').length,
      statsText: stats ? stats.textContent.replace(/\s+/g, '') : null,
      statusbarHasDebug: Boolean(document.querySelector('.kikx-statusbar .kikx-debug-toggle')),
      tokensHasIcon: Boolean(tokens?.querySelector('svg[data-icon="tokens"]')),
      tokensBBox: (() => {
        const path = tokens?.querySelector('svg[data-icon="tokens"] path');
        if (!path) return null;
        const box = path.getBBox();
        return { width: box.width, height: box.height };
      })(),
      tokensText: tokens ? tokens.textContent.trim() : null,
      eyeDisplay: display('kikx-frame-filter-popup'),
      actionsDisplay: display('.kikx-window__actions'),
      overflowDisplay: display('kikx-overflow-popup'),
      overflowIcon: Boolean(document.querySelector('.kikx-overflow__button svg[data-icon="dots-vertical"]')),
      rawRect: rect('.kikx-raw-toggle'),
      debugRect: rect('.kikx-debug-toggle'),
      actionsDebug: Boolean(document.querySelector('.kikx-window__actions .kikx-debug-toggle')),
      rawNextIsDebug: (() => {
        const raw = document.querySelector('.kikx-window__actions .kikx-raw-toggle');
        const next = raw?.nextElementSibling;
        return Boolean(next && next.classList?.contains('kikx-debug-toggle'));
      })(),
      stop: rect('.kikx-stop-button'),
      composer: rect('.kikx-composer'),
      sendLabel: rect('.kikx-send-button__label'),
      sendHint: rect('.kikx-send-button__hint'),
      textarea: rect('textarea[name="message"]'),
      send: rect('.kikx-send-button'),
      viewport: { width: innerWidth, height: innerHeight },
      documentOverflowX: document.documentElement.scrollWidth > innerWidth + 1,
    };
  });
}

function assertShared(bar) {
  assert.ok(bar.dotRect && bar.dotRect.width > 0, 'the connection dot must stay visible');
  assert.equal(bar.labelCount, 0, 'no label text anywhere');
  assert.equal(bar.sepCount, 3, 'three slash separators join the four counts');
  assert.match(bar.statsText || '', /^\d+(\/\d+){3}$/, `counts must read as bare numbers, got "${bar.statsText}"`);
  assert.equal(bar.statusbarHasDebug, false, 'Debug is gone from the status bar');
  assert.ok(bar.tokensHasIcon, 'the tokens cell carries the traced SVG icon');
  assert.ok(bar.tokensBBox && bar.tokensBBox.width > 100 && bar.tokensBBox.height > 100,
    `the tokens icon must draw real geometry, got ${JSON.stringify(bar.tokensBBox)}`);
  assert.ok(Math.abs((bar.tokensBBox.width / bar.tokensBBox.height) - 1) <= 0.2,
    `the tokens icon should read as a square glyph, got ${JSON.stringify(bar.tokensBBox)}`);
  assert.match(bar.tokensText || '', /^\d[\d,]*$/, `the tokens cell is icon + number, got "${bar.tokensText}"`);
  assert.ok(bar.actionsDebug, 'Debug lives in the toolbar actions');
  assert.ok(bar.rawNextIsDebug, 'Debug sits immediately after Raw');

  // STOP floats horizontally centered over the composer — the message input
  // area — on every width. (Not the raw viewport: on desktop the sidebar
  // shifts the whole thread column right, and centering on the window would
  // park STOP over the workspace pane.)
  const composerCenter = bar.composer.x + bar.composer.width / 2;
  const stopCenter = bar.stop.x + bar.stop.width / 2;
  assert.ok(Math.abs(stopCenter - composerCenter) <= 2,
    `STOP must be horizontally centered over the input (stop center ${stopCenter}, composer center ${composerCenter})`);
  assert.ok(bar.stop.bottom <= bar.textarea.y + 1,
    `STOP must float above the input field (stop.bottom=${bar.stop.bottom}, textarea.y=${bar.textarea.y})`);
  assert.ok(bar.stop.bottom <= bar.send.y + 1,
    'STOP must never share a press zone with Send');
  assert.ok(bar.stop.height <= 40, `STOP must shrink (height=${bar.stop.height})`);

  // Send reads as two stacked lines: "Send" over "(Enter)".
  assert.ok(bar.sendLabel && bar.sendHint, 'the Send button renders both lines');
  assert.ok(bar.sendHint.y >= bar.sendLabel.bottom,
    `the (Enter) line must sit BELOW Send (label.bottom=${bar.sendLabel.bottom}, hint.y=${bar.sendHint.y})`);
  assert.ok(Math.abs((bar.sendHint.x + bar.sendHint.width / 2) - (bar.sendLabel.x + bar.sendLabel.width / 2)) <= 2,
    'both lines are centered on each other');
}

test('Puppeteer status bar + toolbar overflow + floating STOP on mobile and desktop', async (t) => {
  let chromePath = findChromeExecutable();
  if (!chromePath) {
    t.skip('Puppeteer status/toolbar overlay coverage requires Chrome');
    return;
  }

  let fixture = await startStagehandUIServer({
    sessions: [ { id: 'session_ovl', title: 'Overlay Session', messageCount: 8 } ],
    agents: [ { id: 'ovl_agent', name: 'Overlay Agent', pluginID: 'test-agent', enabled: true } ],
  });
  fixture.frameRuntime.framesBySessionID.set('session_ovl', frames(8));

  let browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: process.env.KIKX_PUPPETEER_HEADLESS === '0' ? false : 'new',
    args: [ '--no-sandbox', '--disable-setuid-sandbox' ],
  });

  try {
    // ---- Mobile ----------------------------------------------------------
    let mobile = await browser.newPage();
    await mobile.setViewport({ width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
    await mobile.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1');
    await mobile.evaluateOnNewDocument(() => {
      sessionStorage.setItem('kikx.auth.session', JSON.stringify({ token: 'ovl-token', refresh_token: 'ovl-refresh' }));
    });
    await mobile.goto(`${fixture.baseURL}/?session=session_ovl`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await mobile.waitForSelector('.kikx-thread-scrollview', { timeout: 15000 });
    await new Promise((resolve) => setTimeout(resolve, 350));

    let m = await rectProbe(mobile);
    assertShared(m);
    assert.equal(m.connectionDisplay, 'none', 'mobile drops the connection TEXT');
    assert.equal(m.eyeDisplay, 'none', 'the eye gives its slot to the ⋮ on mobile');
    assert.equal(m.actionsDisplay, 'none', 'the actions cluster moves into the ⋮ menu on mobile');
    assert.match(m.overflowDisplay, /^(block|inline-block)$/, 'the ⋮ is shown on mobile');
    assert.ok(m.overflowIcon, 'the ⋮ carries the vertical triple-dot icon');
    assert.equal(m.documentOverflowX, false, 'nothing overflows horizontally');

    // Open the menu: actions on top, filter checkboxes underneath.
    await mobile.click('.kikx-overflow__button');
    await mobile.waitForFunction(() => {
      let panel = document.querySelector('.kikx-overflow__panel');
      return panel && !panel.hidden;
    }, { timeout: 5000 });

    let menu = await mobile.evaluate(() => {
      let panel = document.querySelector('.kikx-overflow__panel');
      let text = panel ? panel.textContent : '';
      let rows = [...(panel?.querySelectorAll('.kikx-overflow__filters .kikx-frame-filter__row') || [])];
      return {
        hasRaw: text.includes('Raw'),
        hasDebug: text.includes('Debug'),
        hasSettings: text.includes('Settings'),
        hasAdd: /\+\s*Add/.test(text),
        dividerCount: panel.querySelectorAll('.kikx-overflow__divider').length,
        embeddedPanelVisible: (() => {
          let embedded = panel.querySelector('.kikx-overflow__filters .kikx-frame-filter__panel');
          return Boolean(embedded) && !embedded.hidden;
        })(),
        filterRowCount: rows.length,
        hiddenChecked: rows.find((row) => row.dataset.filterKey === 'deleted')
          ?.querySelector('input')?.checked ?? null,
        panelBottom: panel.getBoundingClientRect().bottom,
        viewportHeight: innerHeight,
      };
    });
    assert.ok(menu.hasRaw && menu.hasDebug && menu.hasSettings && menu.hasAdd,
      `the menu must carry every toolbar action; got ${JSON.stringify(menu)}`);
    assert.equal(menu.dividerCount, 1, 'one divider between actions and filters');
    assert.ok(menu.embeddedPanelVisible, 'the filter checkboxes render open at the bottom');
    assert.ok(menu.filterRowCount >= 5, `expected master + categories + Hidden, got ${menu.filterRowCount}`);
    assert.equal(menu.hiddenChecked, false, 'the Hidden gate starts off');
    assert.ok(menu.panelBottom <= menu.viewportHeight + 1, 'the menu fits the phone viewport');

    // Toggling a filter from the menu writes app state.
    await mobile.click('.kikx-overflow__filters [data-filter-key="deleted"]');
    await mobile.waitForFunction(
      () => document.querySelector('kikx-app')._state.frameFilters?.deleted === true,
      { timeout: 5000 },
    );

    // Escape closes the menu.
    await mobile.keyboard.press('Escape');
    await mobile.waitForFunction(() => {
      let panel = document.querySelector('.kikx-overflow__panel');
      return panel && panel.hidden;
    }, { timeout: 5000 });
    await mobile.close();

    // ---- Desktop ---------------------------------------------------------
    let desktop = await browser.newPage();
    await desktop.setViewport({ width: 1280, height: 800 });
    await desktop.evaluateOnNewDocument(() => {
      sessionStorage.setItem('kikx.auth.session', JSON.stringify({ token: 'ovl-token', refresh_token: 'ovl-refresh' }));
    });
    await desktop.goto(`${fixture.baseURL}/?session=session_ovl`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await desktop.waitForSelector('.kikx-thread-scrollview', { timeout: 15000 });
    await new Promise((resolve) => setTimeout(resolve, 350));

    let d = await rectProbe(desktop);
    assertShared(d);
    assert.notEqual(d.connectionDisplay, 'none', 'desktop keeps the connection text');
    assert.notEqual(d.eyeDisplay, 'none', 'desktop keeps the eye');
    assert.notEqual(d.actionsDisplay, 'none', 'desktop keeps the actions cluster');
    assert.equal(d.overflowDisplay, 'none', 'no ⋮ on desktop');
    assert.equal(d.documentOverflowX, false, 'nothing overflows horizontally on desktop');
    await desktop.close();
  } finally {
    await browser.close();
    await fixture.close();
  }
});
