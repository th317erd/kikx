'use strict';

// Regression guard for the bounded thread window in the SHARED SCROLLVIEW path.
//
// WHAT IS ASSERTED, AND WHY IT IS THE REAL CONTRACT
// The DOM here is governed by page arithmetic, not by a frame cap:
// createKikxPageContext() hard-codes `pageSize: PAGE_SIZE` and
// _mountPagedSource() prefers `this.pageContext.pageSize || this.pageSize`, so
// the mounted window is a whole number of server pages. `MAX_RENDERED_FRAMES` is
// only the KikxChatScrollView constructor fallback and never reaches the page
// source on this path; it only sets `this.pageSize`, the windowStart divisor.
// (Measured: with MAX_RENDERED_FRAMES 120 -> 800 the settled DOM still holds 460
// items at 700 frames.)
//
// Both constants are therefore pinned, but by different assertions:
//   * MAX_RENDERED_FRAMES is pinned through `windowStart`. Desynchronising it
//     from PAGE_SIZE makes _mountPagedSource() compute `target * this.pageSize`
//     with the wrong divisor, so windowStart lands outside the thread (4000 in a
//     700-frame session) while the DOM still starts at a real frame. The
//     `windowStart === firstMountedIndex` identity catches that.
//   * PAGE_SIZE is pinned through the mounted count. It is the governor, so
//     raising it to cover the whole fixture makes one server page hold every
//     frame and the idle window becomes the entire thread. That is asserted
//     from the DOM (see `boundedWindowMessage`), not from a source-vs-fixture
//     comparison — a numeric guard would fire before the browser starts and
//     would prove nothing about what the product mounts.
//
// What the spec pins, all of it observable and true in every settled state:
//   1. the window is strictly smaller than the thread (no whole-thread mount),
//      and the oldest frame is absent while the newest is present;
//   2. `windowStart` is the index of the first frame actually in the DOM. This
//      is the documented meaning of the getter (spec/client/chat-view-window-spec
//      asserts the same identity);
//   3. scrolling up with a REAL gesture reveals the oldest frame and the whole
//      thread fits under MAX_TOTAL_RENDERED_FRAMES;
//   4. returning to the bottom keeps the newest frame mounted.
//
// WHY 700 FRAMES
// With 140 frames two pages hold the entire thread, so "bounded" was true only
// during a ~300 ms transient and the spec was intermittently red. At 700 frames
// (6 pages at the shipped page size) the window is bounded in every state, so no
// sample timing is load-bearing and there are no fixed sleeps. The idle window
// settles at 460 items (4 pages of read-ahead) and holds there: 59 samples over
// 12 s, peak 460, frame 0 never mounted.
//
// WHY NO FIXTURE GUARD AGAINST A LARGE PAGE_SIZE
// The spec previously aborted with "the fixture must span more than two pages"
// before launching a browser. That guard fired under the PAGE_SIZE 120 -> 800
// mutation in 1.8 ms and hid the fact that the mutation changes what the product
// mounts. PAGE_SIZE is the constant under test, so the spec must observe the DOM
// under whatever page size is configured and report the result.
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

const MAX_RENDERED_FRAMES = numericConstant(
  CHAT_VIEW_SOURCE, 'export const MAX_RENDERED_FRAMES = (\\d+);', 'MAX_RENDERED_FRAMES');
const MAX_TOTAL_RENDERED_FRAMES = numericConstant(
  CHAT_VIEW_SOURCE, 'export const MAX_TOTAL_RENDERED_FRAMES = (\\d+);', 'MAX_TOTAL_RENDERED_FRAMES');
const PAGE_SIZE = numericConstant(
  SCROLLVIEW_SOURCE, 'const PAGE_SIZE = (\\d+);', 'PAGE_SIZE');

// Six pages at the shipped page size: enough that the window is bounded by page
// arithmetic in every state, and small enough that the reveal can materialise
// the whole thread without hitting eviction.
const FRAME_COUNT = 700;

// When the configured page size covers the whole fixture, one server page holds
// every frame and the page source mounts the entire thread. The flag selects the
// failure message; it never skips an assertion.
const SINGLE_PAGE_THREAD = PAGE_SIZE >= FRAME_COUNT;

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

