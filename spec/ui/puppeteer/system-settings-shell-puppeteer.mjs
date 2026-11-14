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
    // Owner screenshot 1 (2026-11-13): subtitle + Back + tabbed-view removed.
    const chromeProbe = await page.evaluate(() => ({
      header: Boolean(document.querySelector('.kikx-system-settings .kikx-view-header')),
      tabs: Boolean(document.querySelector('.kikx-system-settings aeor-tab-view')),
      body: Boolean(document.querySelector('.kikx-system-settings__body')),
    }));
    assert.deepEqual(chromeProbe, { header: false, tabs: false, body: true },
      'the view renders ONLY its body — no subtitle/Back header, no tabbed view');

    for (const selector of SHELL_SELECTORS)
      await identityStays(selector, 'after entering System Settings');

    // Owner screenshot 1: the view Back control is GONE — leaving the mode is
    // the stack pop itself (browser history after the push).
    await page.goBack();
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

    // ---- Owner (2026-11-12) #1/#2: the section switch must PUBLISH crumb +
    // URL with NO help from inventory renders. First let the inventory settle
    // on its own while still on General, then a SINGLE sidebar row click must
    // do it (the tab row is gone — owner screenshot 1). ----
    let settled = false;
    for (let attempt = 0; attempt < 30 && !settled; attempt += 1) {
      settled = await page.evaluate(() => !(document.body.innerText || '').includes('Loading plugins'));
      if (!settled)
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.equal(settled, true, 'the inventory settles unaided on entry (owner bug 4)');

    const clicked = await page.evaluate(() => {
      const row = [...document.querySelectorAll('.kikx-session-objects button')]
        .find((el) => (el.textContent || '').trim() === 'Plugins');
      if (!row) return false;
      row.click();
      return true;
    });
    assert.equal(clicked, true, 'the sidebar offers a Plugins section row');
    await page.waitForSelector('.kikx-settings-plugins', { timeout: 10000 });
    await new Promise((resolve) => setTimeout(resolve, 400)); // let the queued rAF render land

    const afterTab = await page.evaluate(() => location.search);
    assert.ok(afterTab.includes('section=Plugins'),
      `the section switch writes section= to the URL (got "${afterTab}")`);
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

    // Owner screenshot 1: the SIDEBAR carries the settings navigation now.
    const sidebarLabels = await page.$$eval('.kikx-session-objects button',
      (nodes) => nodes.map((node) => node.textContent.trim()));
    for (const name of [ 'General', 'Email', 'Plugins' ])
      assert.ok(sidebarLabels.includes(name),
        `settings nav row '${name}' in the sidebar (got ${JSON.stringify(sidebarLabels)})`);
    assert.equal(sidebarLabels.includes('Agents'), false,
      'the session view rows are replaced by settings navigation');

    const sectionText = await page.$eval('.kikx-settings-plugins', (node) => node.textContent);
    assert.ok(sectionText.includes('Installed Plugins'), 'the section reached its terminal content');

    // ---- Owner screenshot 1: subtitle/Back/tabbed-view are gone. ----------
    const chromeProbe2 = await page.evaluate(() => ({
      header: Boolean(document.querySelector('.kikx-system-settings .kikx-view-header')),
      tabs: Boolean(document.querySelector('.kikx-system-settings aeor-tab-view')),
    }));
    assert.deepEqual(chromeProbe2, { header: false, tabs: false },
      'no view header (subtitle+Back) and no tabbed view — owner removal, pinned');

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

    // ---- Owner (2026-11-12, second report): back after a reload must
    // HYDRATE the session — the old accept-empty-state version of this wait
    // MASKED the bug (boot skips frame load when the mode tops the stack and
    // minimizeCurrent never loaded either). Fixture has frames: they must
    // render, full stop.
    // The view Back control is gone (owner screenshot 1): leaving the mode is
    // the stack pop itself — browser history after the push.
    await page.goBack();
    let left = false;
    for (let attempt = 0; attempt < 40 && !left; attempt += 1) {
      left = await page.evaluate(() => !document.querySelector('.kikx-system-settings'));
      if (!left)
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.equal(left, true, 'Back leaves the mode');
    // Frames for the fixture session must actually appear — the regression
    // was "No messages yet" on a session that HAS frames.
    await page.waitForSelector('.kikx-thread-scrollview', { timeout: 15000 });
    const surface = await page.evaluate(() => ({
      thread: Boolean(document.querySelector('.kikx-thread-scrollview')),
      empty: (document.body.innerText || '').includes('No messages yet'),
      frames: document.querySelectorAll('kikx-frame-item').length,
    }));
    assert.equal(surface.empty, false,
      `the session hydrates after Back — no phantom empty state (got ${JSON.stringify(surface)})`);
    assert.ok(surface.frames > 0, `frame items render (got ${JSON.stringify(surface)})`);
    const leftSearch = await page.evaluate(() => location.search);
    assert.ok(!leftSearch.includes('view=settings') && !leftSearch.includes('section='),
      `Back drops the mode params from the URL (got "${leftSearch}")`);

    assert.deepEqual(pageErrors, [], 'no page errors across gear/reload/plugins flow');
  } finally {
    await browser.close();
    fixture.close();
  }
});

