'use strict';

// A UserMessage must never be positioned outside the thread's visible box.
//
// The defect this guards against, as reported: a person's own message rendered
// but sat almost entirely past the RIGHT edge of the window, leaving only a
// sliver of its left edge visible, while agent frames looked normal and no
// scrollbar appeared.
//
// Measured cause (sampled per mutation, 2523px window): the thread body is a
// grid whose column was never declared, so the column is implicit and
// auto-sized. While the message scrollview mounts, that subtree's min-content
// is far wider than the box -- measured 3678px of track inside a 2241px box,
// body scrollWidth 3714 vs clientWidth 2241 -- so for one layout pass the
// track is over-wide. User frames are right-aligned with margin-left: auto and
// the list clips horizontally, so the frame anchored at the far edge of that
// widened track: measured left=3222 right=3799 on a 2523px window at t=1.35s,
// back to inside by t=1.36s. Off-window, and unreachable by scrolling, because
// the ancestor clips (overflow: hidden) instead of scrolling.
//
// The escape is therefore TRANSIENT and mount-timed, not a settled state:
// removing the clamp from an already-settled page does not reproduce it, so the
// negative control below remounts the thread instead.
//
// These assertions are about geometry, not classes: a rule that fails to resolve
// must not pass. The over-wide child below is a deliberate stressor, not a
// reproduction of one specific message; containment must not depend on the
// content that happens to arrive.

import assert from 'node:assert/strict';
import test from 'node:test';

import puppeteer from 'puppeteer-core';

import { findChromeExecutable, startStagehandUIServer } from '../stagehand/stagehand-test-utils.mjs';

const SESSION_ID = 'session_viewport_bounds';
const baseTs = 1793328600000000;

function frame(type, id, order, text, extra = {}) {
  return {
    id,
    type,
    sessionID: SESSION_ID,
    interactionID: 'interaction_viewport_bounds',
    authorType: type === 'UserMessage' ? 'user' : 'agent',
    authorID: type === 'UserMessage' ? 'owner' : 'agent_1',
    authorDisplayName: type === 'UserMessage' ? 'Wyatt' : 'Bode',
    hidden: false,
    deleted: false,
    order,
    timestamp: baseTs + order,
    createdAt: baseTs + order,
    updatedAt: baseTs + order,
    content: { text },
    ...extra,
  };
}

const USER_TEXT =
  'Fixed: this message must stay fully inside the thread, from first paint '
  + 'through every targeted update and every resize.';
const AGENT_TEXT = 'Short agent reply.';

// Every frame's horizontal relationship to the visible thread box.
function readBounds() {
  let viewport = document.querySelector('.kikx-frame-list');
  let listRect = viewport ? viewport.getBoundingClientRect() : null;
  let windowWidth = window.innerWidth;

  let frames = Array.from(document.querySelectorAll('kikx-frame-item')).map((el) => {
    let rect = el.getBoundingClientRect();
    let visibleLeft = listRect ? Math.max(rect.left, listRect.left) : rect.left;
    let visibleRight = listRect ? Math.min(rect.right, listRect.right) : rect.right;
    let visible = Math.max(0, visibleRight - visibleLeft);
    return {
      id: el.dataset.frameId,
      type: el.dataset.frameType,
      left: Math.round(rect.left),
      right: Math.round(rect.right),
      width: Math.round(rect.width),
      insideWindow: rect.left >= 0 && rect.right <= windowWidth,
      insideList: listRect ? rect.left >= listRect.left - 1 && rect.right <= listRect.right + 1 : null,
      visibleFraction: rect.width > 0 ? Math.round((visible / rect.width) * 1000) / 1000 : 1,
    };
  });

  let body = document.querySelector('.kikx-thread__body');
  let bodyStyle = body ? getComputedStyle(body) : null;

  return {
    windowWidth,
    bodyClientWidth: body ? body.clientWidth : null,
    bodyScrollWidth: body ? body.scrollWidth : null,
    bodyColumns: bodyStyle ? bodyStyle.gridTemplateColumns : null,
    listLeft: listRect ? Math.round(listRect.left) : null,
    listRight: listRect ? Math.round(listRect.right) : null,
    listClientWidth: viewport ? viewport.clientWidth : null,
    listScrollWidth: viewport ? viewport.scrollWidth : null,
    listOverflowX: viewport ? getComputedStyle(viewport).overflowX : null,
    frames,
  };
}

