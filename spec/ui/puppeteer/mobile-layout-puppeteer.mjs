'use strict';

// Mobile emulation covers the layout failures desktop browser tests cannot see:
// min-content children widening the shell past the phone viewport, the quick
// action gutter squeezing message text, and the empty thinking dock consuming
// the whole thread on short screens. Touch scrolling is exercised through
// Puppeteer's touchscreen, not a synthetic wheel event.

import assert from 'node:assert/strict';
import test from 'node:test';

import puppeteer from 'puppeteer-core';

import { findChromeExecutable, startStagehandUIServer } from '../stagehand/stagehand-test-utils.mjs';

const VIEWPORTS = [
  { width: 390, height: 844, name: 'iPhone 13 portrait' },
  { width: 320, height: 568, name: 'small phone portrait' },
  { width: 844, height: 390, name: 'phone landscape' },
];

function frames(count) {
  return Array.from({ length: count }, (_value, index) => {
    let number = index + 1;
    let timestamp = 1781035260000000 + number * 1000000;
    return {
      id: `mobile_frame_${number}`,
      type: number % 4 === 0 ? 'UserMessage' : 'AgentMessage',
      sessionID: 'session_mobile',
      interactionID: `mobile_interaction_${number}`,
      authorType: number % 4 === 0 ? 'user' : 'agent',
      authorID: number % 4 === 0 ? 'mobile_user' : 'mobile_agent',
      authorDisplayName: number % 4 === 0 ? 'Wyatt' : 'Mobile Agent',
      hidden: false,
      deleted: false,
      order: number,
      timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
      content: {
        text: `Mobile message ${number}: a deliberately long line verifies wrapping, readable line length, and vertical scrolling on a compact phone screen. ${'extra words '.repeat(8)}`,
      },
    };
  });
}

async function mobileMetrics(page) {
  return await page.evaluate(() => {
    let app = document.querySelector('kikx-app');
    let topbar = document.querySelector('.kikx-topbar');
    let sessions = document.querySelector('.kikx-sessions');
    let thread = document.querySelector('.kikx-thread');
    let body = document.querySelector('.kikx-thread__body');
    let list = document.querySelector('.kikx-frame-list');
    let composer = document.querySelector('.kikx-composer');
    let rect = (node) => {
      if (!node) return null;
      let value = node.getBoundingClientRect();
      return { x: value.x, y: value.y, width: value.width, height: value.height, right: value.right, bottom: value.bottom };
    };
    let controls = [ ...document.querySelectorAll('.kikx-topbar button, .kikx-composer button') ]
      .filter((button) => button.getBoundingClientRect().width > 0)
      .map((button) => ({ text: button.textContent.trim().slice(0, 24), rect: rect(button) }));
    return {
      viewport: { width: innerWidth, height: innerHeight },
      document: { scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight },
      topbar: rect(topbar),
      sessions: rect(sessions),
      thread: rect(thread),
      body: rect(body),
      list: rect(list),
      composer: rect(composer),
      frameCount: document.querySelectorAll('kikx-frame-item[data-frame-id]').length,
      listOverflowX: Boolean(list && list.scrollWidth > list.clientWidth + 1),
      listScrollable: Boolean(list && list.scrollHeight > list.clientHeight + 1),
      documentOverflowX: document.documentElement.scrollWidth > innerWidth + 1,
      controls,
      selectedSessionID: app?._state?.selectedSessionID || null,
    };
  });
}

async function waitForThread(page) {
  await page.waitForSelector('kikx-frame-item[data-frame-id]', { timeout: 15000 });
  await page.waitForSelector('.kikx-thread-scrollview', { timeout: 15000 });
  await new Promise((resolve) => setTimeout(resolve, 350));
}

