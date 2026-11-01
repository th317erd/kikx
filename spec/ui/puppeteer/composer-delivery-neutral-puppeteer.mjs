'use strict';

// Composer -> stored -> rendered proof that a typed message lands NEUTRAL.
//
// WHAT THIS ADDS BEYOND THE OTHER THREE SPECS
// `spec/server/user-message-delivery-route-spec.mjs` proves the real HTTP route
// stamps `content.delivery: 'neutral'` with no `deliveryAt`. Its world stops at
// the runtime. `spec/ui/puppeteer/user-message-delivery-puppeteer.mjs` proves
// what neutral and received LOOK like, but it seeds frames directly into the
// fixture, so nothing is typed and nothing is sent.
//
// This file closes the middle: a real keystroke in the real composer, a real
// POST to the real messages route, and an assertion on the DOM attribute of the
// bubble that comes back. That is the half of plan V7 that is honestly provable
// in a browser.
//
// WHAT THIS FILE EXPLICITLY DOES NOT PROVE - and why
// The `received` half is NOT reachable here, and pretending otherwise would be a
// fake green. `startStagehandUIServer` pre-resolves the plugin load
// (stagehand-test-utils.mjs:208 `pluginLoadPromise: Promise.resolve()`), so
// agent-route-frame-plugin.mjs never loads; its stub `appendUserMessage`
// (stagehand-test-utils.mjs:444) hand-builds `content: { text }` with no
// `delivery` key at all. No provider is ever fed in this harness, so no code
// path could legitimately write `received`. Re-implementing the transition
// inside the stub would make this file pass while proving nothing about
// production - exactly the defect the DOM spec already paid for once.
//
// So this spec pins the neutral default *as a display contract*: a typed
// `UserMessage` with no stored delivery state must render as neutral (no
// accent, no caption, no announced label), never as received. The assertion is
// on rendered/computed state, not on an exit code.

import assert from 'node:assert/strict';
import test from 'node:test';

import puppeteer from 'puppeteer-core';

import { findChromeExecutable, startStagehandUIServer } from '../stagehand/stagehand-test-utils.mjs';

const SESSION_ID = 'session_typed_delivery';
const TYPED_TEXT = 'typed message with no delivery stamp';

function existingFrame() {
  let timestamp = 1793328600000000;
  return {
    id: 'frame_existing_1',
    type: 'AgentMessage',
    sessionID: SESSION_ID,
    interactionID: 'interaction_existing_1',
    authorType: 'agent',
    authorID: 'agent_1',
    authorDisplayName: 'Bode',
    hidden: false,
    deleted: false,
    order: 1,
    timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
    content: { text: 'Ready.' },
  };
}

// Read everything about the typed bubble from the live page at once, so the
// attributes and the computed style cannot come from two different renders.
function readTypedBubble(page, text) {
  return page.evaluate((needle) => {
    let items = [ ...document.querySelectorAll('kikx-frame-item') ];
    let item = items.find((candidate) => candidate.innerText.includes(needle));
    if (!item)
      return { present: false, seen: items.map((candidate) => candidate.innerText.slice(0, 40)) };

    let bubble = item.querySelector('kikx-user-message-frame');
    let content = item.querySelector('.kikx-frame__content--user-message');
    let itemStyle = getComputedStyle(item);
    // The caption is generated content on the ::after pseudo-element; the
    // element's own computed `content` is always `normal`, so it must be read
    // with the second argument or the check is structurally blind.
    let afterContent = content ? getComputedStyle(content, '::after').content : null;

    return {
      present: true,
      frameID: item.getAttribute('data-frame-id'),
      dataDelivery: item.getAttribute('data-delivery'),
      hasReceivedClass: item.classList.contains('kikx-frame--delivery-received'),
      boxShadow: itemStyle.boxShadow,
      afterContent,
      bubbleDelivery: bubble ? bubble.getAttribute('data-delivery') : null,
      bubbleLabel: bubble ? bubble.getAttribute('aria-label') : null,
    };
  }, text);
}

