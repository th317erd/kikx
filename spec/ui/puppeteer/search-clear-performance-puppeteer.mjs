'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';
import puppeteer from 'puppeteer-core';
import { findChromeExecutable, startStagehandUIServer } from '../stagehand/stagehand-test-utils.mjs';

function frame(id, order, text) {
  let timestamp = 1793328600000000 + order * 1000000;
  return { id, type: 'UserMessage', sessionID: 'session_clear', interactionID: `i${order}`, parentID: null, authorType: 'user', authorID: 'owner', authorDisplayName: 'Wyatt', hidden: false, deleted: false, order, timestamp, createdAt: timestamp, updatedAt: timestamp, content: { text } };
}

test('Puppeteer clearing search does not re-render every previously loaded page', async (t) => {
  let chromePath = findChromeExecutable();
  if (!chromePath) { t.skip('Puppeteer clear-search coverage requires Chrome'); return; }
  let frames = [];
  for (let index = 1; index <= 5000; index++)
    frames.push(frame(`f${index}`, index, index % 100 === 0 ? `target ${index}` : `filler ${index}`));
  let fixture = await startStagehandUIServer({ sessions: [ { id: 'session_clear', title: 'Clear search', messageCount: frames.length } ] });
  fixture.frameRuntime.framesBySessionID.set('session_clear', frames);
  let browser = await puppeteer.launch({ executablePath: chromePath, headless: 'new', args: [ '--no-sandbox', '--disable-setuid-sandbox' ] });
  try {
    let page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.evaluateOnNewDocument(() => sessionStorage.setItem('kikx.auth.session', JSON.stringify({ token: 'clear-token', refresh_token: 'clear-refresh' })));
    await page.goto(`${fixture.baseURL}/?session=session_clear`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForSelector('kikx-frame-item', { timeout: 15000 });
    await new Promise((resolve) => setTimeout(resolve, 800));

    // Load pages across the session rather than only the live tail. This is the
    // shape that used to make clearing search rebuild every visited page.
    for (let pageIndex of [ 0, 5, 10, 15, 20, 25, 30, 35, 38 ]) {
      await page.evaluate((index) => document.querySelector('kikx-chat-view')._scrollview.element.scrollToPage(index, { align: 'start', animate: false }), pageIndex);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    let before = await page.evaluate(() => {
      let scrollview = document.querySelector('kikx-chat-view')._scrollview;
      return { loadedPages: scrollview.element.metrics().loadedPages, mountedItems: scrollview.element.metrics().mountedItems };
    });
    assert.ok(before.loadedPages > 4, `expected several loaded pages before search, got ${before.loadedPages}`);

    let input = await page.$('.kikx-session-search input');
    await input.click();
    await page.keyboard.type('target');
    await new Promise((resolve) => setTimeout(resolve, 1400));
    let searched = await page.evaluate(() => {
      let scrollview = document.querySelector('kikx-chat-view')._scrollview;
      return { loadedPages: scrollview.element.metrics().loadedPages, mountedItems: scrollview.element.metrics().mountedItems };
    });
    assert.ok(searched.mountedItems < before.mountedItems, 'search did not reduce the mounted frame set');

    let firstVisibleBeforeClear = await page.evaluate(() => {
      let scrollview = document.querySelector('kikx-chat-view')._scrollview;
      let viewport = scrollview.frameList.getBoundingClientRect();
      return [ ...document.querySelectorAll('kikx-frame-item') ].find((node) => {
        let rect = node.getBoundingClientRect();
        return rect.bottom >= viewport.top && rect.top <= viewport.bottom;
      })?.getAttribute('data-frame-id') || null;
    });

    await page.evaluate(() => {
      let input = document.querySelector('.kikx-session-search input');
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await new Promise((resolve) => setTimeout(resolve, 1200));

    let cleared = await page.evaluate(() => {
      let scrollview = document.querySelector('kikx-chat-view')._scrollview;
      let viewport = scrollview.frameList.getBoundingClientRect();
      let firstVisible = [ ...document.querySelectorAll('kikx-frame-item') ].find((node) => {
        let rect = node.getBoundingClientRect();
        return rect.bottom >= viewport.top && rect.top <= viewport.bottom;
      })?.getAttribute('data-frame-id') || null;
      return {
        search: document.querySelector('kikx-app')?._state?.sessionSearch || '',
        loadedPages: scrollview.element.metrics().loadedPages,
        mountedItems: scrollview.element.metrics().mountedItems,
        firstVisible,
      };
    });

    assert.equal(cleared.search, '', 'search state did not clear');
    assert.ok(cleared.mountedItems >= 120, 'clearing search did not restore the visible page content');
    assert.ok(cleared.mountedItems < 1800, `clearing search mounted too many offscreen frames: ${cleared.mountedItems}`);
    assert.ok(cleared.loadedPages <= 6, `clearing search kept too many offscreen pages loaded: ${cleared.loadedPages}`);
    assert.ok(cleared.firstVisible, 'clearing search left no visible frame');
    if (firstVisibleBeforeClear && cleared.firstVisible) {
      let beforeOrder = Number(firstVisibleBeforeClear.replace(/\D/g, ''));
      let afterOrder = Number(cleared.firstVisible.replace(/\D/g, ''));
      assert.ok(Math.abs(afterOrder - beforeOrder) <= 120, `clearing search moved the viewport from ${firstVisibleBeforeClear} to ${cleared.firstVisible}`);
    }
  } finally {
    await browser?.close();
    await fixture.close();
  }
});
