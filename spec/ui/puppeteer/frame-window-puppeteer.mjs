'use strict';

// Regression guard for the bounded thread window. A long session must not keep
// every historical frame in the DOM. The newest N frames are materialized; the
// top of the window reveals older state frames; returning to the bottom restores
// the newest window.
//
// The caps are read from the product module rather than duplicated as literals.
// This spec used to hard-code `<= 80`, from 24b0065e when MAX_RENDERED_FRAMES
// was 80. 94a18a7d raised it to 200 (and added MAX_TOTAL_RENDERED_FRAMES = 800),
// and 898a33b0 lowered it to 120; the literal never moved, so the assertion
// described a cap the product had stopped honouring. Importing the module is not
// an option here: kikx-chat-view.mjs pulls in the browser-only
// /vendor/aeor-web-components bundle, which Node cannot resolve. Read the
// declarations from source instead, so this guard tracks the shipped cap.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import puppeteer from 'puppeteer-core';

import {
  findChromeExecutable,
  startStagehandUIServer,
} from '../stagehand/stagehand-test-utils.mjs';

const CHAT_VIEW_SOURCE = fs.readFileSync(
  fileURLToPath(new URL('../../../src/client/components/kikx-chat-view.mjs', import.meta.url)),
  'utf8');

function sourceConstant(name) {
  let match = CHAT_VIEW_SOURCE.match(new RegExp(`export const ${name} = (\\d+);`));
  assert.ok(match, `${name} is declared in kikx-chat-view.mjs`);
  return Number(match[1]);
}

const MAX_RENDERED_FRAMES = sourceConstant('MAX_RENDERED_FRAMES');
const MAX_TOTAL_RENDERED_FRAMES = sourceConstant('MAX_TOTAL_RENDERED_FRAMES');

// A fixture smaller than the hard cap exercises the reveal path itself; a
// larger one would be needed to exercise eviction, which is covered by
// spec/client/chat-view-window-spec.mjs without a browser.
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
    assert.ok(initial.count > 0 && initial.count <= MAX_RENDERED_FRAMES,
      `rendered window is bounded by the page cap (${initial.count} <= ${MAX_RENDERED_FRAMES})`);
    assert.equal(initial.ids.at(-1), 'window_msg_139');
    assert.equal(initial.ids.includes('window_msg_0'), false, 'the oldest frame is not in the initial DOM');

    await page.evaluate(() => {
      let list = document.querySelector('.kikx-frame-list');
      list.scrollTop = 0;
      list.dispatchEvent(new Event('scroll'));
    });
    await delay(400);
    let older = await snapshot();
    assert.ok(older.count <= MAX_TOTAL_RENDERED_FRAMES,
      `older reveal stays within the hard cap (${older.count} <= ${MAX_TOTAL_RENDERED_FRAMES})`);
    assert.notEqual(older.ids[0], initial.ids[0], 'the window moved to older frames');

    if (FRAME_COUNT <= MAX_TOTAL_RENDERED_FRAMES) {
      // The whole thread fits under the hard cap, so revealing the top of the
      // list materialises every frame. Asserting equality is what makes this
      // discriminating: a bounded-by-accident initial render fails it, while the
      // stale `<= 80` literal passed it without ever being close.
      assert.equal(older.count, FRAME_COUNT,
        `a session under the cap reveals every frame (${older.count} === ${FRAME_COUNT})`);
      assert.equal(older.ids.includes('window_msg_0'), true, 'the oldest frame is revealed by scrolling up');
      assert.equal(older.ids.at(-1), 'window_msg_139', 'the newest frame is retained while the thread fits under the cap');
    } else {
      assert.equal(older.ids.includes('window_msg_139'), false, 'the window moved back from the newest tail');
    }

    await page.evaluate(() => {
      let list = document.querySelector('.kikx-frame-list');
      list.scrollTop = list.scrollHeight;
      list.dispatchEvent(new Event('scroll'));
    });
    await delay(400);
    let latest = await snapshot();
    assert.ok(latest.count <= MAX_TOTAL_RENDERED_FRAMES, 'returning to the bottom keeps the DOM bounded');
    assert.equal(latest.ids.at(-1), 'window_msg_139');
  } finally {
    await browser.close().catch(() => {});
    await fixture.close().catch(() => {});
  }
});
