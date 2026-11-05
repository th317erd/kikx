'use strict';

// Mobile bottom-follow gesture stability (owner report, 2026-11-05:
// "This scrollview isn't working very well for mobile. It is glitching a
// lot.").
//
// The reproduced mechanism (Puppeteer, 390x844 touch, instrumented run):
// at the bottom with follow on and a live stream arriving, every live sync
// re-pinned the viewport (KikxChatScrollView.pinToEnd -> scrollToEnd immediate
// write), the 250ms aeor settle tick animated a second pull, and the focus
// driver aimed a third way — while each programmatic write re-armed aeor's
// 120ms ignore-scroll window, so _onScroll classified the user's OWN touch
// scrolls as programmatic and follow never released. Result: a ~±1000px
// three-way sawtooth for as long as the stream ran (24 in-touch writes in the
// instrumented repro).
//
// The fix is "user gesture wins": aeor gates every bottom-yank path on
// `userGestureActive` (finger down or inside the input grace window), which
// lets the first drag-away scroll event reach the existing follow-release
// logic; Kikx's pin declines during a gesture and falls through to the anchor
// restore, and the focus driver parks on a slow timer until release.
//
// What this pins, on the real touch path:
//   1. zero programmatic scrollTop writes while a finger is down;
//   2. the drag moves the viewport monotonically (no snap-backs mid-gesture);
//   3. follow releases during the drag;
//   4. the position HOLDS — no late re-pin — while frames keep streaming and
//      after the stream stops;
//   5. no single-frame jump >= 60px anywhere in the scenario.

import assert from 'node:assert/strict';
import test from 'node:test';

import puppeteer from 'puppeteer-core';

import { findChromeExecutable, startStagehandUIServer } from '../stagehand/stagehand-test-utils.mjs';

const SESSION = 'session_follow_gesture';
const LIVE_FRAMES = 300;
const INJECTED = 36;

function frame(order, text) {
  const timestamp = 1793328600000000 + order * 1000000;
  return {
    id: `fg_${order}`,
    type: 'AgentMessage',
    sessionID: SESSION,
    interactionID: `fg_i_${order}`,
    authorType: 'agent',
    authorID: 'agent_1',
    authorDisplayName: 'Agent',
    hidden: false,
    deleted: false,
    order,
    timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
    content: { text },
  };
}

