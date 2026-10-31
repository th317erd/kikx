'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import puppeteer from 'puppeteer-core';

import {
  findChromeExecutable,
  startStagehandUIServer,
} from '../stagehand/stagehand-test-utils.mjs';

// Regression guard for the "commit storm freezes the browser" defect.
//
// The server emits per-frame events (frame.added / frame.updated / frame.phantom)
// AND a `commit` event for every commit. The client used to fall through to a
// whole-app `_render()` for `commit`, which rebuilt the entire shell (and re-ran
// the markdown renderer for every frame) on every streamed delta -- pegging the
// main thread. `commit` is informational: it must never rebuild the view.
//
// This test fires a synchronous burst of `commit` events (exactly what streaming
// produces) and asserts the thread DOM is NOT rebuilt and the scroll position is
// NOT disturbed.
test('Puppeteer commit bursts do not rebuild the thread or move the viewport', async (t) => {
  let chromePath = findChromeExecutable();
  if (!chromePath) {
    t.skip('Puppeteer local smoke requires Chrome');
    return;
  }

  let fixture = await startStagehandUIServer({
    sessions: [
      { id: 'session_1', title: 'Commit Storm', messageCount: 24 },
    ],
    agents: [
      { id: 'agent_commit', name: 'Commit Agent', pluginID: 'test-agent', enabled: true },
    ],
  });
  let frames = createFrames(24);
  fixture.frameRuntime.framesBySessionID.set('session_1', frames);

  let browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: process.env.KIKX_PUPPETEER_HEADLESS === '0' ? false : 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
    ],
  });

  try {
    let page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    // Kikx gates its initial load on a session token read from sessionStorage at
    // module load (Kikx-native auth), so seed one before the app boots; the
    // fixture's auth stub accepts any token.
    await page.evaluateOnNewDocument(() => {
      sessionStorage.setItem('kikx.auth.session', JSON.stringify({ token: 'puppeteer-test-token', refresh_token: 'puppeteer-test-refresh' }));
    });

    await page.goto(`${fixture.baseURL}/?view=thread`, {
      waitUntil: 'domcontentloaded',
      timeout: 10000,
    });
    await page.waitForSelector('kikx-frame-item[data-frame-id="frame_24"]', { timeout: 10000 });
    await page.waitForSelector('.kikx-frame-list', { timeout: 10000 });

    // Wait until the live SSE stream is connected so a later assertion of "no
    // change" cannot pass merely because events were never delivered.
    await waitForConnected(page);

    // Remember the exact DOM nodes so the later identity checks mean something.
    await page.evaluate(() => {
      window.__kikxListNode = document.querySelector('.kikx-frame-list');
      window.__kikxTopNode = document.querySelector('kikx-frame-item[data-frame-id="frame_1"]');
      window.__kikxLastNode = document.querySelector('kikx-frame-item[data-frame-id="frame_24"]');
    });

    // Scroll away from the bottom with a REAL wheel gesture.
    //
    // The product deliberately ignores scroll events that arrive inside a
    // programmatic placement window: onFrameListScroll() computes
    // `programmatic = Date.now() < app._ignoreFrameScrollUntil` and skips the whole
    // break-the-pin path when that is true. Only a genuine input gesture
    // (_onFrameListUserInterrupt: wheel / touchmove / keydown) zeroes that window
    // and marks _frameListUserGestureUntil. A synthetic `new Event('scroll')` sets
    // neither, so during the initial-placement grace window the product keeps
    // re-placing the viewport at the bottom and the assertion below would be
    // measuring the test's own fake input rather than a user scroll.
    let listBox = await page.evaluate(() => {
      let rect = document.querySelector('.kikx-frame-list').getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });
    await page.mouse.move(listBox.x, listBox.y);
    for (let step = 0; step < 20; step++) {
      let atTopAlready = await page.evaluate(() => (
        (document.querySelector('.kikx-frame-list')?.scrollTop ?? 1) <= 5
      ));
      if (atTopAlready)
        break;
      await page.mouse.wheel({ deltaY: -600 });
      await delay(40);
    }

    // Wait for the viewport to actually arrive rather than assuming a fixed delay.
    await page.waitForFunction(() => (
      (document.querySelector('.kikx-frame-list')?.scrollTop ?? 1) <= 5
    ), { timeout: 5000 });

    let scrolled = await readScrollMetrics(page);
    assert.equal(scrolled.atTop, true, 'expected the list scrolled to the top before the commit burst');

    // Fire a synchronous burst of informational `commit` events -- no frame
    // events, exactly the redundant half of a streaming commit.
    for (let index = 0; index < 40; index++)
      fixture.frameRuntime.emitEvent('commit', {
        sessionID: 'session_1',
        commit: { id: `commit_${index}`, order: index },
        frames: [ frames[index % frames.length] ],
      });

    await delay(400);

    let afterCommits = await page.evaluate(() => ({
      listSame: window.__kikxListNode === document.querySelector('.kikx-frame-list'),
      topSame: window.__kikxTopNode === document.querySelector('kikx-frame-item[data-frame-id="frame_1"]'),
      lastSame: window.__kikxLastNode === document.querySelector('kikx-frame-item[data-frame-id="frame_24"]'),
    }));
    assert.equal(afterCommits.listSame, true, 'commit burst must not rebuild the frame list');
    assert.equal(afterCommits.topSame, true, 'commit burst must not rebuild frame items');
    assert.equal(afterCommits.lastSame, true, 'commit burst must not rebuild frame items');

    let afterScroll = await readScrollMetrics(page);
    assert.equal(afterScroll.atTop, true, 'commit burst must not move the viewport while scrolled up');
    assert.equal(afterScroll.scrollTop, scrolled.scrollTop, 'commit burst must not change scrollTop');

    // Now prove the incremental path still works: a real frame.updated (paired
    // with commit) updates the item in place -- same node, new text.
    let updatedLast = {
      ...frames[23],
      updatedAt: frames[23].updatedAt + 1,
      content: { text: 'Frame 24: updated live content delivered through frame.updated.' },
    };
    fixture.frameRuntime.framesBySessionID.set('session_1', [ ...frames.slice(0, 23), updatedLast ]);
    fixture.frameRuntime.emitEvent('frame.updated', { sessionID: 'session_1', frame: updatedLast });
    fixture.frameRuntime.emitEvent('commit', {
      sessionID: 'session_1',
      commit: { id: 'commit_final', order: 99 },
      frames: [ updatedLast ],
    });

    await page.waitForFunction(() => (
      document.querySelector('kikx-frame-item[data-frame-id="frame_24"]')
        ?.textContent
        ?.includes('updated live content')
    ), { timeout: 5000 });

    let afterUpdate = await page.evaluate(() => ({
      lastSame: window.__kikxLastNode === document.querySelector('kikx-frame-item[data-frame-id="frame_24"]'),
      listSame: window.__kikxListNode === document.querySelector('.kikx-frame-list'),
    }));
    assert.equal(afterUpdate.lastSame, true, 'frame.updated must update the existing item in place');
    assert.equal(afterUpdate.listSame, true, 'frame.updated must not rebuild the frame list');

    // Finally, with the user back at the bottom, a commit burst must keep the
    // thread pinned to the bottom without a rebuild.
    await page.evaluate(() => {
      let list = document.querySelector('.kikx-frame-list');
      list.scrollTop = list.scrollHeight;
      list.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    await delay(120);
    for (let index = 0; index < 20; index++)
      fixture.frameRuntime.emitEvent('commit', { sessionID: 'session_1', commit: { id: `tail_${index}` }, frames: [] });
    await delay(300);

    let bottom = await page.evaluate(() => {
      let list = document.querySelector('.kikx-frame-list');
      let distance = list.scrollHeight - list.scrollTop - list.clientHeight;
      return {
        nearBottom: distance <= 40,
        listSame: window.__kikxListNode === document.querySelector('.kikx-frame-list'),
      };
    });
    assert.equal(bottom.nearBottom, true, 'commit burst must keep the thread pinned to the bottom');
    assert.equal(bottom.listSame, true, 'commit events must never rebuild the frame list');
  } finally {
    await browser.close().catch(() => {});
    await fixture.close().catch(() => {});
  }
});

