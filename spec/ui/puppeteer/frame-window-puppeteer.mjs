'use strict';

// Regression guard for the bounded thread window in the SHARED SCROLLVIEW path.
//
// WHAT IS ASSERTED, AND WHY IT IS THE REAL CONTRACT
// The DOM here is governed by page arithmetic, not by a frame cap:
// createKikxPageContext() hard-codes `pageSize: PAGE_SIZE` and
// _mountPagedSource() prefers it, so the mounted window is a whole number of
// server pages. `MAX_RENDERED_FRAMES` is only the KikxChatScrollView
// constructor fallback and does not bound this path. (Measured: with
// MAX_RENDERED_FRAMES 120 -> 800 the settled DOM still holds 460 items at 700
// frames.) So a `count <= MAX_RENDERED_FRAMES` assertion could never fail and
// was removed — it is what let the 120 -> 800 mutation survive.
//
// What the spec pins instead is the observable window contract, all of which is
// true at BOTH the first-mount state and the settled state:
//   1. the initial window is strictly smaller than the thread (no whole-thread
//      mount), and the oldest frame is absent while the newest is present;
//   2. `windowStart` is the index of the first frame actually in the DOM. This
//      is the documented meaning of the getter (spec/client/chat-view-window-spec
//      asserts the same identity) and it is what makes the cap constant
//      discriminating: desynchronising MAX_RENDERED_FRAMES from PAGE_SIZE makes
//      _mountPagedSource() compute `target * this.pageSize` with the wrong
//      divisor, so windowStart lands outside the thread (4000 in a 700-frame
//      session) while the DOM still starts at a real frame;
//   3. scrolling up with a REAL gesture reveals the oldest frame and the whole
//      thread fits under MAX_TOTAL_RENDERED_FRAMES;
//   4. returning to the bottom keeps the newest frame mounted.
//
// WHY 700 FRAMES
// With 140 frames two pages hold the entire thread, so "bounded" was true only
// during a ~300 ms transient and the spec was intermittently red. At 700 frames
// (6 pages) the initial window is bounded in every state, so no sample timing
// is load-bearing and there are no fixed sleeps.
//
// WHY A REAL WHEEL GESTURE AND NOT `dispatchEvent(new Event('scroll'))`
// A fresh profile is scroll-locked (DEFAULT_LOCKED = true in kikx-scroll-lock.mjs)
// and maybeLoadOlderFrames() refuses to load while the session is locked. The
// pin is only broken inside onFrameListScroll()'s `userGesture` branch, and
// `_frameListUserGestureUntil` is set solely by real input listeners (wheel /
// touchmove / pointerdown / keydown). A synthetic scroll event therefore leaves
// the thread locked and the product correctly snaps the viewport back to the
// bottom: measured at 700 frames, the synthetic path ends at items 100 with the
// oldest frame absent, while mouse.wheel reaches items 700 with frame 0 mounted.
//
// Importing kikx-chat-view.mjs is not an option: it pulls in the browser-only
// /vendor/aeor-web-components bundle, which Node cannot resolve. The constants
// are read from source so the failure messages track the shipped numbers.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import puppeteer from 'puppeteer-core';

import {
  findChromeExecutable,
  startStagehandUIServer,
} from '../stagehand/stagehand-test-utils.mjs';

function readSource(relativePath) {
  return fs.readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');
}

function numericConstant(source, expression, label) {
  let match = source.match(new RegExp(expression));
  assert.ok(match, `${label} is declared in the product source`);
  return Number(match[1]);
}

const CHAT_VIEW_SOURCE = readSource('../../../src/client/components/kikx-chat-view.mjs');
const SCROLLVIEW_SOURCE = readSource('../../../src/client/components/kikx-chat-scrollview.mjs');

const MAX_TOTAL_RENDERED_FRAMES = numericConstant(
  CHAT_VIEW_SOURCE, 'export const MAX_TOTAL_RENDERED_FRAMES = (\\d+);', 'MAX_TOTAL_RENDERED_FRAMES');
const PAGE_SIZE = numericConstant(
  SCROLLVIEW_SOURCE, 'const PAGE_SIZE = (\\d+);', 'PAGE_SIZE');

// Six pages: enough that the initial window is bounded by page arithmetic in
// every state, and small enough that the reveal can materialise the whole
// thread without hitting eviction.
const FRAME_COUNT = 700;

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

// Reads the mounted window without forcing a scroll, plus the first mounted
// frame index that `windowStart` is supposed to equal.
function snapshot(page) {
  return page.evaluate(() => {
    let app = document.querySelector('kikx-app');
    let view = app.querySelector('.kikx-thread__body kikx-chat-view');
    let list = app.querySelector('.kikx-frame-list');
    let ids = Array.from(app.querySelectorAll('.kikx-frame-list kikx-frame-item[data-frame-id]'))
      .map((item) => item.dataset.frameId);
    let indexes = ids
      .map((id) => Number(String(id).replace('window_msg_', '')))
      .filter((index) => Number.isFinite(index));
    return {
      ids,
      count: ids.length,
      distinct: new Set(ids).size,
      firstMountedIndex: indexes.length ? Math.min(...indexes) : null,
      windowStart: view?.windowStart ?? null,
      scrollTop: list ? list.scrollTop : null,
      scrollHeight: list ? list.scrollHeight : null,
      usesPagedScrollview: view?.usesPagedScrollview ?? null,
    };
  });
}

