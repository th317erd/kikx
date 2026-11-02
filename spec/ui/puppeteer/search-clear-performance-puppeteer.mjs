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

    await page.click('.kikx-session-search__clear');
    await new Promise((resolve) => setTimeout(resolve, 1600));

    let cleared = await page.evaluate(() => {
      let scrollview = document.querySelector('kikx-chat-view')._scrollview;
      let metrics = scrollview.element.metrics();
      let input = document.querySelector('.kikx-session-search input');
      let clear = document.querySelector('.kikx-session-search__clear');
      return {
        search: document.querySelector('kikx-app')?._state?.sessionSearch || '',
        inputValue: input?.value ?? null,
        clearHidden: clear?.hidden === true,
        loadedPages: metrics.loadedPages,
        mountedItems: metrics.mountedItems,
        nearBottom: metrics.maxScrollTop - metrics.scrollTop,
        follow: scrollview.element.follow === true,
        lastVisible: [ ...document.querySelectorAll('kikx-frame-item') ].at(-1)?.getAttribute('data-frame-id') || null,
      };
    });

    assert.equal(cleared.search, '', 'search state did not clear');
    assert.equal(cleared.inputValue, '', 'clear button did not clear the search input');
    assert.equal(cleared.clearHidden, true, 'clear button stayed visible after clearing');
    assert.ok(cleared.mountedItems >= 120, 'clearing search did not restore the visible page content');
    assert.ok(cleared.mountedItems < 1800, `clearing search mounted too many offscreen frames: ${cleared.mountedItems}`);
    assert.ok(cleared.loadedPages <= 6, `clearing search kept too many offscreen pages loaded: ${cleared.loadedPages}`);
    assert.ok(cleared.follow, 'clearing search did not restore bottom follow');
    assert.ok(cleared.nearBottom <= 2, `clearing search did not pin to the bottom: ${cleared.nearBottom}px away`);
    assert.equal(cleared.lastVisible, 'f5000', 'clearing search did not land on the newest frame');
  } finally {
    await browser?.close();
    await fixture.close();
  }
});
