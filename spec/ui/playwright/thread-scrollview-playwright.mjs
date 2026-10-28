'use strict';

// Real-browser integration for Kikx's <aeor-scrollview> adapter. The unit
// chat-view tests exercise the DOM fallback (mini-dom has no layout), so this
// lane is what proves the shared page/gap scroll owner is actually mounted and
// that live frame appends still land at the tail.

import assert from 'node:assert/strict';
import test from 'node:test';

import { chromium } from 'playwright';

import { findChromeExecutable, startStagehandUIServer } from '../stagehand/stagehand-test-utils.mjs';

function frames(count) {
  return Array.from({ length: count }, (_value, index) => {
    let number = index + 1;
    let timestamp = 1781035260000000 + number * 1000000;
    return {
      id: `frame_${number}`,
      type: number % 2 === 0 ? 'AgentMessage' : 'UserMessage',
      sessionID: 'session_scrollview',
      interactionID: `interaction_${number}`,
      authorType: number % 2 === 0 ? 'agent' : 'user',
      authorID: number % 2 === 0 ? 'agent_scrollview' : 'stagehand-user',
      authorDisplayName: number % 2 === 0 ? 'Scroll Agent' : 'User',
      hidden: false,
      deleted: false,
      order: number,
      createdAt: timestamp,
      updatedAt: timestamp,
      content: {
        text: `Frame ${number}: this message makes the thread tall enough for page gaps and tail following.`,
      },
    };
  });
}

async function metrics(page) {
  return await page.evaluate(() => {
    let list = document.querySelector('.kikx-frame-list');
    let items = [ ...document.querySelectorAll('kikx-frame-item[data-frame-id]') ];
    return {
      scrollview: Boolean(document.querySelector('aeor-scrollview')),
      pages: document.querySelectorAll('.aeor-scrollview__page').length,
      totalPages: document.querySelector('aeor-scrollview')?.metrics?.().totalPages || 0,
      gaps: document.querySelectorAll('.aeor-scrollview__gap').length,
      items: items.length,
      first: items[0]?.dataset.frameId || '',
      last: items.at(-1)?.dataset.frameId || '',
      scrollTop: list?.scrollTop || 0,
      scrollHeight: list?.scrollHeight || 0,
      clientHeight: list?.clientHeight || 0,
      distanceFromBottom: (list?.scrollHeight || 0) - (list?.scrollTop || 0) - (list?.clientHeight || 0),
    };
  });
}

async function waitFor(page, predicate, timeoutMS = 10000) {
  let startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMS) {
    let value = await metrics(page);
    if (predicate(value))
      return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  let debug = await page.evaluate(() => ({
    sentinel: Boolean(document.querySelector('.kikx-frame-load-sentinel')),
    paging: document.querySelector('kikx-app')?._state?.sessionPagingByID,
  }));
  throw new Error(`timed out; last metrics ${JSON.stringify(await metrics(page))}; debug ${JSON.stringify(debug)}`);
}

