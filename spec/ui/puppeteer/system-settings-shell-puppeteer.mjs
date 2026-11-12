'use strict';

// =============================================================================
// System Settings mode switch proves DOM IDENTITY, not pixels (plan §9.3.13)
// =============================================================================
// The annotated ask is "exact same layout, reutilize the sidebar". Under the
// property-store doctrine that claim is a node-identity claim: entering
// System Settings (and leaving it) must replace the WORK AREA only — the shell
// root and the sidebar must be the SAME DOM nodes afterwards. A test that
// compared screenshots would pass over a sidebar that was torn down and
// rebuilt, losing focus, scroll and bound listeners with it — exactly the
// defect class the targeted-update campaign exists to prevent.
//
// Also pinned here (§9.3.10): `?view=settings` is addressable for free off the
// live registry and must boot on a SESSIONLESS entry — no frames to hash, so
// `maybeRestoreMessageHash` stays inert (no `#message=` appears, no page
// errors).

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

const SHELL_SELECTORS = [
  '.kikx-main',
  '#kikx-sidebar-menu',
  '#kikx-sidebar-menu .kikx-sessions__header',
];

test('System Settings mode switch keeps shell root + sidebar node identity (§9.3.13)', async (t) => {
  let chromePath = findChromeExecutable();
  if (!chromePath) {
    t.skip('System Settings identity coverage requires Chrome');
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
      sessionStorage.setItem('kikx.auth.session', JSON.stringify({ token: 'identity-token', refresh_token: 'identity-refresh' }));
    });
    await page.goto(`http://127.0.0.1:${port}/?session=session_identity`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForSelector('.kikx-thread-scrollview', { timeout: 15000 });
    await new Promise((resolve) => setTimeout(resolve, 400));

    // Capture the nodes as JSHandles BEFORE the transition. A replaced node
    // stays comparable through its handle (detached is fine — `===` on a
    // detached node against a fresh query is exactly the signal we want).
    const captured = {};
    for (const selector of SHELL_SELECTORS) {
      captured[selector] = await page.evaluateHandle((sel) => document.querySelector(sel), selector);
      const present = await captured[selector].evaluate((node) => Boolean(node));
      assert.ok(present, `precondition: ${selector} must exist before the mode switch`);
    }

    const identityStays = async (selector, phase) => {
      const same = await captured[selector].evaluate(
        (node, sel) => node === document.querySelector(sel),
        selector,
      );
      assert.equal(same, true, `${phase}: ${selector} must be the SAME node (identity, not appearance)`);
    };

    // ---- enter System Settings via the upper-left brand mark (owner ruling:
    // the cluster gear is gone; the brand mark is the only entry) ----------
    await page.click('.kikx-brand__mark');
    await page.waitForSelector('.kikx-system-settings', { timeout: 10000 });
    const heading = await page.$eval('.kikx-system-settings h2', (node) => node.textContent);
    assert.equal(heading.trim(), 'System Settings', 'the mode renders its heading');

    for (const selector of SHELL_SELECTORS)
      await identityStays(selector, 'after entering System Settings');

    // The sidebar still offers navigation while the mode is open: leave via
    // the view's Back control (same as the stack popping).
    await page.evaluate(() => {
      // The Back control is icon-only: its label lives in title/aria-label
      // ("Back to Projects and Sessions"), so a textContent search never
      // finds it — target the stable class the view chrome assigns.
      const back = document.querySelector('.kikx-view__back');
      if (back) back.click();
    });
    await page.waitForSelector('.kikx-thread-scrollview', { timeout: 10000 });

    for (const selector of SHELL_SELECTORS)
      await identityStays(selector, 'after leaving System Settings');

    assert.deepEqual(pageErrors, [], 'the mode switch must not surface page errors');
  } finally {
    await browser.close();
    fixture.close();
  }
});

