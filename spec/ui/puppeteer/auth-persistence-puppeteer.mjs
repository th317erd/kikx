'use strict';

// Browser proof for token durability (owner, 2026-11-05): closing the browser
// must not sign you out — tokens live in localStorage and expire server-side
// (30-day refresh window), not with the browser session.
//
// Puppeteer's localStorage is per-browser-profile and sessionStorage is per
// tab, so "close the browser and come back" is exactly: a page (or a second
// page) with an empty sessionStorage but the profile's localStorage intact.
// Three legs:
//   1. localStorage-only boot -> authenticated shell (no login screen);
//   2. a brand-new page in the same profile with NO sessionStorage seeding ->
//      still authenticated (the cold-start case the owner is hitting);
//   3. an incognito context with empty storage -> login screen (the change
//      makes tokens durable, not universal).

import assert from 'node:assert/strict';
import test from 'node:test';

import puppeteer from 'puppeteer-core';

import { findChromeExecutable, startStagehandUIServer } from '../stagehand/stagehand-test-utils.mjs';

function frames(count) {
  return Array.from({ length: count }, (_value, index) => {
    const number = index + 1;
    const timestamp = 1793328600000000 + number * 1000000;
    return {
      id: `persist_${number}`,
      type: 'AgentMessage',
      sessionID: 'session_persist',
      interactionID: `persist_i_${number}`,
      authorType: 'agent',
      authorID: 'agent_1',
      authorDisplayName: 'Persist Agent',
      hidden: false,
      deleted: false,
      order: number,
      timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
      content: { text: `Frame ${number}` },
    };
  });
}

const DURABLE_AUTH = () => JSON.stringify({
  token: 'durable-access',
  refresh_token: 'durable-refresh',
  expires_at: Date.now() + 30 * 24 * 60 * 60 * 1000,
  user: { id: 'usr_1', name: 'Wyatt' },
});

async function isAuthenticated(page) {
  // Wait for the SHELL, not the state flag: authToken is set during state
  // init, before the first render paints the composer.
  await page.waitForFunction(() =>
    document.querySelector('textarea[name="message"]') || document.querySelector('.kikx-auth-panel'),
  { timeout: 20000 }).catch(() => {});
  return page.evaluate(() => ({
    token: document.querySelector('kikx-app')?._state?.authToken || null,
    loginScreen: Boolean(document.querySelector('.kikx-auth-panel')),
    composer: Boolean(document.querySelector('textarea[name="message"]')),
    startup: Boolean(document.querySelector('.kikx-startup-loading')),
    deepLinkReady: document.querySelector('kikx-app')?._deepLinkReady ?? null,
    loadError: document.querySelector('kikx-app')?._state?.frameLoadErrorsBySessionID
      ? Object.keys(document.querySelector('kikx-app')._state.frameLoadErrorsBySessionID)
      : null,
    status: document.querySelector('kikx-app')?._state?.status || null,
  }));
}

test('Puppeteer: tokens survive a browser restart (localStorage, not the browser session)', async (t) => {
  let chromePath = findChromeExecutable();
  if (!chromePath) {
    t.skip('Puppeteer auth-persistence coverage requires Chrome');
    return;
  }

  const fixture = await startStagehandUIServer({
    sessions: [ { id: 'session_persist', title: 'Persist Session', messageCount: 4 } ],
  });
  fixture.frameRuntime.framesBySessionID.set('session_persist', frames(4));

  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: process.env.KIKX_PUPPETEER_HEADLESS === '0' ? false : 'new',
    args: [ '--no-sandbox', '--disable-setuid-sandbox' ],
  });

  try {
    // 1. Durable slot only — nothing in sessionStorage at all.
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.evaluateOnNewDocument(() => {
      localStorage.setItem('kikx.auth.session', JSON.stringify({
        token: 'durable-access',
        refresh_token: 'durable-refresh',
        expires_at: Date.now() + 30 * 24 * 60 * 60 * 1000,
        user: { id: 'usr_1', name: 'Wyatt' },
      }));
    });
    await page.goto(`${fixture.baseURL}/?session=session_persist`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    const first = await isAuthenticated(page);
    assert.equal(first.loginScreen, false, 'a durable token must skip the login screen');
    assert.equal(first.token, 'durable-access');
    assert.ok(first.composer,
      `the authenticated shell (composer) is up: ${JSON.stringify(first)}`);
    await page.close();

    // 2. "Close the browser, come back": a second page, same profile (same
    //    localStorage), zero sessionStorage seeding of any kind.
    const cold = await browser.newPage();
    await cold.setViewport({ width: 1280, height: 800 });
    await cold.goto(`${fixture.baseURL}/?session=session_persist`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    const second = await isAuthenticated(cold);
    assert.equal(second.loginScreen, false, 'a cold start with only localStorage must stay signed in');
    assert.equal(second.token, 'durable-access');
    const storageProbe = await cold.evaluate(() => ({
      session: sessionStorage.getItem('kikx.auth.session'),
      durable: Boolean(localStorage.getItem('kikx.auth.session')),
    }));
    assert.equal(storageProbe.session, null, 'the cold start really had no browser-session token');
    assert.equal(storageProbe.durable, true, 'the durable token is what authenticated it');
    await cold.close();

    // 3. Incognito context: empty profile -> login screen (durable ≠ universal).
    const context = await browser.createBrowserContext();
    const fresh = await context.newPage();
    await fresh.setViewport({ width: 1280, height: 800 });
    await fresh.goto(`${fixture.baseURL}/?session=session_persist`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    const third = await isAuthenticated(fresh);
    assert.equal(third.loginScreen, true, 'with no stored token anywhere, the login screen still appears');
    assert.equal(third.token, null);
    await context.close();
  } finally {
    await browser.close();
    await fixture.close();
  }
});
