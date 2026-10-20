'use strict';

// Regression guard for the bounded thread window. A long session must not keep
// every historical frame in the DOM. The newest N frames are materialized; the
// top of the window reveals older state frames; returning to the bottom restores
// the newest window.

import assert from 'node:assert/strict';
import test from 'node:test';

import puppeteer from 'puppeteer-core';

import {
  findChromeExecutable,
  startStagehandUIServer,
} from '../stagehand/stagehand-test-utils.mjs';

const FRAME_COUNT = 140;

function messageFrame(index, timestamp) {
  return {
    id: `window_msg_${index}`,
    type: 'AgentMessage',
    sessionID: 'session_1',
    authorType: 'agent',
    authorID: 'agent_1',
    authorDisplayName: 'Zav',
    timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
    order: index + 1,
    hidden: false,
    deleted: false,
    content: { status: 'complete', text: `Message ${index}\n${'body text '.repeat(20)}` },
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('Puppeteer keeps only a bounded frame window and reveals older frames on scroll up', async (t) => {
  let chromePath = findChromeExecutable();
  if (!chromePath) {
    t.skip('Puppeteer local smoke requires Chrome');
    return;
  }

  let fixture = await startStagehandUIServer({
    sessions: [ { id: 'session_1', title: 'Frame Window', messageCount: FRAME_COUNT } ],
  });
  let timestamp = 1781035260000000;
  fixture.frameRuntime.framesBySessionID.set('session_1',
    Array.from({ length: FRAME_COUNT }, (_value, index) => messageFrame(index, timestamp + index * 1000)));

  let browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: process.env.KIKX_PUPPETEER_HEADLESS === '0' ? false : 'new',
    args: [ '--no-sandbox', '--disable-setuid-sandbox' ],
  });

  try {
    let page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.evaluateOnNewDocument(() => {
      sessionStorage.setItem('kikx.auth.session', JSON.stringify({ token: 'puppeteer-test-token', refresh_token: 'puppeteer-test-refresh' }));
    });
    await page.goto(`${fixture.baseURL}/?view=thread`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForSelector('kikx-frame-item[data-frame-id="window_msg_139"]', { timeout: 15000 });
    await delay(300);

    let snapshot = () => page.evaluate(() => {
      let app = document.querySelector('kikx-app');
      let list = app.querySelector('.kikx-frame-list');
      app._scrollFramesToBottom();
      let ids = Array.from(app.querySelectorAll('.kikx-frame-list kikx-frame-item[data-frame-id]'))
        .map((item) => item.dataset.frameId);
      return { ids, count: ids.length, windowStart: app.querySelector('.kikx-thread__body kikx-chat-view')?.windowStart ?? null };
    });

    let initial = await snapshot();
    assert.ok(initial.count > 0 && initial.count <= 80, `rendered window is bounded (${initial.count})`);
    assert.equal(initial.ids.at(-1), 'window_msg_139');
    assert.equal(initial.ids.includes('window_msg_0'), false, 'the oldest frame is not in the initial DOM');

    await page.evaluate(() => {
      let list = document.querySelector('.kikx-frame-list');
      list.scrollTop = 0;
      list.dispatchEvent(new Event('scroll'));
    });
    await delay(400);
    let older = await snapshot();
    assert.ok(older.count <= 80, `older reveal remains bounded (${older.count})`);
    assert.notEqual(older.ids[0], initial.ids[0], 'the window moved to older frames');
    assert.equal(older.ids.includes('window_msg_139'), false, 'the window moved back from the newest tail');

    await page.evaluate(() => {
      let list = document.querySelector('.kikx-frame-list');
      list.scrollTop = list.scrollHeight;
      list.dispatchEvent(new Event('scroll'));
    });
    await delay(400);
    let latest = await snapshot();
    assert.ok(latest.count <= 80, 'returning to the bottom keeps the DOM bounded');
    assert.equal(latest.ids.at(-1), 'window_msg_139');
  } finally {
    await browser.close().catch(() => {});
    await fixture.close().catch(() => {});
  }
});