test('gear writes ?view=settings, reload restores the mode, and Plugins loading clears unaided (owner bugs 2+4)', async (t) => {
  let chromePath = findChromeExecutable();
  if (!chromePath) {
    t.skip('System Settings URL/reload coverage requires Chrome');
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
      sessionStorage.setItem('kikx.auth.session', JSON.stringify({ token: 'identity-token', refresh_token: 'identity-refresh' }));
    });

    // ---- BUG 2 (probe-confirmed): entering settings from a session never
    // wrote view= to the address bar, so a reload dropped the mode. ----------
    await page.goto(`http://127.0.0.1:${port}/?session=session_identity`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForSelector('.kikx-thread-scrollview', { timeout: 15000 });
    await new Promise((resolve) => setTimeout(resolve, 300));

    await page.click('.kikx-brand__mark');
    await page.waitForSelector('.kikx-system-settings', { timeout: 10000 });
    const encoded = await page.evaluate(() => location.search);
    assert.ok(encoded.includes('view=settings'), `the gear must encode the mode (got "${encoded}")`);
    assert.ok(encoded.includes('session=session_identity'), 'the session context stays in the URL');

    // A REAL reload must come back to the mode, not a Session.
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForSelector('.kikx-system-settings', { timeout: 10000 });
    const restored = await page.evaluate(() => location.search);
    assert.ok(restored.includes('view=settings'), 'the mode survives a real reload');
    assert.ok(restored.includes('session=session_identity'), 'and the session context with it');

    // ---- Owner (2026-11-12) #1/#2: the tab switch must PUBLISH crumb + URL
    // with NO help from inventory renders. First let the inventory settle on
    // its own while still on General, then a SINGLE tab click must do it. ----
    let settled = false;
    for (let attempt = 0; attempt < 30 && !settled; attempt += 1) {
      settled = await page.evaluate(() => !(document.body.innerText || '').includes('Loading plugins'));
      if (!settled)
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.equal(settled, true, 'the inventory settles unaided on entry (owner bug 4)');

    const clicked = await page.evaluate(() => {
      const tab = [...document.querySelectorAll('aeor-tab, [role=tab]')]
        .find((el) => (el.getAttribute('label') || el.textContent || '').includes('Plugins'));
      if (!tab) return false;
      tab.click();
      return true;
    });
    assert.equal(clicked, true, 'the Plugins tab exists');
    await page.waitForSelector('.kikx-settings-plugins', { timeout: 10000 });
    await new Promise((resolve) => setTimeout(resolve, 400)); // let the queued rAF render land

    const afterTab = await page.evaluate(() => location.search);
    assert.ok(afterTab.includes('section=Plugins'),
      `the tab switch writes section= to the URL (got "${afterTab}")`);
    const crumbsAfterTab = await page.$$eval('.kikx-breadcrumb__crumb, .kikx-window__title',
      (nodes) => nodes.map((node) => node.textContent.trim()));
    assert.ok(crumbsAfterTab.includes('Settings'), `crumb shows the mode (got ${JSON.stringify(crumbsAfterTab)})`);
    assert.ok(crumbsAfterTab.includes('Plugins'),
      'the breadcrumb FOLLOWS the tab — owner saw it frozen on General');

    // ---- Owner #1 (second half): reload reopens THE TAB IN VIEW, unaided. ---
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForSelector('.kikx-system-settings', { timeout: 10000 });
    await page.waitForSelector('.kikx-settings-plugins', { timeout: 10000 });
    const restoredSearch = await page.evaluate(() => location.search);
    assert.ok(restoredSearch.includes('view=settings') && restoredSearch.includes('section=Plugins'),
      `the URL survives the reload complete (got "${restoredSearch}")`);
    const crumbsRestored = await page.$$eval('.kikx-breadcrumb__crumb, .kikx-window__title',
      (nodes) => nodes.map((node) => node.textContent.trim()));
    assert.ok(crumbsRestored.includes('Plugins'),
      'the restored tab shows WITHOUT any click — breadcrumb matches it');

    const sectionText = await page.$eval('.kikx-settings-plugins', (node) => node.textContent);
    assert.ok(sectionText.includes('Installed Plugins'), 'the section reached its terminal content');

    // ---- Owner screenshot 1: Back rides the view header, not a lone row. ---
    const backInHeader = await page.evaluate(
      () => Boolean(document.querySelector('.kikx-view-header .kikx-view__back')),
    );
    assert.equal(backInHeader, true,
      'the Back control lives INSIDE the view header (was "hanging out in the middle of nowhere")');

    // ---- Owner screenshot 2: breadcrumb reads Settings › live section. -----
    const crumbs = await page.$$eval('.kikx-breadcrumb__crumb, .kikx-window__title',
      (nodes) => nodes.map((node) => node.textContent.trim()));
    assert.ok(crumbs.includes('Settings'), `breadcrumb shows the mode (got ${JSON.stringify(crumbs)})`);
    assert.ok(crumbs.includes('Plugins'), 'and the live section as the active crumb');

    // ---- Owner item 1: the view scrolls itself (.kikx-main is overflow:
    // hidden). A tall spacer proves the container, not just the CSS text. ---
    const scroll = await page.evaluate(() => {
      const el = document.querySelector('.kikx-system-settings');
      if (!el) return { ok: false, reason: 'missing' };
      const spacer = document.createElement('div');
      spacer.style.height = '2400px';
      el.appendChild(spacer);
      const overflowed = el.scrollHeight > el.clientHeight;
      el.scrollTop = el.scrollHeight;
      const stuck = el.scrollTop > 0;
      spacer.remove();
      return { ok: overflowed && stuck, overflowed, stuck, overflowY: getComputedStyle(el).overflowY };
    });
    assert.equal(scroll.ok, true,
      `the settings/plugins area scrolls (got ${JSON.stringify(scroll)})`);

    // ---- Owner #1 (last half): leaving the mode cleans the URL. -----------
    await page.evaluate(() => document.querySelector('.kikx-view__back')?.click());
    // Contract, not one selector: the mode must be GONE and a session surface
    // back — the real dev session showed the empty-state (no thread-scrollview
    // node at all), so poll for "settings absent" then accept either surface.
    let left = false;
    for (let attempt = 0; attempt < 40 && !left; attempt += 1) {
      left = await page.evaluate(() => !document.querySelector('.kikx-system-settings'));
      if (!left)
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.equal(left, true, 'Back leaves the mode');
    const surface = await page.evaluate(() => ({
      thread: Boolean(document.querySelector('.kikx-thread-scrollview')),
      grid: Boolean(document.querySelector('kikx-session-grid')),
      empty: (document.body.innerText || '').includes('No messages yet'),
    }));
    assert.equal(surface.thread || surface.grid || surface.empty, true,
      `a session surface is back (got ${JSON.stringify(surface)})`);
    const leftSearch = await page.evaluate(() => location.search);
    assert.ok(!leftSearch.includes('view=settings') && !leftSearch.includes('section='),
      `Back drops the mode params from the URL (got "${leftSearch}")`);

    assert.deepEqual(pageErrors, [], 'no page errors across gear/reload/plugins flow');
  } finally {
    await browser.close();
    fixture.close();
  }
});

test('?view=settings deep-links into the mode on a sessionless entry (§9.3.10)', async (t) => {
  let chromePath = findChromeExecutable();
  if (!chromePath) {
    t.skip('System Settings deep-link coverage requires Chrome');
    return;
  }

  const fixture = await startStagehandUIServer({
    sessions: [ { id: 'session_identity', title: 'Identity Session', messageCount: 20 } ],
    agents: [],
  });
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
      sessionStorage.setItem('kikx.auth.session', JSON.stringify({ token: 'identity-token', refresh_token: 'identity-refresh' }));
    });
    await page.goto(`http://127.0.0.1:${port}/?view=settings`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForSelector('.kikx-system-settings', { timeout: 15000 });

    // Sessionless means no frames exist to hash: the message-hash restore must
    // stay inert rather than guessing at an id.
    const state = await page.evaluate(() => ({
      hash: location.hash,
      sidebarThere: Boolean(document.querySelector('#kikx-sidebar-menu')),
      workspaceThere: Boolean(document.querySelector('#kikx-sidebar-menu .kikx-sessions__header')),
    }));
    assert.doesNotMatch(state.hash, /message=/,
      'a sessionless settings entry must not synthesise a message hash');
    assert.ok(state.sidebarThere && state.workspaceThere,
      'the mode reuses the sidebar exactly as annotated');
    assert.deepEqual(pageErrors, [], 'the deep link must boot without page errors');
  } finally {
    await browser.close();
    fixture.close();
  }
});
