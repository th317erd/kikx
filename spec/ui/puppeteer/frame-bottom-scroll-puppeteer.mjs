'use strict';

// Regression guard for the last card's bottom border being clipped at the
// bottom of the thread. Layout is fractional while scrollTop is clamped to an
// integer, so scrolling to `scrollHeight - clientHeight` can leave the final
// border a fraction below the viewport. The stream has 1px of bottom padding so
// the border survives that clamp; the pinned thinking rack changes the list
// height and must not reintroduce the clipping.
//
// Scroll position is driven by `_scrollFramesToBottomImmediate`, not
// `_scrollFramesToBottom`. The latter only sets the follow anchor and schedules
// an rAF easing loop (`followFrameListToBottom` in kikx-frame-scroll.mjs), so it
// returns before `scrollTop` is written. Measuring in the same evaluate would
// read pre-scroll geometry, making this guard pass or fail on whether the list
// happened to already be at the bottom after load. Awaiting that loop also
// works, but only after a fixed sleep; measured both ways, the assertions below
// are unchanged and only the scroll mechanism differs. The immediate variant
// writes `scrollTop` with the same `scrollHeight - clientHeight` clamp this
// guard is about, and production uses it on the same path
// (kikx-frame-scroll.mjs:186, :197, :460 and kikx-frame-scroll-lock.mjs:335).

import assert from 'node:assert/strict';
import test from 'node:test';

import puppeteer from 'puppeteer-core';

import {
  findChromeExecutable,
  startStagehandUIServer,
} from '../stagehand/stagehand-test-utils.mjs';

function messageFrame(index, timestamp) {
  return {
    id: `scroll_msg_${index}`,
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
    content: { status: 'complete', text: `Message ${index}\n${'body text '.repeat(18)}` },
  };
}

test('Puppeteer keeps the last card border inside the scrolled thread', async (t) => {
  let chromePath = findChromeExecutable();
  if (!chromePath) {
    t.skip('Puppeteer local smoke requires Chrome');
    return;
  }

  let fixture = await startStagehandUIServer({
    sessions: [ { id: 'session_1', title: 'Bottom Scroll', messageCount: 24 } ],
  });
  let timestamp = 1781035260000000;
  fixture.frameRuntime.framesBySessionID.set('session_1',
    Array.from({ length: 24 }, (_value, index) => messageFrame(index, timestamp + index * 1000)));

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
    await page.waitForSelector('kikx-frame-item[data-frame-id="scroll_msg_23"]', { timeout: 15000 });

    let measure = () => page.evaluate(() => {
      let app = document.querySelector('kikx-app');
      if (typeof app._scrollFramesToBottomImmediate !== 'function')
        throw new Error('kikx-app no longer exposes _scrollFramesToBottomImmediate');

      app._scrollFramesToBottomImmediate();
      let list = app.querySelector('.kikx-frame-list');
      let last = app.querySelector('kikx-frame-item[data-frame-id="scroll_msg_23"]');
      let listRect = list.getBoundingClientRect();
      let lastRect = last.getBoundingClientRect();
      return {
        remaining: list.scrollHeight - list.scrollTop - list.clientHeight,
        lastBottom: lastRect.bottom,
        listBottom: listRect.bottom,
      };
    });

    let withoutRack = await measure();
    assert.ok(withoutRack.remaining <= 1, 'the thread reaches its bottom');
    assert.ok(withoutRack.lastBottom <= withoutRack.listBottom + 0.01,
      `the last border is clipped by ${Math.round((withoutRack.lastBottom - withoutRack.listBottom) * 100) / 100}px`);

    await page.evaluate(() => {
      let app = document.querySelector('kikx-app');
      let sessionID = app._state.selectedSessionID;
      for (let frame of [
        { id: 'scroll_probe:typing', type: 'BeginTyping', phantom: true, responseFrameID: 'scroll_probe', content: { agentID: 'agent_1', agentName: 'Zav' } },
        { id: 'scroll_probe:thinking', type: 'AgentThinking', phantom: true, responseFrameID: 'scroll_probe', content: { text: 'thinking under the thread' } },
      ]) {
        app._onRuntimeEvent({ data: JSON.stringify({ type: 'frame.phantom', sessionID, frame: { sessionID, ...frame } }) });
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(await page.evaluate(() => document.querySelector('kikx-thinking-rack')?.hidden), false, 'the rack is visible');

    let withRack = await measure();
    assert.ok(withRack.remaining <= 1, 'the thread still reaches its bottom with the rack visible');
    assert.ok(withRack.lastBottom <= withRack.listBottom + 0.01,
      `the rack clips the last border by ${Math.round((withRack.lastBottom - withRack.listBottom) * 100) / 100}px`);
  } finally {
    await browser.close().catch(() => {});
    await fixture.close().catch(() => {});
  }
});