test('Settings → Email: the reference form renders via the sidebar sections (owner 2026-11-13)', async (t) => {
  let chromePath = findChromeExecutable();
  if (!chromePath) {
    t.skip('Email settings coverage requires Chrome');
    return;
  }

  const fixture = await startStagehandUIServer({
    sessions: [ { id: 'session_identity', title: 'Identity Session', messageCount: 5 } ],
    agents: [ { id: 'agent_1', name: 'Identity Agent', pluginID: 'test-agent', enabled: true } ],
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
    await page.waitForSelector('.kikx-system-settings__body', { timeout: 10000 });

    const labels = await page.$$eval('.kikx-session-objects button',
      (rows) => rows.map((row) => row.textContent.trim()));
    assert.deepEqual(labels.slice(0, 3), [ 'General', 'Email', 'Plugins' ],
      'the sidebar carries the three sections in Xenocept order (tabs are gone)');

    // click the Email SECTION (sidebar row — owner screenshot 1)
    const clicked = await page.evaluate(() => {
      const row = [...document.querySelectorAll('.kikx-session-objects button')]
        .find((el) => (el.textContent || '').trim() === 'Email');
      if (!row) return false;
      row.click();
      return true;
    });
    assert.equal(clicked, true, 'the sidebar Email row exists');
    await page.waitForSelector('.kikx-settings-email', { timeout: 10000 });

    const form = await page.evaluate(() => ({
      heading: document.querySelector('.kikx-settings-email h3')?.textContent || '',
      names: [...document.querySelectorAll('.kikx-settings-email [name]')].map((n) => n.getAttribute('name')),
      selects: [...document.querySelectorAll('.kikx-settings-email aeor-select')].map((n) => n.getAttribute('name')),
      actions: [...document.querySelectorAll('.kikx-settings-email [data-action]')].map((n) => n.getAttribute('data-action')),
      desc: document.querySelector('.kikx-settings-email__desc')?.textContent || '',
    }));

    assert.match(form.heading, /Email Configuration/, 'the reference heading');
    assert.match(form.desc, /magic/i, 'the description mentions magic links');
    for (const field of [ 'host', 'port', 'username', 'password', 'fromAddress', 'fromName' ])
      assert.ok(form.names.includes(field), `field ${field} renders (fixture has no GET route — fields must still show)`);
    assert.ok(form.selects.includes('provider') && form.selects.includes('tls'), 'both selects render');
    assert.ok(form.actions.includes('save-email') && form.actions.includes('test-email'), 'Save + Send Test Email exist');

    assert.deepEqual(pageErrors, [], 'no page errors across the Email form flow');
  } finally {
    await browser.close();
    fixture.close();
  }
});

test('primary theme: swatch applies instantly, themes framework accents, survives reload (owner 2026-11-11)', async (t) => {
  let chromePath = findChromeExecutable();
  if (!chromePath) {
    t.skip('Theme coverage requires Chrome');
    return;
  }

  const fixture = await startStagehandUIServer({
    sessions: [ { id: 'session_identity', title: 'Identity Session', messageCount: 5 } ],
    agents: [ { id: 'agent_1', name: 'Identity Agent', pluginID: 'test-agent', enabled: true } ],
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
      // Plan P4 hard cut: kikx.theme is DEAD — the choice lives in the
      // account property server-side. Nothing to seed or protect in
      // localStorage; puppeteer's fresh profile starts clean anyway.
    });

    await page.goto(`http://127.0.0.1:${port}/?view=settings`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForSelector('.kikx-theme-picker__swatches', { timeout: 10000 });
    // The inventory completion repaints the section (repaint hook) — that
    // rebuild detaches puppeteer's pre-click handle, so settle first and
    // click IN-PAGE (query + click synchronously, no handle window).
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const busy = await page.evaluate(() => (document.body.innerText || '').includes('Loading plugins'));
      if (!busy) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    const before = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--kikx-accent').trim());

    // click the Purple swatch
    const clicked = await page.evaluate(() => {
      const swatch = document.querySelector('.kikx-theme-picker__swatch--purple');
      if (!swatch) return false;
      swatch.click();
      return true;
    });
    assert.equal(clicked, true, 'the purple swatch exists and was clicked in-page');
    await new Promise((resolve) => setTimeout(resolve, 200));

    const after = await page.evaluate(() => ({
      accent: getComputedStyle(document.documentElement).getPropertyValue('--kikx-accent').trim(),
      storedLocal: localStorage.getItem('kikx.theme'),
      pressed: document.querySelector('.kikx-theme-picker__swatch--purple')?.getAttribute('aria-pressed'),
      bluePressed: document.querySelector('.kikx-theme-picker__swatch--blue')?.getAttribute('aria-pressed'),
      // The vendor chain is asserted on the --accent ALIAS now: tab-view is
      // gone from Settings (owner screenshot 1), and --accent is exactly what
      // every remaining vendor consumer reads.
      alias: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
    }));

    assert.notEqual(after.accent, before, 'the accent variable CHANGED on click — instant, no reload');
    assert.equal(after.accent.toLowerCase(), '#9a55d6', 'purple hex is what the stylesheet receives');
    assert.equal(after.storedLocal, null, 'localStorage stays dead — nothing browser-local (hard cut)');
    assert.equal(after.pressed, 'true', 'the clicked swatch reads pressed');
    assert.equal(after.bluePressed, 'false', 'the previous selection released');
    assert.equal(after.alias.toLowerCase(), '#9a55d6',
      `the --accent alias (the vendor consumer chain) follows the choice (got ${after.alias})`);

    // Hard-cut proof: the choice reached the SERVER — query the account
    // property directly with the page's bearer token.
    const persisted = await page.evaluate(async () => {
      const res = await fetch(`/api/v1/properties?key=${encodeURIComponent('/core/user/theme/primary_color')}`,
        { headers: { Authorization: 'Bearer identity-token' } });
      const body = await res.json().catch(() => null);
      return { status: res.status, value: body?.data?.value ?? null, hasValue: body?.data?.hasValue ?? null };
    });
    assert.equal(persisted.status, 200, `account property readable over HTTP (got ${persisted.status})`);
    assert.equal(persisted.value, 'purple', 'the PUT persisted to the account scope');
    assert.equal(persisted.hasValue, true);

    // persistence: a real reload keeps the choice
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForSelector('.kikx-theme-picker__swatches', { timeout: 10000 });
    const reloaded = await page.evaluate(() => ({
      accent: getComputedStyle(document.documentElement).getPropertyValue('--kikx-accent').trim(),
      pressed: document.querySelector('.kikx-theme-picker__swatch--purple')?.getAttribute('aria-pressed'),
    }));
    assert.equal(reloaded.accent.toLowerCase(), '#9a55d6', 'the choice survives a reload — from the ACCOUNT fetch');
    assert.equal(reloaded.pressed, 'true', 'and the picker renders it selected');

    assert.deepEqual(pageErrors, [], 'no page errors across the theme flow');
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