function createFrames(count) {
  let frameList = [];
  for (let index = 1; index <= count; index++) {
    let isAgent = index % 2 === 0;
    let timestamp = 1781035260000000 + (index * 1000000);
    frameList.push({
      id: `frame_${index}`,
      type: isAgent ? 'AgentMessage' : 'UserMessage',
      sessionID: 'session_1',
      interactionID: `interaction_${index}`,
      authorType: isAgent ? 'agent' : 'user',
      authorID: isAgent ? 'agent_commit' : 'puppeteer-user',
      authorDisplayName: isAgent ? 'Commit Agent' : 'User',
      hidden: false,
      deleted: false,
      order: index,
      createdAt: timestamp,
      updatedAt: timestamp,
      content: {
        text: `Frame ${index}: this line exists so the thread overflows its viewport and the frame list becomes the scroll container.`,
      },
    });
  }

  return frameList;
}

async function waitForConnected(page, timeoutMS = 10000) {
  await page.waitForFunction(() => (
    document.querySelector('kikx-app')?._state?.connectionStatus === 'Connected'
  ), { timeout: timeoutMS });
}

async function readScrollMetrics(page) {
  return await page.evaluate(() => {
    let list = document.querySelector('.kikx-frame-list');
    let scrollTop = list?.scrollTop || 0;
    let clientHeight = list?.clientHeight || 0;
    let scrollHeight = list?.scrollHeight || 0;
    let distanceFromBottom = scrollHeight - scrollTop - clientHeight;
    return {
      scrollTop,
      clientHeight,
      scrollHeight,
      canScroll: scrollHeight > clientHeight,
      atTop: scrollTop <= 5,
      atBottom: distanceFromBottom <= 5,
    };
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