function userFrameOf(bounds) {
  return bounds.frames.find((f) => f.type === 'UserMessage');
}

function assertUserFrameFullyVisible(bounds, label) {
  let user = userFrameOf(bounds);
  assert.ok(user, `${label}: the user message must exist in the DOM`);
  assert.equal(
    user.insideWindow,
    true,
    `${label}: the user message must be inside the window horizontally `
    + `(left=${user.left}, right=${user.right}, window=${bounds.windowWidth})`,
  );
  assert.equal(
    user.insideList,
    true,
    `${label}: the user message must be inside the thread's visible box `
    + `(left=${user.left}, right=${user.right}, list=${bounds.listLeft}..${bounds.listRight})`,
  );
  assert.equal(
    user.visibleFraction,
    1,
    `${label}: the user message must be fully visible, not clipped (visibleFraction=${user.visibleFraction})`,
  );
}

function assertNoFrameEscapes(bounds, label) {
  for (let f of bounds.frames) {
    assert.equal(
      f.insideList,
      true,
      `${label}: frame ${f.type}#${f.id} escaped the thread box `
      + `(left=${f.left}, right=${f.right}, list=${bounds.listLeft}..${bounds.listRight})`,
    );
  }
}

test('the user message stays inside the thread box from first paint through targeted updates', async (t) => {
  let chromePath = findChromeExecutable();
  if (!chromePath) {
    t.skip('This lane requires a local Chrome/Chromium');
    return;
  }

  let fixture = await startStagehandUIServer({
    sessions: [ { id: SESSION_ID, title: 'Viewport Bounds', messageCount: 2 } ],
  });
  fixture.frameRuntime.framesBySessionID.set(SESSION_ID, [
    frame('UserMessage', 'frame_user_bounds', 1, USER_TEXT),
    frame('AgentMessage', 'frame_agent_bounds', 2, AGENT_TEXT),
  ]);

  let browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: process.env.KIKX_PUPPETEER_HEADLESS === '0' ? false : 'new',
    args: [ '--no-sandbox', '--disable-setuid-sandbox' ],
  });

  try {
    let page = await browser.newPage();
    // A wide desktop window, like the one in the report.
    await page.setViewport({ width: 2523, height: 900 });
    await page.evaluateOnNewDocument(() => {
      // The app gates its initial load on an auth token read from
      // sessionStorage; seed one so the thread renders against the fixture.
      sessionStorage.setItem(
        'kikx.auth.session',
        JSON.stringify({ token: 'puppeteer-test-token', refresh_token: 'puppeteer-test-refresh' }),
      );
    });

    // Record bounds at the earliest moment they exist, so a frame that only
    // lands correctly after settling cannot pass this test.
    await page.evaluateOnNewDocument(() => {
      window.__kikxBoundsSamples = [];
      let note = () => {
        let el = document.querySelector('kikx-frame-item.kikx-frame--UserMessage');
        if (!el) return;
        let rect = el.getBoundingClientRect();
        // Record the causal box too. The measured signature of the defect is the
        // thread body's track growing past its own box (3714 vs 2241) while the
        // right-aligned frame rides out past the clip, so a sample that only
        // records the frame position cannot say WHY it moved.
        let body = document.querySelector('.kikx-thread__body');
        window.__kikxBoundsSamples.push({
          at: 'first-paint',
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          window: window.innerWidth,
          inside: rect.left >= 0 && rect.right <= window.innerWidth,
          bodyClientWidth: body ? body.clientWidth : null,
          bodyScrollWidth: body ? body.scrollWidth : null,
          bodyColumns: body ? getComputedStyle(body).gridTemplateColumns : null,
        });
      };
      let observer = new MutationObserver(note);
      document.addEventListener('DOMContentLoaded', () => {
        observer.observe(document.documentElement, { childList: true, subtree: true });
      });
    });

    await page.goto(`${fixture.baseURL}/`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForSelector('kikx-session-grid > kikx-session-card', { timeout: 15000 });
    // Startup loaders each schedule a shell rebuild; interact once they settle.
    await new Promise((resolve) => setTimeout(resolve, 600));

    await page.evaluate((id) => {
      let app = document.querySelector('kikx-app');
      if (typeof app?._openSessionFromCard === 'function') app._openSessionFromCard(id);
      else app._selectSession(id);
    }, SESSION_ID);

    await page.waitForSelector('kikx-frame-item.kikx-frame--UserMessage', { timeout: 15000 });
    await new Promise((resolve) => setTimeout(resolve, 700));

    let settled = await page.evaluate(readBounds);
    assertUserFrameFullyVisible(settled, 'settled');
    assertNoFrameEscapes(settled, 'settled');
    assert.equal(
      settled.listOverflowX,
      'hidden',
      'the thread list is expected to clip horizontally; this test measures that clip',
    );
    // Rest-state invariant, secondary: the settled page must not overflow its own
    // box either. Measured caveat -- this assertion passes WITHOUT the fix too,
    // because the track only overflows while the scrollview mounts. It is a
    // cheap truth, not the discriminator; the sampled assertion below is.
    assert.ok(
      settled.bodyScrollWidth - settled.bodyClientWidth <= 1,
      'the thread body must not overflow itself -- an auto-sized track is what '
      + 'carries right-aligned frames out of the clip '
      + `(clientWidth=${settled.bodyClientWidth}, scrollWidth=${settled.bodyScrollWidth}, `
      + `columns=${settled.bodyColumns})`,
    );

    // ---- a targeted update must not move it out -------------------------------
    let updated = frame('UserMessage', 'frame_user_bounds', 1, USER_TEXT, {
      updatedAt: baseTs + 9999,
    });
    fixture.frameRuntime.framesBySessionID.set(SESSION_ID, [
      updated,
      frame('AgentMessage', 'frame_agent_bounds', 2, AGENT_TEXT),
    ]);
    fixture.frameRuntime.emitEvent('frame.updated', { sessionID: SESSION_ID, frame: updated });
    await new Promise((resolve) => setTimeout(resolve, 500));
    let afterUpdate = await page.evaluate(readBounds);
    assertUserFrameFullyVisible(afterUpdate, 'after targeted update');
    assertNoFrameEscapes(afterUpdate, 'after targeted update');

    // ---- the structural invariant -------------------------------------------
    // A message that is wider than the column must be clipped INSIDE the thread
    // box; it must never be allowed to widen the box itself. This is the actual
    // defect: an unclamped desktop grid column let one wide child move every
    // right-aligned sibling outside the clip.
    await page.evaluate(() => {
      let el = document.querySelector('kikx-frame-item.kikx-frame--AgentMessage .kikx-frame__content')
        || document.querySelector('kikx-frame-item.kikx-frame--AgentMessage');
      let probe = document.createElement('div');
      probe.id = 'kikx-overwide-probe';
      probe.style.cssText = 'width: 3000px; height: 4px;';
      el.appendChild(probe);
    });
    await new Promise((resolve) => setTimeout(resolve, 300));

    let stressed = await page.evaluate(readBounds);
    assert.ok(
      stressed.listScrollWidth - stressed.listClientWidth <= 1,
      `an over-wide child must be clipped, not allowed to widen the thread list `
      + `(clientWidth=${stressed.listClientWidth}, scrollWidth=${stressed.listScrollWidth})`,
    );
    assertUserFrameFullyVisible(stressed, 'with an over-wide sibling');

    // ---- narrowing the window keeps it inside too ---------------------------
    for (let width of [ 1440, 960, 640 ]) {
      await page.setViewport({ width, height: 900 });
      await new Promise((resolve) => setTimeout(resolve, 400));
      let b = await page.evaluate(readBounds);
      assertUserFrameFullyVisible(b, `at ${width}px`);
      assertNoFrameEscapes(b, `at ${width}px`);
    }

    // ---- nothing ever escaped, including at first paint ---------------------
    let samples = await page.evaluate(() => window.__kikxBoundsSamples || []);
    // A run that never sampled would satisfy "zero escapes" while proving
    // nothing, so require that the observer actually recorded the first paint.
    assert.ok(
      samples.length >= 3,
      `the bounds sampler must have observed the frame at least at first paint and `
      + `after each mutation; only ${samples.length} sample(s) were recorded`,
    );
    assert.equal(
      samples[0].at,
      'first-paint',
      'the first recorded sample must be the frame entering the DOM, before any settle',
    );
    let escaped = samples.filter((s) => !s.inside);
    assert.equal(
      escaped.length,
      0,
      `the user message must never leave the window, not even transiently; `
      + `${escaped.length} of ${samples.length} samples were outside `
      + `(first: ${JSON.stringify(escaped[0] || null)})`,
    );
    for (let s of samples) {
      if (s.bodyScrollWidth === null) continue;
      assert.ok(
        s.bodyScrollWidth - s.bodyClientWidth <= 1,
        'the thread body must never let its track exceed its own box, at any point '
        + 'including mount; that widening is what carried the right-aligned frame out '
        + `of the clip (clientWidth=${s.bodyClientWidth}, scrollWidth=${s.bodyScrollWidth}, `
        + `columns=${s.bodyColumns})`,
      );
    }
    // ---- negative control: this lane must be able to fail --------------------
    // Measured: the escape happens during the thread's mount, so unclamping an
    // already-settled page leaves the frame inside and proves nothing (that is
    // how a control can quietly pass both ways). The control therefore has to
    // re-run the mount: unclamp, reload, open the session again, sample again.
    // A lane that cannot fail here is not measuring the regression.
    await page.evaluateOnNewDocument(() => {
      let style = document.createElement('style');
      style.id = 'kikx-unclamp-probe';
      style.textContent = '.kikx-thread__body { grid-template-columns: none; }';
      let attach = () => (document.head || document.documentElement).appendChild(style);
      if (document.head) attach();
      else document.addEventListener('DOMContentLoaded', attach);
    });
    await page.setViewport({ width: 2523, height: 900 });
    // NOT page.reload(). Opening a session calls syncURLFromStack, which writes a
    // deep link into the address bar precisely so that "a reload (or a shared
    // link) restores the exact view" (kikx-navigation.mjs:513-530). A reload
    // therefore lands straight in the thread and the grid never appears --
    // measured: reload, then waiting for kikx-session-card timed out at 15000ms.
    // A cold navigation to the bare origin re-runs the grid mount this control
    // needs to reproduce the escape.
    await page.goto(`${fixture.baseURL}/`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForSelector('kikx-session-grid > kikx-session-card', { timeout: 15000 });
    await new Promise((resolve) => setTimeout(resolve, 600));
    await page.evaluate((id) => {
      let app = document.querySelector('kikx-app');
      if (typeof app?._openSessionFromCard === 'function') app._openSessionFromCard(id);
      else app._selectSession(id);
    }, SESSION_ID);
    await page.waitForSelector('kikx-frame-item.kikx-frame--UserMessage', { timeout: 15000 });
    await new Promise((resolve) => setTimeout(resolve, 1500));

    let controlSamples = await page.evaluate(() => window.__kikxBoundsSamples || []);
    let controlEscapes = controlSamples.filter((s) => !s.inside);
    assert.ok(
      controlSamples.length >= 3,
      `the control arm must also sample the mount; only ${controlSamples.length} sample(s)`,
    );
    assert.ok(
      controlEscapes.length > 0,
      'negative control: with the column clamp removed and the thread remounted the user '
      + `message must leave the window again; all ${controlSamples.length} samples stayed `
      + 'inside, so this lane is not measuring the regression',
    );
  } finally {
    await browser.close();
    await fixture.close();
  }
});
