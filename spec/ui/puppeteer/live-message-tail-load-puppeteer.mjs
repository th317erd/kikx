'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';
import puppeteer from 'puppeteer-core';
import { findChromeExecutable, startStagehandUIServer } from '../stagehand/stagehand-test-utils.mjs';

function frame(id, order, text) {
  let timestamp = 1793328600000000 + order * 1000000;
  return {
    id,
    type: 'UserMessage',
    sessionID: 'session_live_tail',
    interactionID: `interaction_${order}`,
    authorType: 'user',
    authorID: 'owner',
    authorDisplayName: 'Wyatt',
    hidden: false,
    deleted: false,
    order,
    timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
    content: { text },
  };
}

test('Puppeteer queues a live message while the unloaded tail page loads', async (t) => {
  let chromePath = findChromeExecutable();
  if (!chromePath) { t.skip('Puppeteer live-tail coverage requires Chrome'); return; }

  let frames = [];
  for (let order = 1; order <= 300; order++)
    frames.push(frame(`f${order}`, order, `Message ${order}`));

  let fixture = await startStagehandUIServer({
    sessions: [ { id: 'session_live_tail', title: 'Live tail', messageCount: frames.length } ],
  });
  fixture.frameRuntime.framesBySessionID.set('session_live_tail', frames);

  let browser = await puppeteer.launch({ executablePath: chromePath, headless: 'new', args: [ '--no-sandbox', '--disable-setuid-sandbox' ] });
  try {
    let page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.evaluateOnNewDocument(() => sessionStorage.setItem('kikx.auth.session', JSON.stringify({ token: 'live-tail-token', refresh_token: 'live-tail-refresh' })));
    await page.goto(`${fixture.baseURL}/?session=session_live_tail`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForSelector('kikx-frame-item', { timeout: 15000 });
    await new Promise((resolve) => setTimeout(resolve, 800));

    // Simulate the state that the recent filter/live-sync paths can leave
    // behind: the tail page exists but is unloaded, so appendFrame cannot mount
    // the incoming message yet.
    let appended = await page.evaluate(() => {
      let scrollview = document.querySelector('kikx-chat-view')._scrollview;
      let lastPage = scrollview.element.pages.length - 1;
      scrollview.element.invalidatePage(lastPage);
      let live = {
        id: 'live-tail-message',
        type: 'UserMessage',
        sessionID: 'session_live_tail',
        interactionID: 'interaction_live',
        authorType: 'user',
        authorID: 'owner',
        authorDisplayName: 'Wyatt',
        hidden: false,
        deleted: false,
        order: 301,
        timestamp: 1793328600999000,
        createdAt: 1793328600999000,
        updatedAt: 1793328600999000,
        content: { text: 'incoming message' },
      };
      return { added: scrollview.appendFrame(live), pending: scrollview._pendingLiveFrames.size };
    });

    assert.equal(appended.added, false, 'the unloaded tail cannot mount the frame immediately');
    assert.equal(appended.pending, 1, 'the live frame must be queued while the page loads');

    // No scroll gesture: the queued frame must arrive because appendFrame
    // starts the tail-page load itself.
    await page.waitForFunction(() => (
      document.querySelector('kikx-frame-item[data-frame-id="live-tail-message"]')
    ), { timeout: 15000 });

    let state = await page.evaluate(() => {
      let scrollview = document.querySelector('kikx-chat-view')._scrollview;
      return {
        pending: scrollview._pendingLiveFrames.size,
        loaded: scrollview.element.pages.at(-1)?.loaded === true,
        scrollTop: scrollview.element.metrics().scrollTop,
      };
    });
    assert.equal(state.pending, 0, 'the queued live frame must flush after the page load');
    assert.equal(state.loaded, true, 'the tail page must load without a user scroll');
    assert.ok(state.scrollTop >= 0, 'the viewport remains valid');

    // The bounded state window trims one frame and appends one frame on every
    // live update. At the cap the lengths are EQUAL, which used to make the
    // sync path skip the new tail frame entirely. Feed that exact shape through
    // syncFrames with the tail unloaded and prove the message still arrives.
    let queuedBySync = await page.evaluate(() => {
      let scrollview = document.querySelector('kikx-chat-view')._scrollview;
      let lastPage = scrollview.element.pages.length - 1;
      scrollview.element.invalidatePage(lastPage);
      let incoming = {
        id: 'live-tail-message-2',
        type: 'UserMessage',
        sessionID: 'session_live_tail',
        interactionID: 'interaction_live_2',
        authorType: 'user',
        authorID: 'owner',
        authorDisplayName: 'Wyatt',
        hidden: false,
        deleted: false,
        order: 302,
        timestamp: 1793328600999001,
        createdAt: 1793328600999001,
        updatedAt: 1793328600999001,
        content: { text: 'incoming message at the cap' },
      };
      let next = [ ...scrollview.frames.slice(1), incoming ];
      let sameLength = next.length === scrollview.frames.length;
      scrollview.syncFrames(next, scrollview.getAppState(), {});
      return { sameLength, pending: scrollview._pendingLiveFrames.size };
    });
    assert.equal(queuedBySync.sameLength, true, 'the fixture must exercise the equal-length cap window');
    assert.equal(queuedBySync.pending, 1, 'an equal-length tail append must still be queued');
    await page.waitForFunction(() => (
      document.querySelector('kikx-frame-item[data-frame-id="live-tail-message-2"]')
    ), { timeout: 15000 });

    let flushed = await page.evaluate(() => document.querySelector('kikx-chat-view')._scrollview._pendingLiveFrames.size);
    assert.equal(flushed, 0, 'the synced tail frame must flush after its page load');
  } finally {
    await browser?.close();
    await fixture.close();
  }
});
