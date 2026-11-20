'use strict';

// Owner report (2026-11-05), screenshot session-2026-11-05-17-12-30:
//   1. "When it is pinned/locked to the bottom, and I send a message, it
//      breaks (even though the icon still claims it is pinned)" — with a live
//      agent answering every send (tall, streaming replies), the bottom-align
//      driver (aims at the LAST FRAME'S TOP) and the settle tick (aims at the
//      DOCUMENT BOTTOM) alternated for frames taller than the viewport; each
//      write re-armed an ignore window so real user scrolls stopped
//      registering, and the viewport could strand mid-thread with the lock on.
//      Kikx's raw writes also weren't marked programmatic for the shared view,
//      so a warm intent window could silently drop `follow` while the lock
//      icon stayed pressed.
//   2. "ANY scroll from me, up or down, should unpin" — bottom-lock release
//      only listened for UPWARD movement, so scrolling DOWN out of a broken
//      pin left it stuck.
//   3. "sending a message appears to trigger it almost every time".
//
// The hash leg pins the deep-link poison the screenshot shows: at the bottom
// the hash read "#message=<old-id>&bottom=1" (a content-visibility
// placeholder straddling the viewport top won the rect walk), which a later
// hash restore could slam back to.
//
// The repro is the owner's shape: wheel to bottom (auto-lock), then repeated
// sends each answered by a TALL streaming reply, asserting every time that
// geometry, follow, the lock icon and the hash all still agree.

import assert from 'node:assert/strict';
import test from 'node:test';

import puppeteer from 'puppeteer-core';

import { findChromeExecutable, startStagehandUIServer, waitForScrollviewSettled } from '../stagehand/stagehand-test-utils.mjs';

const SESSION = 'session_sendpin';

function frame(id, order, type, text) {
  const timestamp = 1793328600000000 + order * 1000000;
  return {
    id,
    type,
    sessionID: SESSION,
    interactionID: `sp_i_${order}`,
    authorType: type === 'UserMessage' ? 'user' : 'agent',
    authorID: type === 'UserMessage' ? 'owner' : 'agent_1',
    authorDisplayName: type === 'UserMessage' ? 'Wyatt' : 'Miri',
    hidden: false,
    deleted: false,
    order,
    timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
    content: { text },
  };
}