test('Puppeteer mobile: a drag at the bottom is never fought by the live follow', async (t) => {
  let chromePath = findChromeExecutable();
  if (!chromePath) {
    t.skip('Puppeteer bottom-follow gesture coverage requires Chrome');
    return;
  }

  const fixture = await startStagehandUIServer({
    sessions: [ { id: SESSION, title: 'Follow gesture', messageCount: LIVE_FRAMES } ],
  });
  const initial = Array.from({ length: LIVE_FRAMES }, (_value, index) =>
    frame(index + 1, `Frame ${index + 1}: ${'stable message body '.repeat(6)}`));
  fixture.frameRuntime.framesBySessionID.set(SESSION, initial);

  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: process.env.KIKX_PUPPETEER_HEADLESS === '0' ? false : 'new',
    args: [ '--no-sandbox', '--disable-setuid-sandbox' ],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1');
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(String(error).slice(0, 200)));

    await page.evaluateOnNewDocument(() => {
      sessionStorage.setItem('kikx.auth.session', JSON.stringify({ token: 'fg-token', refresh_token: 'fg-refresh' }));

      const P = window.__fg = { touchActive: false, touchEndAt: -1e9, progWrites: [], jumps: [] };
      const now = () => performance.now();
      const inTouch = () => P.touchActive || (now() - P.touchEndAt) < 400;
      addEventListener('touchstart', () => { P.touchActive = true; }, true);
      for (const type of [ 'touchend', 'touchcancel' ])
        addEventListener(type, () => { P.touchActive = false; P.touchEndAt = now(); }, true);

      // Any write through the scrollTop setter is programmatic — native touch
      // scrolling never goes through it.
      const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
      Object.defineProperty(Element.prototype, 'scrollTop', {
        configurable: true,
        get() { return descriptor.get.call(this); },
        set(value) {
          if (descriptor.get.call(this) !== value) {
            P.progWrites.push({
              inTouch: inTouch(),
              stack: new Error().stack.split('\n').slice(2, 6).join(' | '),
            });
          }
          return descriptor.set.call(this, value);
        },
      });

      let last = null;
      const sample = () => {
        const list = document.querySelector('.kikx-frame-list');
        if (list) {
          const top = list.scrollTop;
          if (last != null && Math.abs(top - last) >= 60)
            P.jumps.push({ from: last, to: top, inTouch: inTouch() });
          last = top;
        }
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });

    await page.goto(`http://127.0.0.1:${new URL(fixture.baseURL).port}/?session=${SESSION}`, {
      waitUntil: 'domcontentloaded',
      timeout: 15000,
    });
    await page.waitForSelector('.kikx-thread-scrollview', { timeout: 15000 });

    // Let the startup page-load storm settle before instrumenting the scenario.
    let previous = null;
    let stable = 0;
    for (let attempt = 0; attempt < 100 && stable < 12; attempt++) {
      const snapshot = await page.evaluate(() =>
        JSON.stringify(document.querySelector('kikx-app')._renderStats) + ':' +
        (document.querySelector('.kikx-frame-list')?.scrollTop ?? -1));
      if (snapshot === previous) stable += 1;
      else { stable = 0; previous = snapshot; }
      await new Promise((resolve) => setTimeout(resolve, 80));
    }

    const scrollTop = () => page.evaluate(() => document.querySelector('.kikx-frame-list')?.scrollTop ?? null);
    const followState = () => page.evaluate(() =>
      document.querySelector('.kikx-frame-list')?.closest('aeor-scrollview')?.follow ?? null);
    const resetProbe = () => page.evaluate(() => {
      window.__fg.progWrites.length = 0;
      window.__fg.jumps.length = 0;
    });

    // Approach the bottom from above WITH A REAL TOUCH: _onScroll only turns
    // follow on for a user scroll that lands at max (it needs the intent
    // window), and the whole scenario is about follow being on when the
    // stream starts. A raw jump to max would leave follow off and let the old
    // bug pass vacuously.
    await page.evaluate(() => {
      const list = document.querySelector('.kikx-frame-list');
      list.scrollTop = Math.max(0, list.scrollHeight - list.clientHeight - 3000);
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    async function swipe(yFrom, yTo, { steps = 16, stepMs = 14 } = {}) {
      const x = 195;
      await page.touchscreen.touchStart(x, yFrom);
      for (let index = 1; index <= steps; index++) {
        await page.touchscreen.touchMove(x, Math.round(yFrom + (yTo - yFrom) * (index / steps)));
        await new Promise((resolve) => setTimeout(resolve, stepMs));
      }
      await page.touchscreen.touchEnd();
    }
    // Touch travel is not 1:1 with pixels: swipe until native scrolling lands
    // on the bottom, so the final scroll event (with intent) sets follow.
    for (let attempt = 0; attempt < 14; attempt++) {
      const distance = await page.evaluate(() => {
        const list = document.querySelector('.kikx-frame-list');
        return Math.max(0, list.scrollHeight - list.clientHeight) - list.scrollTop;
      });
      if (distance <= 4)
        break;
      await swipe(650, 120, { steps: 20, stepMs: 10 });
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    await resetProbe();
    const bottomAtStart = await scrollTop();
    const distanceFromBottom = await page.evaluate(() => {
      const list = document.querySelector('.kikx-frame-list');
      return Math.max(0, list.scrollHeight - list.clientHeight) - list.scrollTop;
    });
    assert.ok(distanceFromBottom <= 4, `the reader parked at the bottom (distance=${distanceFromBottom})`);
    assert.ok(await followState() === true, 'the reader starts in follow mode at the bottom');

    let order = LIVE_FRAMES;
    const injector = setInterval(() => {
      order += 1;
      if (order > LIVE_FRAMES + INJECTED) return;
      fixture.frameRuntime.emitEvent('frame.added', {
        sessionID: SESSION,
        frame: frame(order, `LIVE ${order}: ${'streaming chunk '.repeat(8)}`),
      });
    }, 110);

    const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    // Phase 1: swipe TOWARD the growing stream while parked at the bottom.
    // Releasing follow is impossible here (the delta is positive), so on the
    // old code this is the deterministic three-way storm: pin ↔ settle ↔ focus
    // with stale targets, all writing under the finger (24 in-touch writes in
    // the instrumented repro). Gesture supremacy must make it exactly zero.
    await swipe(650, 250);
    await settle(150);
    await swipe(650, 250);
    await settle(300);

    // Phase 2: finger DOWN = toward OLDER content = escaping the bottom while
    // frames stream in underneath. This direction must win monotonically and
    // release follow. Each drag retries until it MOVES: under a parallel test
    // batch a single touchscreen gesture can get coalesced away, and a dropped
    // gesture is not the bug this pins.
    async function dragOlder(previousTop) {
      for (let attempt = 0; attempt < 3; attempt++) {
        await swipe(250, 650);
        await settle(120);
        const top = await scrollTop();
        if (top <= previousTop - 50)
          return top;
      }
      return await scrollTop();
    }
    const afterSwipe1 = await dragOlder(bottomAtStart);
    await settle(150);
    const afterSwipe2 = await dragOlder(afterSwipe1);
    await settle(150);
    const afterSwipe3 = await dragOlder(afterSwipe2);
    await settle(400);

    const follow = await followState();
    const probe = await page.evaluate(() => ({
      progWrites: window.__fg.progWrites,
      jumps: window.__fg.jumps,
    }));

    // The stream keeps running through the idle window: the position must hold.
    await settle(1400);
    const afterIdleStreaming = await scrollTop();
    clearInterval(injector);
    await settle(1200);
    const afterStreamStopped = await scrollTop();

    const finalProbe = await page.evaluate(() => ({
      progWrites: window.__fg.progWrites,
      jumps: window.__fg.jumps,
    }));
    const errors = pageErrors.slice();

    // 1. Nothing writes scrollTop while a finger is down.
    const writesDuringTouch = finalProbe.progWrites.filter((write) => write.inTouch);
    assert.deepEqual(writesDuringTouch, [],
      `no programmatic writes under a finger; saw ${JSON.stringify(writesDuringTouch.slice(0, 3))}`);

    // 2. The drag wins monotonically: each swipe moves into older content and
    //    nothing snaps back mid-gesture.
    assert.ok(afterSwipe1 < bottomAtStart - 50,
      `the first drag must move the viewport (bottom=${bottomAtStart}, after=${afterSwipe1})`);
    assert.ok(afterSwipe2 < afterSwipe1, `second drag must continue (after1=${afterSwipe1}, after2=${afterSwipe2})`);
    assert.ok(afterSwipe3 < afterSwipe2, `third drag must continue (after2=${afterSwipe2}, after3=${afterSwipe3})`);

    // 3. Follow releases — the mechanism that was previously blinded by the
    //    ignore-scroll windows.
    assert.equal(follow, false, 'dragging away from the bottom must release follow');

    // 4. The position holds while frames keep streaming, and after they stop:
    //    no late re-pin to the (now much taller) bottom. A small correction is
    //    legitimate — the anchor re-seats by ~one frame when the bounded state
    //    window trims its head — but a follow re-pin would move by THOUSANDS
    //    of pixels as the stream grows the bottom.
    const HOLD_TOLERANCE_PX = 150;
    assert.ok(Math.abs(afterIdleStreaming - afterSwipe3) <= HOLD_TOLERANCE_PX,
      `position must hold under the ongoing stream (swipe3=${afterSwipe3}, idle=${afterIdleStreaming})`);
    assert.ok(Math.abs(afterStreamStopped - afterSwipe3) <= HOLD_TOLERANCE_PX,
      `no re-pin after the stream stops (swipe3=${afterSwipe3}, stopped=${afterStreamStopped})`);

    // 5. No mid-gesture snap anywhere (the ±1000px sawtooth class), and no
    //    large out-of-gesture jump afterwards (a bottom re-pin would move by
    //    thousands of pixels as the stream grows; small anchor re-seats do not
    //    count).
    const midGestureJumps = finalProbe.jumps.filter((jump) => jump.inTouch);
    assert.deepEqual(midGestureJumps, [],
      `no >=60px single-frame snaps under a finger; saw ${JSON.stringify(midGestureJumps.slice(0, 3))}`);
    const bigJumps = finalProbe.jumps.filter((jump) => !jump.inTouch && Math.abs(jump.delta ?? (jump.to - jump.from)) >= 400);
    assert.deepEqual(bigJumps, [],
      `no bottom re-pin jumps after the gesture; saw ${JSON.stringify(bigJumps.slice(0, 3))}`);

    assert.deepEqual(errors, [], `no page errors: ${errors.join(' | ')}`);
    // The instrumented counters from the mid-scenario read must agree with the
    // final ones (nothing slipped in between the two snapshots).
    assert.equal(probe.progWrites.length, finalProbe.progWrites.length);
  } finally {
    await browser.close();
    await fixture.close();
  }
});