test('Puppeteer mobile emulation keeps the shell inside phone viewports and touch-scrolls the thread', async (t) => {
  let chromePath = findChromeExecutable();
  if (!chromePath) {
    t.skip('Puppeteer mobile coverage requires Chrome');
    return;
  }

  let fixture = await startStagehandUIServer({
    sessions: [ { id: 'session_mobile', title: 'Mobile Session', messageCount: 40 } ],
    agents: [ { id: 'mobile_agent', name: 'Mobile Agent', pluginID: 'test-agent', enabled: true } ],
  });
  fixture.frameRuntime.framesBySessionID.set('session_mobile', frames(40));

  let browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: process.env.KIKX_PUPPETEER_HEADLESS === '0' ? false : 'new',
    args: [ '--no-sandbox', '--disable-setuid-sandbox' ],
  });

  try {
    for (let viewport of VIEWPORTS) {
      let page = await browser.newPage();
      await page.setViewport({
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
      });
      await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1');
      await page.evaluateOnNewDocument(() => {
        sessionStorage.setItem('kikx.auth.session', JSON.stringify({ token: 'mobile-test-token', refresh_token: 'mobile-test-refresh' }));
      });
      await page.goto(`${fixture.baseURL}/?session=session_mobile`, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await waitForThread(page);

      let metrics = await mobileMetrics(page);
      assert.equal(metrics.documentOverflowX, false, `${viewport.name}: document overflowed horizontally`);
      assert.equal(metrics.listOverflowX, false, `${viewport.name}: the frame list overflowed horizontally`);
      assert.equal(metrics.viewport.width, viewport.width, `${viewport.name}: viewport width changed`);
      assert.ok(metrics.topbar.width <= viewport.width + 1, `${viewport.name}: topbar is wider than the viewport`);
      assert.ok(metrics.sessions.width <= viewport.width + 1, `${viewport.name}: sidebar is wider than the viewport`);
      assert.ok(metrics.thread.width <= viewport.width + 1, `${viewport.name}: thread is wider than the viewport`);
      assert.ok(metrics.list.right <= viewport.width + 1, `${viewport.name}: frame list extends past the viewport`);
      assert.ok(metrics.composer.bottom <= viewport.height + 1, `${viewport.name}: composer extends below the viewport`);
      assert.ok(metrics.list.height >= (viewport.height >= 700 ? 220 : 100), `${viewport.name}: thread has only ${metrics.list.height}px of usable height`);
      assert.ok(metrics.frameCount > 0, `${viewport.name}: no frames rendered`);

      for (let control of metrics.controls) {
        assert.ok(control.rect.x >= -1 && control.rect.right <= viewport.width + 1, `${viewport.name}: control "${control.text}" is clipped horizontally`);
        assert.ok(control.rect.y >= -1 && control.rect.bottom <= viewport.height + 1, `${viewport.name}: control "${control.text}" is clipped vertically`);
      }

      assert.equal(metrics.listScrollable, true, `${viewport.name}: thread should be scrollable`);
      await page.evaluate(() => {
        let list = document.querySelector('.kikx-frame-list');
        list.scrollTop = 0;
      });
      let listBox = metrics.list;
      let x = Math.min(viewport.width - 20, Math.max(20, listBox.x + listBox.width / 2));
      let startY = listBox.y + listBox.height * 0.75;
      let endY = listBox.y + listBox.height * 0.25;
      await page.touchscreen.touchStart(x, startY);
      await page.touchscreen.touchMove(x, endY);
      await page.touchscreen.touchEnd();
      await new Promise((resolve) => setTimeout(resolve, 250));
      let touchScroll = await page.evaluate(() => document.querySelector('.kikx-frame-list')?.scrollTop || 0);
      assert.ok(touchScroll > 0, `${viewport.name}: touch swipe did not scroll the thread (scrollTop=${touchScroll})`);

      // Main views replace the thread; they must not reintroduce horizontal
      // overflow through their own cards/forms.
      await page.evaluate(() => {
        let agents = [ ...document.querySelectorAll('.kikx-sidebar__view') ]
          .find((button) => button.textContent.trim() === 'Agents');
        agents?.click();
      });
      await page.waitForSelector('.kikx-agent-manager', { timeout: 10000 });
      let agentsView = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth,
        overflow: document.documentElement.scrollWidth > innerWidth + 1,
        manager: (() => {
          let node = document.querySelector('.kikx-agent-manager');
          if (!node) return null;
          let rect = node.getBoundingClientRect();
          return { x: rect.x, width: rect.width, right: rect.right };
        })(),
      }));
      assert.equal(agentsView.overflow, false, `${viewport.name}: Agents view overflowed horizontally`);
      assert.ok(agentsView.manager && agentsView.manager.right <= viewport.width + 1, `${viewport.name}: Agents view extends past the viewport`);

      await page.close();
    }
  } finally {
    await browser.close();
    await fixture.close();
  }
});