test('Puppeteer: bottom pin survives sends with tall streaming replies; any user scroll unpins', async (t) => {
  let chromePath = findChromeExecutable();
  if (!chromePath) {
    t.skip('Puppeteer send-pin coverage requires Chrome');
    return;
  }

  const fixture = await startStagehandUIServer({
    sessions: [ { id: SESSION, title: 'Send Pin', messageCount: 300 } ],
    agents: [ { id: 'agent_1', name: 'Miri', pluginID: 'test-agent', enabled: true } ],
  });
  fixture.frameRuntime.framesBySessionID.set(SESSION, Array.from({ length: 300 }, (_value, index) =>
    frame(`s_${index + 1}`, index + 1, 'AgentMessage', `Message ${index + 1}: ${'body words '.repeat(8)}`)));

  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: process.env.KIKX_PUPPETEER_HEADLESS === '0' ? false : 'new',
    args: [ '--no-sandbox', '--disable-setuid-sandbox' ],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.evaluateOnNewDocument(() => {
      sessionStorage.setItem('kikx.auth.session', JSON.stringify({ token: 't', refresh_token: 'r', expires_at: Date.now() + 86_400_000 }));
    });
    await page.goto(`http://127.0.0.1:${new URL(fixture.baseURL).port}/?session=${SESSION}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForSelector('.kikx-thread-scrollview', { timeout: 15000 });
    // 300 frames mount as several lazy pages. The 14 x 600px wheel budget below
    // only reaches the bottom if the thread has stopped growing first; under
    // parallel load a fixed 800ms did not guarantee that, so the gesture chased
    // a moving bottom and auto-lock never engaged.
    await waitForScrollviewSettled(page);

    const snap = () => page.evaluate(() => {
      const app = document.querySelector('kikx-app');
      const list = document.querySelector('.kikx-frame-list');
      const host = list?.closest('aeor-scrollview');
      const lock = document.querySelector('.kikx-session-toolbar__button--lock');
      const items = [ ...document.querySelectorAll('kikx-frame-item') ];
      const last = items.at(-1);
      const lr = list.getBoundingClientRect();
      const fr = last ? last.getBoundingClientRect() : null;
      return {
        near: Math.round(list.scrollHeight - list.scrollTop - list.clientHeight),
        follow: host?.follow ?? null,
        lock: lock?.getAttribute('aria-pressed') ?? 'missing',
        lockIcon: lock?.dataset?.icon ?? null,
        lastId: last?.dataset?.frameId || null,
        visualGap: fr ? Math.round(fr.bottom - lr.bottom) : null,
        hashFrame: /(?:^#|&)message=([^&]+)/.exec(location.hash)?.[1] ?? null,
        hashBottom: /(?:^#|&)bottom=(1|0)(?:&|$)/.exec(location.hash)?.[1] ?? null,
      };
    });

    const assertPinned = async (label) => {
      // Live frames can be queued behind the tail page and flush after quiet;
      // each flush's settle write re-arms the debounced hash rewrite, so the
      // honest hash converges a beat later. Wait for it — the equality below
      // still fails if it never does.
      await page.waitForFunction(() => {
        const last = [ ...document.querySelectorAll('kikx-frame-item') ].at(-1)?.dataset?.frameId || null;
        const hash = /(?:^#|&)message=([^&]+)/.exec(location.hash)?.[1] ?? null;
        return last && hash === last;
      }, { timeout: 3000 }).catch(() => {});
      const s = await snap();
      assert.ok(s.near <= 40, `${label}: metrics must say bottom (near=${s.near})`);
      assert.ok(Math.abs(s.visualGap) <= 60, `${label}: the newest frame must sit at the viewport edge (gap=${s.visualGap})`);
      assert.equal(s.follow, true, `${label}: the shared view must still be following`);
      assert.equal(s.lock, 'true', `${label}: the lock must still be pressed`);
      assert.equal(s.lockIcon, 'lock-locked', `${label}: the icon must match the pressed state`);
      assert.equal(s.hashFrame, s.lastId,
        `${label}: the hash must name the NEWEST frame, not a placeholder-straddling stale one (hash=${s.hashFrame}, last=${s.lastId})`);
      return s;
    };

    // Wheel to the bottom: auto-lock engages on a real gesture.
    await page.mouse.move(640, 400);
    for (let i = 0; i < 14; i++) {
      await page.mouse.wheel({ deltaY: 600 });
      await new Promise((resolve) => setTimeout(resolve, 90));
    }
    // The gesture itself triggers lazy loads; judge the lock only once the
    // viewport has stopped moving and growing.
    await waitForScrollviewSettled(page);
    await assertPinned('after wheel-to-bottom');

    // Sends with TALL streaming replies — the shape that broke for the owner.
    let replyOrder = 400;
    const liveFrame = (id, type, text) => {
      replyOrder += 1;
      return frame(id, replyOrder, type, text);
    };
    for (let round = 1; round <= 3; round++) {
      await page.click('textarea[name="message"]');
      await page.type('textarea[name="message"]', `send ${round}`);
      await page.keyboard.press('Enter');
      await new Promise((resolve) => setTimeout(resolve, 450));

      const replyId = `reply_${round}`;
      fixture.frameRuntime.emitEvent('frame.added', { sessionID: SESSION, frame: liveFrame(replyId, 'AgentMessage', 'thinking…') });
      let grown = '';
      const stream = setInterval(() => {
        grown += `paragraph: ${'this reply is deliberately taller than the viewport so bottom-align and bottom-settle disagree '.repeat(4)}\n\n`;
        fixture.frameRuntime.emitEvent('frame.updated', { sessionID: SESSION, frame: { ...liveFrame(replyId, 'AgentMessage', grown), id: replyId } });
        if (Math.random() < 0.3) {
          fixture.frameRuntime.emitEvent('frame.added', { sessionID: SESSION, frame: liveFrame(`tool_${round}_${replyOrder}`, 'ToolCallFrame', `tool output ${replyOrder}`) });
        }
      }, 140);
      await new Promise((resolve) => setTimeout(resolve, 2400));
      clearInterval(stream);
      await new Promise((resolve) => setTimeout(resolve, 600));
      await assertPinned(`after send ${round} with a tall streaming reply`);
    }

    // ---- Complaint 2: ANY user scroll unpins -----------------------------
    // (a) wheel UP
    await page.mouse.move(640, 400);
    await page.mouse.wheel({ deltaY: -500 });
    await new Promise((resolve) => setTimeout(resolve, 450));
    let after = await snap();
    assert.equal(after.follow, false, 'wheel-up must release follow');
    assert.equal(after.lock, 'false', 'wheel-up must release the lock');

    // (b) back to the bottom re-locks (auto-lock at bottom is product behavior)
    for (let i = 0; i < 8; i++) {
      await page.mouse.wheel({ deltaY: 600 });
      await new Promise((resolve) => setTimeout(resolve, 90));
    }
    await waitForScrollviewSettled(page);
    after = await snap();
    assert.equal(after.lock, 'true', 'reaching the bottom auto-locks again');

    // (c) wheel DOWN out of a broken pin (positioned above the bottom while
    //     locked) — the old bottom-mode rule only listened for upward moves.
    //
    // Writing scrollTop alone cannot build this state: while the vendor follow
    // driver is engaged it re-pins immediately. Measured on the previous form
    // of this step — the raw write to near=500 was back at near=3 within 250ms
    // via 14 programmatic re-pin scroll events — so the wheel below had no
    // distance left to travel and correctly left the lock pressed. Release
    // follow through its public accessor first (the state a user scroll
    // leaves behind), keep the lock, and only measure once the position holds.
    const brokenPinTop = await page.evaluate(() => {
      const list = document.querySelector('.kikx-frame-list');
      list.closest('aeor-scrollview').follow = false;
      const target = Math.max(0, list.scrollHeight - list.clientHeight - 500);
      list.scrollTop = target;
      return target;
    });
    // Puppeteer's signature is waitForFunction(predicate, options, ...args).
    // Passing the argument second made `target` the options object, so
    // Math.abs(scrollTop - {timeout}) was NaN and the predicate could never be
    // true: it burned the 30s default and reported nothing useful. Options
    // first, argument third, and a failure that names the measured state.
    await page.waitForFunction((target) => {
      const list = document.querySelector('.kikx-frame-list');
      return list.closest('aeor-scrollview').follow === false
        && Math.abs(list.scrollTop - target) <= 2;
    }, { timeout: 5000 }, brokenPinTop).catch(async () => {
      const state = await page.evaluate(() => {
        const list = document.querySelector('.kikx-frame-list');
        return { top: Math.round(list.scrollTop), follow: list.closest('aeor-scrollview').follow };
      });
      throw new Error(`the broken-pin setup did not hold: target=${brokenPinTop} actual=${JSON.stringify(state)}`);
    });
    after = await snap();
    assert.ok(after.near >= 400,
      `the broken-pin setup must leave the view above the bottom (near=${after.near})`);
    assert.equal(after.lock, 'true',
      'the setup must still be locked, otherwise this step tests nothing');
    await page.mouse.move(640, 400);
    await page.mouse.wheel({ deltaY: 400 });
    await new Promise((resolve) => setTimeout(resolve, 450));
    after = await snap();
    assert.equal(after.lock, 'false', 'a scroll DOWN away from the bottom must unpin too');
    assert.equal(after.follow, false, 'follow must go with it');

    // (d) keyboard scroll from the bottom
    for (let i = 0; i < 8; i++) {
      await page.mouse.wheel({ deltaY: 600 });
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    await waitForScrollviewSettled(page);
    // The keyboard step only means something from a genuine bottom pin. Without
    // this guard it was flaky for the wrong reason: streaming replies can grow
    // the list while the wheel loop runs, so on some runs the viewport never
    // reached the bottom, follow was already false, and the test passed while
    // PageUp was never actually exercised.
    after = await snap();
    assert.ok(after.near <= 40, `the keyboard step must start at the bottom (near=${after.near})`);
    assert.equal(after.follow, true, 'the keyboard step must start while still following');
    assert.equal(after.lock, 'true', 'the keyboard step must start from a pressed lock');
    await page.evaluate(() => document.querySelector('.kikx-frame-list')?.focus?.());
    await page.keyboard.press('PageUp');
    // Wait for the effect instead of assuming a fixed 450ms is enough.
    await page.waitForFunction(
      () => document.querySelector('.kikx-frame-list')?.closest('aeor-scrollview')?.follow === false,
      { timeout: 3000 },
    ).catch(() => {});
    after = await snap();
    assert.equal(after.follow, false,
      `a keyboard PageUp must release follow (near=${after.near}, top=${after.scrollTop})`);
    assert.equal(after.lock, 'false', 'a keyboard PageUp must release the lock');
  } finally {
    await browser.close();
    await fixture.close();
  }
});
