'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';
import puppeteer from 'puppeteer-core';
import { findChromeExecutable, startStagehandUIServer, waitForScrollviewSettled } from '../stagehand/stagehand-test-utils.mjs';

function frame(id, order, text) {
  let timestamp = 1793328600000000 + order * 1000000;
  return { id, type: 'UserMessage', sessionID: 'session_filtered_scroll', interactionID: `i${order}`, parentID: null, authorType: 'user', authorID: 'owner', authorDisplayName: 'Wyatt', hidden: false, deleted: false, order, timestamp, createdAt: timestamp, updatedAt: timestamp, content: { text } };
}

async function capture(page) {
  return page.evaluate(() => {
    let list = document.querySelector('.kikx-frame-list');
    let items = [ ...document.querySelectorAll('kikx-frame-item[data-frame-id]') ];
    let item = items
      .find((candidate) => candidate.getBoundingClientRect().bottom > list.getBoundingClientRect().top);
    return {
      id: item?.dataset.frameId || null,
      relativeTop: item ? item.getBoundingClientRect().top - list.getBoundingClientRect().top : null,
      // Reported so a failed anchoring assertion can show how much the view
      // actually held: itemCount/scrollHeight are the two quantities that
      // change when pages load above, and a jump with unchanged values means
      // nothing loaded at all.
      itemCount: items.length,
      scrollHeight: Math.round(list.scrollHeight),
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
    // The initial mount loads pages progressively; typing into the filter
    // before it finishes races the query against a growing list.
    await waitForScrollviewSettled(page, { label: 'initial mount' });
    let input = await page.$('.kikx-session-search input');
    await input.click();
    await page.keyboard.type('filler');
    // The filter re-queries and re-pages the whole thread.
    await waitForScrollviewSettled(page, { label: 'filter re-query' });
    await page.evaluate(() => document.querySelector('kikx-chat-view')._scrollview.element.scrollToPage(5, { align: 'start', animate: false }));
    // scrollToPage() is a transaction: the vendor keeps _pendingPage until the
    // page is placed and its height has stopped changing. `before` must describe
    // the settled post-jump viewport, not the estimated placeholder layout.
    await waitForScrollviewSettled(page, { label: 'post-jump' });
    // The spec's premise is that lazy pages are still UNLOADED above the
    // viewport when the gesture happens. Left to itself the app sometimes
    // prefetches every page above the jump target before the wheel arrives
    // (measured in a concurrent gate copy: the gesture began with itemCount
    // 1069 and no unloaded page above), and in that state no gesture can load
    // anything -- a spec that requires a page load would then hang on an
    // unreachable premise rather than fail on a bug. So put the app back into
    // the state this spec names, using the vendor's own mechanism for returning
    // offscreen pages to lazy gaps: the same public call production makes
    // (kikx-chat-scrollview.mjs invalidatePages at :182 and :233). Page heights
    // survive invalidation, so this does not move the viewport.
    let prepared = await page.evaluate(() => {
      let list = document.querySelector('.kikx-frame-list');
      let host = list.closest('aeor-scrollview');
      let focalPage = host.pageAtOffset(list.scrollTop + 1);
      let above = [];
      for (let index = 0; index < focalPage; index += 1) {
        if (host.pages?.[index]?.loaded)
          above.push(index);
      }
      if (above.length > 0)
        host.invalidatePages(above);
      return { focalPage, invalidated: above.length };
    });
    assert.ok(prepared.focalPage > 0, 'the jump must leave pages above the viewport');
    await waitForScrollviewSettled(page, { label: 'pages above unloaded' });
    // Prove the premise instead of assuming it, and prove the load from the
    // vendor's own event rather than from DOM size: itemCount saturates at the
    // mounted-page ceiling, so "the list grew" is not a reliable statement that
    // a page loaded. scrollview-page-loaded fires once per landed page and
    // carries its index (aeor-scrollview.js:964).
    let lazy = await page.evaluate((focalPage) => {
      let list = document.querySelector('.kikx-frame-list');
      let host = list.closest('aeor-scrollview');
      let unloaded = [];
      for (let index = 0; index < focalPage; index += 1) {
        if (host.pages?.[index]?.loaded === false)
          unloaded.push(index);
      }
      window.__loadedAbove = [];
      host.addEventListener('scrollview-page-loaded', (event) => {
        let pageIndex = event.detail?.pageIndex;
        if (Number.isInteger(pageIndex) && pageIndex < focalPage)
          window.__loadedAbove.push(pageIndex);
      });
      return unloaded;
    }, prepared.focalPage);
    assert.ok(lazy.length > 0,
      `the gesture needs a lazy page above the viewport to load (focal page ${prepared.focalPage}, unloaded above: ${JSON.stringify(lazy)})`);
    let before = await capture(page);
    assert.ok(before.id);
    await page.mouse.move(600, 400);
    // Wheel up by LESS than one page, so the gesture asks for exactly the page
    // above. Over a longer burst the per-load corrections arrive after each
    // other and the anchor still lands correctly (traced: +5723px of scrollTop
    // against +13723px loaded above minus 8000px wheeled, anchor 601 -> 598),
    // but a single-page gesture tests the promise this spec names without
    // depending on how many loads a burst happens to trigger.
    await page.mouse.wheel({ deltaY: -200 });
    // Do not sample `after` until the burst is over. The vendor's correction for
    // a page that lands above arrives on the load task itself, but the measured
    // timeline shows it landing ~600ms after the gesture (601 at +100ms,
    // 598 and scrollTop 31023 at +710ms), so a shorter quiet window would
    // sample mid-correction and call a stale viewport settled. The helper holds
    // quiet for 1800ms, longer than the vendor's 1500ms pendingPage expiry.
    await waitForScrollviewSettled(page, { label: 'wheel-up load' });
    let loadedAbove = await page.evaluate(() => window.__loadedAbove);
    assert.ok(loadedAbove.length > 0,
      `the wheel must load an older page above the viewport (lazy pages above were ${JSON.stringify(lazy)}, loaded above after the gesture: ${JSON.stringify(loadedAbove)})`);
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