// Computed `content` is never '' for an absent caption: it is 'none' when no
// ::after rule matches and 'normal' when a rule generates nothing. Both are
// absence. Real content is a quoted string such as '"Received"'.
function captionText(value) {
  if (!value || value === 'none' || value === 'normal')
    return '';
  return String(value).replace(/^['"]|['"]$/g, '');
}

test('a message typed into the real composer renders neutral, not received', async (t) => {
  let chromePath = findChromeExecutable();
  if (!chromePath) { t.skip('Puppeteer composer delivery coverage requires Chrome'); return; }

  let fixture = await startStagehandUIServer({
    sessions: [ { id: SESSION_ID, title: 'Typed Delivery', messageCount: 1, participantAgentIDs: [ 'agent_1' ] } ],
  });
  fixture.frameRuntime.framesBySessionID.set(SESSION_ID, [ existingFrame() ]);

  let browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: 'new',
    args: [ '--no-sandbox', '--disable-setuid-sandbox' ],
  });

  try {
    let page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.evaluateOnNewDocument(() => {
      sessionStorage.setItem('kikx.auth.session', JSON.stringify({
        token: 'typed-delivery-token',
        refresh_token: 'typed-delivery-refresh',
      }));
    });

    await page.goto(`${fixture.baseURL}/?session=${SESSION_ID}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForFunction(() => document.querySelector('kikx-app')?._startupSettled === true, { timeout: 15000 });
    await page.waitForSelector('kikx-frame-item[data-frame-id="frame_existing_1"]', { timeout: 15000 });

    // The real send path: composer -> POST /api/v1/sessions/:id/messages.
    await page.click('textarea[name="message"]');
    await page.keyboard.type(TYPED_TEXT);
    await page.keyboard.press('Enter');

    // Wait for the bubble the send produced, identified by its own text.
    await page.waitForFunction((needle) => (
      [ ...document.querySelectorAll('kikx-frame-item') ]
        .some((item) => item.innerText.includes(needle))
    ), { timeout: 15000 }, TYPED_TEXT);

    let rendered = await readTypedBubble(page, TYPED_TEXT);
    assert.equal(rendered.present, true, `the typed message must render; saw: ${JSON.stringify(rendered.seen)}`);

    // ---- the neutral contract ---------------------------------------------
    // A typed message with no stored delivery state must present as neutral.
    assert.equal(
      rendered.dataDelivery,
      'neutral',
      'a typed message must render with an explicit neutral delivery state',
    );
    assert.equal(rendered.hasReceivedClass, false, 'a typed message must not carry the received modifier');
    assert.equal(rendered.boxShadow, 'none', 'a neutral message must not paint the delivery accent');

    // The caption is CSS-only, so computed style is the only way to see it.
    // Neither absence is spelled the way you would guess: an element with no
    // ::after rule reports `content: none`, while a rule that generates nothing
    // reports `content: normal`. Both mean "no caption", so both normalise to
    // '' - the same helper the shipped browser spec uses
    // (user-message-delivery-puppeteer.mjs captionText). Asserting the literal
    // 'normal' here was wrong: it fails on a pristine tree, feature or not.
    assert.equal(captionText(rendered.afterContent), '', 'a neutral message must not show the Received caption');

    // The bubble element carries no delivery attribute and announces nothing.
    assert.equal(rendered.bubbleDelivery, null, 'the bubble must not claim a delivery state while neutral');
    assert.equal(rendered.bubbleLabel, null, 'a neutral message must not announce itself as received');
    assert.doesNotMatch(String(rendered.bubbleLabel ?? ''), /received/i);

    // ---- what the neutral is actually derived from ------------------------
    // Stated, not implied: this harness stores the message with NO delivery key
    // (stagehand-test-utils.mjs:444), and the client maps absent -> neutral
    // (frame-delivery-status.mjs:31). Asserting that here documents the boundary
    // of this spec: it proves the display default for a real typed message, not
    // that the server stamped anything. That is the route spec's job.
    let stored = fixture.frameRuntime.framesBySessionID
      .get(SESSION_ID)
      .find((frame) => frame.content?.text === TYPED_TEXT);

    assert.ok(stored, 'the send must have reached the fixture runtime');
    assert.equal(stored.type, 'UserMessage', 'the composer send must produce a UserMessage');
    assert.equal(stored.authorType, 'user', 'the frame must be attributed to the person who typed it');
    assert.equal(
      Object.hasOwn(stored.content, 'delivery'),
      false,
      'this harness stores no delivery key; the neutral above is the client default, by design',
    );
  } finally {
    await browser.close();
    // Every sibling spec closes the fixture too; without this the fixture's HTTP
    // server stays listening and `node --test` has no free handle to exit on,
    // which is what made this spec look like a hang under the canonical lane.
    await fixture.close();
  }
});
