'use strict';

// Real-browser coverage for the session-card interaction contract the owner set
// in screenshot session-2026-11-14-01-53-54.911:
//
//   1. "Please remove all 'Play' buttons from session view cards. They are not
//      needed. A click on the card does the same action."
//   2. "Frames/Messages have HOVER EFFECTS inside the card... this shouldn't
//      happen. The only way the card is interactive is by clicking on it to
//      enter it."
//
// Both are asserted against a real Chrome render, because both are properties of
// the live DOM. A card can pass a mini-dom test that only counts toolbar
// children while still hit-testing a frame descendant, and a CSS-text spec can
// match `pointer-events: none` on the preview while a MORE SPECIFIC rule in
// another sheet puts `auto` back -- which is exactly what
// `.kikx-frame__hover-target` and `.kikx-frame__quick-actions` do in
// app-composer.css. Only `elementFromPoint` and a real pointer can tell.
//
// Puppeteer smoke: no LLM key required. Mirrors the convention documented in
// deleted-sessions-puppeteer.mjs.
//
// Measurement note: hover must be probed at a FRAME's centre, not at the
// preview's centre. The preview is a scaled stack of frames with gaps between
// them, so its geometric centre often lands on the `kikx-chat-view--mini`
// element itself -- a pointer there never enters any `.kikx-frame`, and a
// "no hover response" assertion would pass for the wrong reason. The control
// below re-measures with the fix stripped and MUST flip, which is what proves
// the probe is aimed at something that can actually react.

import assert from 'node:assert/strict';
import test from 'node:test';

import puppeteer from 'puppeteer-core';

import { findChromeExecutable, startStagehandUIServer } from '../stagehand/stagehand-test-utils.mjs';

const CARD = 'kikx-session-grid > kikx-session-card';
const CARD_SHELL = `${CARD} .kikx-session-card`;
const PREVIEW = `${CARD_SHELL} .kikx-chat-view--mini`;
const PREVIEW_FRAME = `${PREVIEW} .kikx-frame`;

const PARK = { x: 4, y: 4 };

function frame(id, type, order, sessionID, text) {
  return {
    id,
    order,
    type,
    sessionID,
    createdAt: 1781035260000000 + order * 1000000,
    content: { text },
  };
}

async function startFixture() {
  let fixture = await startStagehandUIServer({
    sessions: [ { id: 'session_card', title: 'Card Session', messageCount: 3 } ],
  });
  fixture.frameRuntime.framesBySessionID.set('session_card', [
    frame('card_user_1', 'UserMessage', 1, 'session_card', 'a user prompt'),
    frame('card_agent_1', 'AgentMessage', 2, 'session_card', 'the first agent reply'),
    frame('card_agent_2', 'AgentMessage', 3, 'session_card', 'the second agent reply'),
  ]);
  return fixture;
}