// Polls until the mounted count has not changed for `quietMs`, so the settled
// assertions describe the idle read-ahead rather than a mid-load frame. This is
// a settle (wait for silence), not a fixed sleep (guess a duration): at 700
// frames the count reaches 460 by ~1.7 s and then holds for 12 s.
async function settledSnapshot(page, { quietMs = 1200, timeoutMs = 20000, pollMs = 100 } = {}) {
  let deadline = Date.now() + timeoutMs;
  let last = await snapshot(page);
  let quietSince = Date.now();
  while (Date.now() < deadline) {
    await delay(pollMs);
    let next = await snapshot(page);
    if (next.count !== last.count) {
      quietSince = Date.now();
      last = next;
      continue;
    }
    last = next;
    if (Date.now() - quietSince >= quietMs) return next;
  }
  return last;
}

// One message for both bounded-window assertions, so a PAGE_SIZE regression
// names the governor instead of reading like a generic count mismatch.
function boundedWindowMessage(state, label) {
  if (SINGLE_PAGE_THREAD)
    return `${label}: the window holds the whole thread (${state.count} === ${FRAME_COUNT}) `
      + `because the configured PAGE_SIZE (${PAGE_SIZE}) covers the fixture, so one server page `
      + 'holds every frame. PAGE_SIZE governs the mount on this path: a page size at or above the '
      + 'thread length disables windowing entirely. '
      + `(MAX_RENDERED_FRAMES is ${MAX_RENDERED_FRAMES} and does not bound this path.)`;
  return `${label}: the window is smaller than the thread (${state.count} < ${FRAME_COUNT}); `
    + 'mounting every historical frame means the window is not bounded';
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

  // The reveal assertions assume the whole thread fits under the hard cap. This
  // is a fixture/cap relationship, not the constant under test.
  assert.ok(FRAME_COUNT <= MAX_TOTAL_RENDERED_FRAMES,
    `the fixture (${FRAME_COUNT}) must fit under MAX_TOTAL_RENDERED_FRAMES (${MAX_TOTAL_RENDERED_FRAMES})`);

  if (SINGLE_PAGE_THREAD)
    t.diagnostic(`PAGE_SIZE ${PAGE_SIZE} >= fixture ${FRAME_COUNT}: the whole thread is one server page`);

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
    // No sleep: every assertion here holds while only the tail page is mounted
    // and after the idle read-ahead has added older pages.
    let initial = await snapshot(page);
    assert.equal(initial.usesPagedScrollview, true, 'the thread runs on the shared paged scrollview');
    assert.ok(initial.count > 0, 'the thread mounts at least one frame');
    assert.equal(initial.distinct, initial.count, 'no frame is mounted twice');
    assert.ok(initial.count < FRAME_COUNT, boundedWindowMessage(initial, 'the initial window is bounded'));
    assert.equal(initial.ids.at(-1), newestID, 'the newest frame is mounted at the bottom');
    assert.equal(initial.ids.includes(oldestID), false,
      'the oldest frame is not in the initial DOM');
    assert.equal(initial.windowStart, initial.firstMountedIndex,
      `windowStart names the first mounted frame (windowStart ${initial.windowStart} === first mounted ${initial.firstMountedIndex}); `
      + 'a mismatch means the render window and the page arithmetic disagree');

    // --- settled idle window --------------------------------------------------
    // Stronger than the initial snapshot: the idle read-ahead must still leave
    // the window bounded once it stops growing. This is the assertion that
    // PAGE_SIZE 120 -> 800 breaks (one page then holds all 700 frames), and it
    // is evaluated from the DOM rather than from a source-vs-fixture comparison.
    let settled = await settledSnapshot(page);
    assert.ok(settled.count < FRAME_COUNT, boundedWindowMessage(settled, 'the settled idle window is bounded'));
    assert.equal(settled.distinct, settled.count, 'the idle read-ahead does not duplicate frames');
    assert.equal(settled.ids.includes(oldestID), false,
      'the oldest frame is not mounted once the idle read-ahead settles');
    assert.equal(settled.windowStart, settled.firstMountedIndex,
      `windowStart still names the first mounted frame when idle (windowStart ${settled.windowStart} === first mounted ${settled.firstMountedIndex})`);

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
