'use strict';

// Mobile navigation regression (owner change, 2026-11-04):
//
// The sidebar used to stack as a scrolling band ABOVE the session view below
// the stacking width -- a second, ugly top bar separate from the conversation.
// The replacement is the classic pattern: a hamburger in the bar's lead
// cluster opening the sidebar as a floating drawer over a dimming scrim.
//
// What this pins, on real emulated viewports:
//   phone   -> hamburger visible, drawer hidden until opened, scrim/Escape/
//              sidebar-click all close it, and the session view starts right
//              under the bar (no sidebar band above it);
//   desktop -> no hamburger, the sidebar is its normal column again.

import assert from 'node:assert/strict';
import test from 'node:test';

import puppeteer from 'puppeteer-core';

import { findChromeExecutable, startStagehandUIServer } from '../stagehand/stagehand-test-utils.mjs';

function probeMenu(page) {
  return page.evaluate(() => {
    let shell = document.querySelector('.kikx-shell');
    let toggle = document.querySelector('.kikx-menu-toggle');
    let scrim = document.querySelector('.kikx-sessions-scrim');
    let sessions = document.querySelector('#kikx-sidebar-menu');
    let sessionsBox = document.querySelector('#kikx-sidebar-menu > .tab-bar') || sessions;
    let topbar = document.querySelector('.kikx-topbar');
    let thread = document.querySelector('.kikx-thread') || document.querySelector('.kikx-workspace');
    let rect = (node) => {
      if (!node) return null;
      let value = node.getBoundingClientRect();
      return { x: value.x, y: value.y, width: value.width, height: value.height, right: value.right, bottom: value.bottom };
    };
    let style = (node) => node ? getComputedStyle(node) : null;
    return {
      open: Boolean(shell && shell.classList.contains('kikx-shell--menu-open')),
      toggle: {
        rect: rect(toggle),
        display: style(toggle)?.display || null,
        expanded: toggle?.getAttribute('aria-expanded') || null,
        hasIcon: Boolean(toggle?.querySelector('svg[data-icon="menu"]')),
        controls: toggle?.getAttribute('aria-controls') || null,
      },
      scrimDisplay: style(scrim)?.display || null,
      sidebar: {
        rect: rect(sessionsBox),
        visibility: style(sessions)?.visibility || null,
        position: style(sessions)?.position || null,
        hasID: sessions?.id || null,
      },
      topbarRect: rect(topbar),
      threadRect: rect(thread),
      documentOverflowX: document.documentElement.scrollWidth > innerWidth + 1,
      viewport: { width: innerWidth, height: innerHeight },
    };
  });
}

function frames(count) {
  return Array.from({ length: count }, (_value, index) => {
    let number = index + 1;
    let timestamp = 1781035260000000 + number * 1000000;
    return {
      id: `menu_frame_${number}`,
      type: number % 2 === 0 ? 'UserMessage' : 'AgentMessage',
      sessionID: 'session_menu',
      interactionID: `menu_interaction_${number}`,
      authorType: number % 2 === 0 ? 'user' : 'agent',
      authorID: number % 2 === 0 ? 'menu_user' : 'menu_agent',
      authorDisplayName: number % 2 === 0 ? 'Wyatt' : 'Menu Agent',
      hidden: false,
      deleted: false,
      order: number,
      timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
      content: { text: `Menu message ${number}` },
    };
  });
}

async function waitForClosed(page) {
  await page.waitForFunction(() => {
    let shell = document.querySelector('.kikx-shell');
    let sessions = document.querySelector('#kikx-sidebar-menu');
    return shell && !shell.classList.contains('kikx-shell--menu-open')
      && sessions && getComputedStyle(sessions).visibility === 'hidden';
  }, { timeout: 5000 });
}

async function waitForOpen(page) {
  await page.waitForFunction(() => {
    let shell = document.querySelector('.kikx-shell');
    let sessions = document.querySelector('#kikx-sidebar-menu');
    if (!shell || !sessions || !shell.classList.contains('kikx-shell--menu-open'))
      return false;
    if (getComputedStyle(sessions).visibility !== 'visible')
      return false;
    // Wait out the 220ms slide-in: visibility flips first, the transform
    // transition lands the drawer at the left edge a frame later.
    return sessions.getBoundingClientRect().x >= -1;
  }, { timeout: 5000 });
}

