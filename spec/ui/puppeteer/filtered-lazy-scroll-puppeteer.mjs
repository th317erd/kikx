'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';
import puppeteer from 'puppeteer-core';
import { findChromeExecutable, startStagehandUIServer } from '../stagehand/stagehand-test-utils.mjs';

function frame(id, order, text) {
  let timestamp = 1793328600000000 + order * 1000000;
  return { id, type: 'UserMessage', sessionID: 'session_filtered_scroll', interactionID: `i${order}`, parentID: null, authorType: 'user', authorID: 'owner', authorDisplayName: 'Wyatt', hidden: false, deleted: false, order, timestamp, createdAt: timestamp, updatedAt: timestamp, content: { text } };
}

async function capture(page) {
  return page.evaluate(() => {
    let list = document.querySelector('.kikx-frame-list');
    let item = [ ...document.querySelectorAll('kikx-frame-item[data-frame-id]') ]
      .find((candidate) => candidate.getBoundingClientRect().bottom > list.getBoundingClientRect().top);
    return {
      id: item?.dataset.frameId || null,
      relativeTop: item ? item.getBoundingClientRect().top - list.getBoundingClientRect().top : null,
    };
  });
}

test('Puppeteer keeps a filtered frame anchored while lazy pages load above it', async (t) => {
  let chromePath = findChromeExecutable();
  if (!chromePath) { t.skip('Chrome required'); return; }
  let frames = [];
  for (let order = 1; order <= 1200; order++)
    frames.push(frame(`frame_${order}`, order, order % 100 === 0 ? `target ${order}` : `filler ${order}`));
  let fixture = await startStagehandUIServer({ sessions: [ { id: 'session_filtered_scroll', title: 'Filtered Scroll', messageCount: 1200 } ] });
  fixture.frameRuntime.framesBySessionID.set('session_filtered_scroll', frames);
  let browser = await puppeteer.launch({ executablePath: chromePath, headless: 'new', args: [ '--no-sandbox', '--disable-setuid-sandbox' ] });
  try {
    let page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.evaluateOnNewDocument(() => sessionStorage.setItem('kikx.auth.session', JSON.stringify({ token: 'filtered-scroll-token', refresh_token: 'filtered-scroll-refresh' })));
    await page.goto(`${fixture.baseURL}/?session=session_filtered_scroll`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForSelector('kikx-frame-item[data-frame-id]', { timeout: 15000 });
    await new Promise((resolve) => setTimeout(resolve, 800));
    let input = await page.$('.kikx-session-search input');
    await input.click();
    await page.keyboard.type('filler');
    await new Promise((resolve) => setTimeout(resolve, 800));
    await page.evaluate(() => document.querySelector('kikx-chat-view')._scrollview.element.scrollToPage(5, { align: 'start', animate: false }));
    await new Promise((resolve) => setTimeout(resolve, 700));
    let before = await capture(page);
    assert.ok(before.id);
    await page.mouse.move(600, 400);
    await page.mouse.wheel({ deltaY: -800 });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    let after = await capture(page);
    let beforeOrder = Number(String(before.id).split('_').at(-1));
    let afterOrder = Number(String(after.id).split('_').at(-1));
    assert.ok(Math.abs(afterOrder - beforeOrder) <= 20,
      `the viewport jumped more than one local frame group (${before.id} -> ${after.id})`);
    assert.ok(Math.abs((after.relativeTop || 0) - (before.relativeTop || 0)) < 150,
      `the anchored frame moved vertically (${before.relativeTop} -> ${after.relativeTop})`);
  } finally {
    await browser?.close();
    await fixture.close();
  }
});