test('the thread mounts the shared scrollview and follows live tail appends', async () => {
  let chromePath = findChromeExecutable();
  if (!chromePath) {
    test.skip('Chrome is required');
    return;
  }

  let fixture = await startStagehandUIServer({
    sessions: [{ id: 'session_scrollview', title: 'Scrollview Thread', messageCount: 300 }],
    agents: [{ id: 'agent_scrollview', name: 'Scroll Agent', pluginID: 'test-agent', enabled: true }],
  });
  fixture.frameRuntime.framesBySessionID.set('session_scrollview', frames(300));
  let browser;

  try {
    browser = await chromium.launch({ executablePath: chromePath, headless: true, args: ['--no-sandbox'] });
    let page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.addInitScript(() => localStorage.setItem('kikx.scrollLock.session_scrollview', '0'));
    let pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(String(error)));

    await page.goto(`${fixture.baseURL}/?code=scrollview-test&view=thread`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    let initial;
    try {
      initial = await waitFor(page, (value) => value.scrollview && value.items > 0 && value.distanceFromBottom <= 5);
    } catch (error) {
      let debug = await page.evaluate(() => {
        let view = document.querySelector('kikx-chat-view');
        let scroll = document.querySelector('aeor-scrollview');
        return { html: view?.outerHTML?.slice(0, 1200), metrics: scroll?.metrics?.(), body: document.querySelector('.kikx-thread__body')?.getBoundingClientRect?.() };
      });
      throw new Error(`${error.message}; pageErrors=${pageErrors.join(' | ')}; debug=${JSON.stringify(debug)}`);
    }
    assert.equal(initial.first, 'frame_241', 'the initial tail raw page should hold the newest 60 frames');
    assert.equal(initial.last, 'frame_300');
    assert.equal(initial.totalPages, 3, 'the source must expose every raw session page, not just the loaded window');
    assert.equal(initial.gaps > 0, true, 'pages outside the tail must begin as gaps');

    // Pull an older page through the real sentinel/paging path. It must load
    // into the existing gap and keep the viewport at the top.
    await page.evaluate(() => {
      let app = document.querySelector('kikx-app');
      app._ignoreFrameScrollUntil = 0;
      let list = document.querySelector('.kikx-frame-list');
      list.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true }));
      list.scrollTop = 0;
      list.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    let older = await waitFor(page, (value) => value.first && value.first < initial.first, 15000);
    assert.ok(older.scrollTop <= 5, `loading older history at the top must keep the viewport at the top, got ${older.scrollTop}`);
    await page.evaluate(() => {
      let list = document.querySelector('.kikx-frame-list');
      list.scrollTop = list.scrollHeight;
      list.dispatchEvent(new Event('scroll', { bubbles: true }));
    });

    let liveFrame = {
      id: 'frame_301',
      type: 'UserMessage',
      sessionID: 'session_scrollview',
      interactionID: 'interaction_301',
      authorType: 'user',
      authorID: 'stagehand-user',
      authorDisplayName: 'User',
      hidden: false,
      deleted: false,
      order: 301,
      timestamp: 1781035260000000 + 301 * 1000000,
      createdAt: 1781035260000000 + 301 * 1000000,
      updatedAt: 1781035260000000 + 301 * 1000000,
      content: { text: 'A live tail append' },
    };
    fixture.frameRuntime.framesBySessionID.get('session_scrollview').push(liveFrame);
    fixture.frameRuntime.emitEvent('frame.added', { sessionID: 'session_scrollview', frame: liveFrame });
    let appended = await waitFor(page, (value) => value.last === 'frame_301' && value.distanceFromBottom <= 5);
    assert.equal(appended.scrollview, true);

    assert.deepEqual(pageErrors, []);
  } finally {
    await browser?.close();
    await fixture.close();
  }
});

test('the default locked thread still renders and receives live appends through the scrollview', async () => {
  let chromePath = findChromeExecutable();
  if (!chromePath) {
    test.skip('Chrome is required');
    return;
  }

  let fixture = await startStagehandUIServer({
    sessions: [{ id: 'session_scrollview', title: 'Scrollview Thread', messageCount: 300 }],
    agents: [{ id: 'agent_scrollview', name: 'Scroll Agent', pluginID: 'test-agent', enabled: true }],
  });
  fixture.frameRuntime.framesBySessionID.set('session_scrollview', frames(300));
  let browser;

  try {
    browser = await chromium.launch({ executablePath: chromePath, headless: true, args: ['--no-sandbox'] });
    let page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    let pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(String(error)));

    await page.goto(`${fixture.baseURL}/?code=scrollview-locked-test&view=thread`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    let initial = await waitFor(page, (value) => value.scrollview && value.last === 'frame_300');
    assert.equal(initial.first, 'frame_241');

    let liveFrame = {
      id: 'frame_301',
      type: 'UserMessage',
      sessionID: 'session_scrollview',
      interactionID: 'interaction_301',
      authorType: 'user',
      authorID: 'stagehand-user',
      authorDisplayName: 'User',
      hidden: false,
      deleted: false,
      order: 301,
      timestamp: 1781035260000000 + 301 * 1000000,
      createdAt: 1781035260000000 + 301 * 1000000,
      updatedAt: 1781035260000000 + 301 * 1000000,
      content: { text: 'Locked live append' },
    };
    fixture.frameRuntime.framesBySessionID.get('session_scrollview').push(liveFrame);
    fixture.frameRuntime.emitEvent('frame.added', { sessionID: 'session_scrollview', frame: liveFrame });
    await waitFor(page, (value) => value.last === 'frame_301');
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser?.close();
    await fixture.close();
  }
});