async function openCardPage(fixture, width = 1440) {
  let chromePath = findChromeExecutable();
  assert.ok(chromePath, 'Puppeteer local smoke requires Chrome');

  let browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: process.env.KIKX_PUPPETEER_HEADLESS === '0' ? false : 'new',
    args: [ '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage' ],
  });

  let page = await browser.newPage();
  await page.setViewport({ width, height: 900 });
  // The app gates its initial load on an auth token read from sessionStorage at
  // module load; seed one so the workspace grid renders against the fixture.
  await page.evaluateOnNewDocument(() => {
    sessionStorage.setItem('kikx.auth.session', JSON.stringify({
      token: 'puppeteer-test-token',
      refresh_token: 'puppeteer-test-refresh',
    }));
  });
  await page.goto(`${fixture.baseURL}/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForSelector(CARD, { timeout: 20000 });
  await page.waitForSelector(PREVIEW_FRAME, { timeout: 20000 });
  // The startup loaders (account/agents/token-usage) each schedule a full shell
  // rebuild and can resolve after the grid first paints. Interacting now would
  // drive a node about to be swapped out.
  await new Promise((resolve) => setTimeout(resolve, 2000));
  return { browser, page };
}

// Centre of the first rendered frame inside the card preview -- a point that is
// guaranteed to be over a message, so `:hover` on a frame is reachable there.
async function frameCentre(page) {
  let centre = await page.evaluate((selector) => {
    let frameNode = document.querySelector(selector);
    if (!frameNode) return null;
    let rect = frameNode.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  }, PREVIEW_FRAME);
  assert.ok(centre, 'a frame must be rendered inside the card preview to hover');
  return centre;
}

// Park the pointer away, sample the rails at rest, then aim it at (x, y) and
// sample again. Both samples read the SAME first frame's rails.
async function hoverSample(page, x, y, settleMs = 450) {
  await page.mouse.move(PARK.x, PARK.y);
  await new Promise((resolve) => setTimeout(resolve, 250));

  let read = () => page.evaluate(({ previewSelector, frameSelector, px, py }) => {
    let preview = document.querySelector(previewSelector);
    let firstFrame = preview.querySelector(frameSelector.slice(previewSelector.length).trim()) || preview.querySelector('.kikx-frame');
    let quickActions = firstFrame?.querySelector('.kikx-frame__quick-actions');
    let timestamp = firstFrame?.querySelector('.kikx-frame__timestamp');
    let hit = px == null ? null : document.elementFromPoint(px, py);
    let computed = (node) => node
      ? {
        opacity: getComputedStyle(node).opacity,
        visibility: getComputedStyle(node).visibility,
      }
      : null;
    return {
      hitTag: hit ? hit.tagName.toLowerCase() : null,
      hitClass: hit ? String(hit.className || '').slice(0, 64) : null,
      // The contract: the pointer must resolve to the CARD, never to a node
      // inside the preview. That is what makes the card one click target.
      hitInsidePreview: hit ? Boolean(hit.closest('.kikx-chat-view--mini')) : null,
      hitInsideCard: hit ? Boolean(hit.closest('.kikx-session-card')) : null,
      framesMatchingHover: preview.querySelectorAll('.kikx-frame:hover').length,
      quickActions: computed(quickActions),
      timestamp: computed(timestamp),
    };
  }, { previewSelector: PREVIEW, frameSelector: PREVIEW_FRAME, px: x, py: y });

  let atRest = await read();
  await page.mouse.move(x, y);
  await new Promise((resolve) => setTimeout(resolve, settleMs));
  let hovering = await read();
  await page.mouse.move(PARK.x, PARK.y);
  await new Promise((resolve) => setTimeout(resolve, 200));
  return { atRest, hovering };
}

// Reproduce the PRE-FIX state. Both halves of the fix have to go, and this is
// measured rather than assumed: with `inert` still present the pointer cannot
// reach a frame at all, so neutralising pointer-events alone leaves every frame
// un-hovered and the control would "pass" without proving anything. Removing
// `inert` as well is what lets the original bug reappear:
//
//   scalerInert:true  -> hit kikx-session-card__body, frames :hover 0, rails 0
//   scalerInert:false -> hit kikx-frame__hover-target, frames :hover 1, rails 1
//
// Opacity is deliberately NOT forced: pinning it at rest would mask the very
// transition being measured.
async function stripPreviewFix(page) {
  await page.evaluate(() => {
    for (let scaler of document.querySelectorAll('.kikx-chat-view__scaler'))
      scaler.removeAttribute('inert');

    let style = document.createElement('style');
    style.id = 'kikx-hit-target-control';
    style.textContent = '.kikx-chat-view--mini, .kikx-chat-view--mini * { pointer-events: auto !important; }';
    document.head.appendChild(style);
  });
  await new Promise((resolve) => setTimeout(resolve, 250));
}

async function restorePreviewFix(page) {
  await page.evaluate(() => {
    document.getElementById('kikx-hit-target-control')?.remove();
    for (let scaler of document.querySelectorAll('.kikx-chat-view__scaler'))
      scaler.setAttribute('inert', '');
  });
  await new Promise((resolve) => setTimeout(resolve, 250));
}

test('a session card has no Play/Open button -- the card itself opens the session', async (t) => {
  let chromePath = findChromeExecutable();
  if (!chromePath) {
    t.skip('Puppeteer local smoke requires Chrome');
    return;
  }

  let fixture = await startFixture();
  let { browser, page } = await openCardPage(fixture);

  try {
    let state = await page.evaluate((selector) => {
      let card = document.querySelector(selector);
      let toolbar = card.querySelector('.kikx-session-card__toolbar');
      let labels = [ ...card.querySelectorAll('[aria-label]') ]
        .map((node) => node.getAttribute('aria-label'))
        .concat([ ...card.querySelectorAll('[label]') ].map((node) => node.getAttribute('label')));
      let scaler = card.querySelector('.kikx-chat-view__scaler');
      return {
        openActionNodes: card.querySelectorAll('.kikx-session-card__action--open').length,
        openIconNodes: card.querySelectorAll('[icon="open"]').length,
        toolbarChildCount: toolbar ? toolbar.children.length : -1,
        toolbarIcons: toolbar
          ? [ ...toolbar.querySelectorAll('[icon]') ].map((node) => node.getAttribute('icon'))
          : [],
        openishLabels: labels.filter((label) => /^(open|play)\b/i.test(String(label))),
        // The replacement affordance must be reachable by keyboard, otherwise
        // removing the button traded a mouse-only control for no control.
        rootTabIndex: card.getAttribute('tabindex'),
        previewFrameCount: card.querySelectorAll('.kikx-chat-view--mini .kikx-frame').length,
        scalerInert: scaler ? scaler.hasAttribute('inert') : null,
      };
    }, CARD_SHELL);

    assert.equal(state.openActionNodes, 0, 'no Open/Play action node survives in the card');
    assert.equal(state.openIconNodes, 0, 'nothing renders the open/play glyph');
    assert.deepEqual(state.toolbarIcons, [ 'delete' ], 'the toolbar holds the Delete action only');
    assert.equal(state.toolbarChildCount, 1, 'exactly one toolbar control');
    assert.deepEqual(state.openishLabels, [], 'no control is announced as Open/Play');
    assert.equal(state.rootTabIndex, '0', 'the card root is focusable, so keyboard users can still open it');
    assert.ok(state.previewFrameCount > 0, 'the card rendered a frame preview to hover');
    assert.equal(state.scalerInert, true, 'the preview subtree is inert, so it leaves the tab order');
  } finally {
    await browser.close();
    await fixture.close?.();
  }
});

test('the card preview has NO hover response, and the measurement is sensitive to the fix', async (t) => {
  let chromePath = findChromeExecutable();
  if (!chromePath) {
    t.skip('Puppeteer local smoke requires Chrome');
    return;
  }

  let fixture = await startFixture();
  let { browser, page } = await openCardPage(fixture);

  try {
    let centre = await frameCentre(page);

    let { atRest, hovering } = await hoverSample(page, centre.x, centre.y);

    // 1) The pointer lands on the card, not on a frame inside the preview.
    assert.equal(hovering.hitInsidePreview, false,
      `a pointer over a card frame must not hit-test a preview descendant (hit ${hovering.hitTag}.${hovering.hitClass})`);
    assert.equal(hovering.hitInsideCard, true,
      'the pointer must still resolve inside the card, so a click opens the session');

    // 2) No frame inside the preview enters :hover.
    assert.equal(hovering.framesMatchingHover, 0,
      'no frame inside a card preview may match :hover');

    // 3) The hover rails stay exactly as they are at rest.
    assert.equal(hovering.quickActions.opacity, '0',
      'quick actions must not fade in over a card preview');
    assert.equal(hovering.timestamp.opacity, atRest.timestamp.opacity,
      'the timestamp must not brighten on hover inside a card');

    // 4) NEGATIVE CONTROL. Restoring only `pointer-events` (never opacity) must
    //    bring the hover response back. Without this, "no change on hover"
    //    could pass because the probe never reached a frame, or because the
    //    fixture rendered no hover rails at all.
    await stripPreviewFix(page);
    let withoutFix = await hoverSample(page, centre.x, centre.y);

    assert.equal(withoutFix.hovering.hitInsidePreview, true,
      'CONTROL: with the fix neutralised the pointer must hit a preview descendant again');
    assert.ok(withoutFix.hovering.framesMatchingHover > 0,
      'CONTROL: with the fix neutralised a frame must enter :hover');
    assert.equal(withoutFix.hovering.quickActions.opacity, '1',
      'CONTROL: with the fix neutralised hovering a frame must fade the quick actions in');

    // 5) The control is a property of the rule, not a one-way latch.
    await restorePreviewFix(page);
    let restored = await hoverSample(page, centre.x, centre.y);

    assert.equal(restored.hovering.hitInsidePreview, false, 'restoring the rule restores the contract');
    assert.equal(restored.hovering.framesMatchingHover, 0, 'restoring the rule stops frames matching :hover');
    assert.equal(restored.hovering.quickActions.opacity, '0', 'restoring the rule hides the quick actions again');
  } finally {
    await browser.close();
    await fixture.close?.();
  }
});

test('a click on the card preview reaches the card root, which is the Open affordance', async (t) => {
  let chromePath = findChromeExecutable();
  if (!chromePath) {
    t.skip('Puppeteer local smoke requires Chrome');
    return;
  }

  let fixture = await startFixture();
  let { browser, page } = await openCardPage(fixture, 1280);
  let second = null;

  try {
    let centre = await frameCentre(page);

    // ORDER MATTERS, and getting it wrong is exactly what made this assertion
    // read `0 !== 1`. Both gestures here (`Enter` on the root, and a real click)
    // are the OPEN gesture: they fire `kikx-card-open`, the app swaps the grid
    // for the session view, and the card node is destroyed. An earlier version
    // dispatched Enter first and only then attached a click listener -- to a
    // detached node -- so the subsequent real click could never reach it. The
    // product was fine; the test listened on a corpse.
    //
    // So the click gesture is measured first, on a live card, with its listener
    // in place before the pointer moves. `window` survives the SPA navigation,
    // so the recorded path is still readable afterwards.
    await page.evaluate((selector) => {
      window.__kikxClickPath = [];
      let card = document.querySelector(selector);
      card.addEventListener('click', (event) => {
        window.__kikxClickPath.push({
          phase: 'card-root',
          target: event.target ? event.target.tagName.toLowerCase() : null,
          inPreview: event.target ? Boolean(event.target.closest('.kikx-chat-view--mini')) : null,
        });
      });
    }, CARD_SHELL);

    await page.mouse.click(centre.x, centre.y);
    await new Promise((resolve) => setTimeout(resolve, 600));

    let path = await page.evaluate(() => window.__kikxClickPath || []);
    assert.equal(path.length, 1, 'the click must reach the card root exactly once');
    assert.equal(path[0].inPreview, false,
      'the click target must not be inside the preview, or the card open handler would never see it as a card click');

    // The keyboard affordance is asserted on a FRESH page, because dispatching
    // Enter opens the session and destroys the card just as the click did. The
    // listener must sit on the HOST: `_build()` puts tabIndex and the keydown
    // handler on the inner ROOT, while `_emitOpen()` dispatches `kikx-card-open`
    // on the host custom element. Events bubble up and never down, so a listener
    // on the root could never observe the event that root itself emitted.
    second = await openCardPage(fixture, 1280);
    let affordance = await second.page.evaluate(({ hostSelector, rootSelector }) => {
      let host = document.querySelector(hostSelector);
      let root = document.querySelector(rootSelector);
      if (!host || !root) return null;
      let opens = 0;
      host.addEventListener('kikx-card-open', () => { opens += 1; });
      root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return { tabIndex: root.getAttribute('tabindex'), opensAfterEnter: opens };
    }, { hostSelector: CARD, rootSelector: CARD_SHELL });

    assert.ok(affordance, 'a card must be present to receive the keyboard gesture');
    assert.equal(affordance.tabIndex, '0', 'the card is focusable');
    assert.equal(affordance.opensAfterEnter, 1,
      'Enter on the card opens the session, replacing the removed Play button');
  } finally {
    if (second) await second.browser.close();
    await browser.close();
    await fixture.close?.();
  }
});