async function pointAtFrameList(page) {
  let box = await page.evaluate(() => {
    let rect = document.querySelector('.kikx-frame-list').getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  await page.mouse.move(box.x, box.y);
}

// A real wheel gesture is the only stimulus that breaks the bottom pin and lets
// the older pages load. Steps until the predicate holds, then reports whether it
// ever did — the caller asserts on that, so a no-op gesture cannot pass silently.
async function wheelUntil(page, predicateBody, { deltaY, steps = 240, stepMs = 25 } = {}) {
  for (let step = 0; step < steps; step++) {
    if (await page.evaluate(predicateBody)) return true;
    await page.mouse.wheel({ deltaY });
    await delay(stepMs);
  }
  return page.evaluate(predicateBody);
}

test('Puppeteer keeps the initial thread window bounded and reveals older frames on a real scroll', async (t) => {
  let chromePath = findChromeExecutable();
  if (!chromePath) {
    t.skip('Puppeteer local smoke requires Chrome');
    return;
  }

  // The reveal assertions assume the whole thread fits under the hard cap.
  assert.ok(FRAME_COUNT <= MAX_TOTAL_RENDERED_FRAMES,
    `the fixture (${FRAME_COUNT}) must fit under MAX_TOTAL_RENDERED_FRAMES (${MAX_TOTAL_RENDERED_FRAMES})`);
  assert.ok(FRAME_COUNT > PAGE_SIZE * 2,
    `the fixture (${FRAME_COUNT}) must span more than two pages (page size ${PAGE_SIZE}), `
    + 'otherwise the initial window is the whole thread and cannot be proven bounded');

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

    let newestID = `window_msg_${FRAME_COUNT - 1}`;
    let oldestID = 'window_msg_0';
    await page.waitForSelector(`kikx-frame-item[data-frame-id="${newestID}"]`, { timeout: 15000 });

    // --- initial window -------------------------------------------------------
    // No sleep: every assertion holds while only the tail page is mounted and
    // after the idle read-ahead has added older pages.
    let initial = await snapshot(page);
    assert.equal(initial.usesPagedScrollview, true, 'the thread runs on the shared paged scrollview');
    assert.ok(initial.count > 0, 'the thread mounts at least one frame');
    assert.equal(initial.distinct, initial.count, 'no frame is mounted twice');
    assert.ok(initial.count < FRAME_COUNT,
      `the initial window is smaller than the thread (${initial.count} < ${FRAME_COUNT}); `
      + 'mounting every historical frame means the window is not bounded');
    assert.equal(initial.ids.at(-1), newestID, 'the newest frame is mounted at the bottom');
    assert.equal(initial.ids.includes(oldestID), false,
      'the oldest frame is not in the initial DOM');
    assert.equal(initial.windowStart, initial.firstMountedIndex,
      `windowStart names the first mounted frame (windowStart ${initial.windowStart} === first mounted ${initial.firstMountedIndex}); `
      + 'a mismatch means the render window and the page arithmetic disagree');

    // --- reveal older frames with a real gesture ------------------------------
    await pointAtFrameList(page);
    let moved = await wheelUntil(page,
      () => (document.querySelector('.kikx-frame-list')?.scrollTop ?? 0) <= 5,
      { deltaY: -1500 });
    assert.equal(moved, true,
      'a real wheel gesture moves the viewport to the top; the bottom pin is only broken by real input');

    await page.waitForFunction(
      (id) => Boolean(document.querySelector(`.kikx-frame-list kikx-frame-item[data-frame-id="${id}"]`)),
      { timeout: 15000, polling: 50 },
      oldestID);
    // Let the last page finish settling so the count assertion sees the final
    // window rather than a mid-load one.
    await page.waitForFunction(
      (total) => document.querySelectorAll('.kikx-frame-list kikx-frame-item[data-frame-id]').length === total,
      { timeout: 15000, polling: 50 },
      FRAME_COUNT);

    let older = await snapshot(page);
    assert.equal(older.ids.includes(oldestID), true,
      'scrolling up reveals the oldest frame');
    assert.equal(older.ids.at(-1), newestID,
      'the newest frame is retained while the thread fits under the hard cap');
    assert.equal(older.distinct, older.count, 'the reveal does not duplicate frames');
    assert.ok(older.count <= MAX_TOTAL_RENDERED_FRAMES,
      `the reveal stays within the hard cap (${older.count} <= ${MAX_TOTAL_RENDERED_FRAMES})`);
    assert.equal(older.count, FRAME_COUNT,
      `a thread under the hard cap reveals every frame (${older.count} === ${FRAME_COUNT})`);
    assert.equal(older.windowStart, older.firstMountedIndex,
      `windowStart follows the reveal to the first mounted frame (windowStart ${older.windowStart} === first mounted ${older.firstMountedIndex})`);

    // --- back to the newest frames --------------------------------------------
    await pointAtFrameList(page);
    let returned = await wheelUntil(page,
      () => {
        let list = document.querySelector('.kikx-frame-list');
        return Boolean(list) && list.scrollTop >= list.scrollHeight - list.clientHeight - 40;
      },
      { deltaY: 1500 });
    assert.equal(returned, true, 'a real wheel gesture returns the viewport to the bottom');

    await page.waitForFunction(
      (id) => Boolean(document.querySelector(`.kikx-frame-list kikx-frame-item[data-frame-id="${id}"]`)),
      { timeout: 15000, polling: 50 },
      newestID);

    let latest = await snapshot(page);
    assert.equal(latest.ids.at(-1), newestID, 'returning to the bottom keeps the newest frame');
    assert.ok(latest.count <= MAX_TOTAL_RENDERED_FRAMES,
      `the thread stays within the hard cap (${latest.count} <= ${MAX_TOTAL_RENDERED_FRAMES})`);
    assert.equal(latest.distinct, latest.count, 'returning to the bottom does not duplicate frames');
  } finally {
    await browser.close().catch(() => {});
    await fixture.close().catch(() => {});
  }
});