test('Puppeteer mobile view uses a hamburger + floating drawer for the sidebar', async (t) => {
  let chromePath = findChromeExecutable();
  if (!chromePath) {
    t.skip('Puppeteer mobile-menu coverage requires Chrome');
    return;
  }

  let fixture = await startStagehandUIServer({
    sessions: [ { id: 'session_menu', title: 'Menu Session', messageCount: 6 } ],
    agents: [ { id: 'menu_agent', name: 'Menu Agent', pluginID: 'test-agent', enabled: true } ],
  });
  fixture.frameRuntime.framesBySessionID.set('session_menu', frames(6));

  let browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: process.env.KIKX_PUPPETEER_HEADLESS === '0' ? false : 'new',
    args: [ '--no-sandbox', '--disable-setuid-sandbox' ],
  });

  try {
    // ---- Phone portrait: the drawer experience --------------------------
    let page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
    await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1');
    await page.evaluateOnNewDocument(() => {
      sessionStorage.setItem('kikx.auth.session', JSON.stringify({ token: 'menu-test-token', refresh_token: 'menu-test-refresh' }));
    });
    await page.goto(`${fixture.baseURL}/?session=session_menu`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForSelector('.kikx-thread-scrollview', { timeout: 15000 });
    await new Promise((resolve) => setTimeout(resolve, 350));

    let closed = await probeMenu(page);
    assert.ok(closed.toggle.rect && closed.toggle.rect.width > 0, 'the hamburger must be visible on the phone');
    assert.ok(closed.toggle.hasIcon, 'the hamburger carries the menu icon');
    assert.equal(closed.toggle.expanded, 'false', 'aria-expanded starts false');
    assert.equal(closed.toggle.controls, 'kikx-sidebar-menu', 'aria-controls targets the drawer');
    assert.equal(closed.sidebar.visibility, 'hidden', 'the drawer starts hidden, not as a top band');
    assert.equal(closed.sidebar.hasID, 'kikx-sidebar-menu', 'the drawer is the aria-controls target');
    assert.equal(closed.scrimDisplay, 'none', 'no backdrop while closed');
    assert.equal(closed.documentOverflowX, false, 'the parked drawer must not overflow the document');
    // The old layout's defect: a sidebar band between bar and conversation.
    assert.ok(closed.threadRect.y <= closed.topbarRect.bottom + 2,
      `the session view must start right under the bar (thread.y=${closed.threadRect.y}, bar.bottom=${closed.topbarRect.bottom})`);

    // Open via the hamburger.
    await page.click('.kikx-menu-toggle');
    await waitForOpen(page);
    let opened = await probeMenu(page);
    assert.equal(opened.toggle.expanded, 'true', 'aria-expanded follows the open state');
    assert.equal(opened.sidebar.position, 'absolute', 'the open sidebar is an overlay drawer');
    assert.ok(opened.sidebar.rect.x >= -1, `the drawer slides in from the left edge (x=${opened.sidebar.rect.x})`);
    assert.ok(opened.sidebar.rect.width > 150 && opened.sidebar.rect.right <= opened.viewport.width + 1,
      `the drawer fits the viewport (width=${opened.sidebar.rect.width}, right=${opened.sidebar.rect.right})`);
    assert.equal(opened.scrimDisplay, 'block', 'the scrim paints while open');

    // Close via the scrim (tap outside).
    await page.click('.kikx-sessions-scrim');
    await waitForClosed(page);
    assert.equal((await probeMenu(page)).toggle.expanded, 'false');

    // Close via Escape.
    await page.click('.kikx-menu-toggle');
    await waitForOpen(page);
    await page.keyboard.press('Escape');
    await waitForClosed(page);

    // Clicking a sidebar row both navigates and closes the drawer.
    await page.click('.kikx-menu-toggle');
    await waitForOpen(page);
    await page.evaluate(() => {
      let agents = [ ...document.querySelectorAll('.kikx-view-container .tab') ]
        .find((button) => button.textContent.trim() === 'Agents');
      agents?.click();
    });
    await page.waitForSelector('.kikx-agent-manager', { timeout: 10000 });
    await waitForClosed(page);
    await page.close();

    // ---- Desktop: no hamburger, sidebar is a column again ---------------
    let desktop = await browser.newPage();
    await desktop.setViewport({ width: 1280, height: 800 });
    await desktop.evaluateOnNewDocument(() => {
      sessionStorage.setItem('kikx.auth.session', JSON.stringify({ token: 'menu-test-token', refresh_token: 'menu-test-refresh' }));
    });
    await desktop.goto(`${fixture.baseURL}/?session=session_menu`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await desktop.waitForSelector('.kikx-thread-scrollview', { timeout: 15000 });
    await new Promise((resolve) => setTimeout(resolve, 350));

    let wide = await probeMenu(desktop);
    assert.equal(wide.toggle.display, 'none', 'no hamburger on the desktop layout');
    assert.equal(wide.sidebar.position, 'static', 'the desktop sidebar is a grid column, not a drawer');
    assert.equal(wide.sidebar.visibility, 'visible');
    assert.equal(wide.scrimDisplay, 'none');
    assert.equal(wide.open, false);
    await desktop.close();
  } finally {
    await browser.close();
    await fixture.close();
  }
});
