'use strict';

// Owner annotation (session-2026-11-17-17-16-22.354.png), verbatim:
//
//   "Somehow our quick-action buttons made it to INSIDE the message...
//    this is wrong. They are supposed to WRAP in the container OUTSIDE
//    the message."
//
// This re-rules the previous arrangement, which was itself an owner request
// (session-2026-11-14-02-02-31.771.png):
//
//   "Quick-action buttons can end up BEHIND another card, or push down too far
//    vertically. Can we have them wrap inside their container please?"
//
// That 2026-11-14 request was implemented as "inside the CARD". The card is the
// message bubble; the "container" the owner meant is the thread that holds the
// messages. Reading "container" as "card" is what produced today's bug. Both of
// the older complaints are still real, and this file keeps asserting them:
//
//   * "end up BEHIND another card" — `.kikx-frame` sets `transform`, so every
//     card establishes its own stacking context. A rail painted outside its card
//     used to be drawn UNDER any later sibling no matter how large its own
//     z-index was, because the parent card's context bounded it. The fix lifts
//     the hovered CARD (z-index 2), which is the only way a descendant can paint
//     above a sibling's context.
//   * "push down too far vertically" — the old rail was a vertical COLUMN, ~100px
//     tall beside a one-line card. This is a row that wraps.
//
// Everything below is measured on the rendered page: getBoundingClientRect for
// geometry and elementFromPoint for reachability. A CSS-text assertion could not
// tell "the rule that says outside" from "the buttons are painted outside", and
// CSS text is exactly what let the wrong arrangement pass before.
//
// TWO negative controls run the same measurement against the two arrangements
// this change replaced, and require the SAME assertions to fail. A test that
// passed in all three arrangements would not be evidence.

import assert from 'node:assert/strict';
import test from 'node:test';

import puppeteer from 'puppeteer-core';

import { findChromeExecutable, startStagehandUIServer } from '../stagehand/stagehand-test-utils.mjs';

const NARROW_ID = 'rail_outside_narrow';
const WIDE_ID = 'rail_outside_wide';

function frame(id, type, order, text) {
  let timestamp = 1793328600000000 + order * 1000000;
  return {
    id,
    type,
    sessionID: 'session_rail_outside',
    interactionID: `interaction_${order}`,
    parentID: null,
    authorType: type === 'UserMessage' ? 'user' : 'agent',
    authorID: type === 'UserMessage' ? 'owner' : 'agent',
    authorDisplayName: type === 'UserMessage' ? 'Owner' : 'Miri',
    hidden: false,
    deleted: false,
    order,
    timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
    content: { text },
  };
}

// Serialised into the page: no module scope available.
function measureInPage() {
  const NARROW = 'rail_outside_narrow';
  const WIDE = 'rail_outside_wide';

  function box(node) {
    if (!node)
      return null;
    let rect = node.getBoundingClientRect();
    return {
      left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
      width: rect.width, height: rect.height,
    };
  }
  function verticalOverlap(a, b) {
    if (!a || !b)
      return 0;
    let horizontal = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    let vertical = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    return horizontal > 0 && vertical > 0 ? vertical : 0;
  }

  let narrow = document.querySelector(`kikx-frame-item[data-frame-id="${NARROW}"]`);
  let wide = document.querySelector(`kikx-frame-item[data-frame-id="${WIDE}"]`);
  let rail = narrow?.querySelector('.kikx-frame__quick-actions');
  if (!rail || !narrow)
    return { error: 'no rail' };

  let railBox = box(rail);
  let narrowBox = box(narrow);
  let wideBox = box(wide);
  let style = getComputedStyle(rail);

  let buttons = [ ...rail.querySelectorAll('.kikx-frame__quick-action') ];
  let hits = buttons.map((button) => {
    let rect = button.getBoundingClientRect();
    let hit = document.elementFromPoint(
      Math.round(rect.left + rect.width / 2),
      Math.round(rect.top + rect.height / 2),
    );
    return {
      buttonInsideCard: rect.top < narrowBox.bottom - 0.5,
      hitFrameId: hit?.closest?.('kikx-frame-item')?.dataset?.frameId || null,
      hitIsButton: Boolean(hit?.closest?.('.kikx-frame__quick-action')),
    };
  });

  return {
    direction: style.flexDirection,
    wrap: style.flexWrap,
    railBox,
    narrowBox,
    wideBox,
    // How far the row is painted beyond the card's own border box.
    escapeRight: railBox.right - narrowBox.right,
    escapeBottom: railBox.bottom - narrowBox.bottom,
    // The whole row sits BELOW the message: its top edge is at/after the card's
    // bottom edge (sub-pixel tolerance).
    startsAtOrBelowCardBottom: railBox.top >= narrowBox.bottom - 0.5,
    buttonsInsideCard: hits.filter((h) => h.buttonInsideCard).length,
    buttonCount: buttons.length,
    reachableCount: hits.filter((h) => h.hitIsButton).length,
    // Which card the buttons actually surface over when hit-tested.
    hitFrameIds: hits.map((h) => h.hitFrameId),
    overlapWithNextCard: verticalOverlap(railBox, wideBox),
  };
}

// The assertions that define "wrapped in the container OUTSIDE the message".
// Shared with both negative controls on purpose: the controls must be judged by
// exactly the same contract they are expected to violate.
function assertOutsideContract(state, label) {
  assert.ok(state.buttonCount >= 2, `${label}: expected at least Quote and Copy, saw ${state.buttonCount}`);

  // 1. "They are supposed to WRAP in the container" — a wrapping row, not a column.
  assert.equal(state.direction, 'row', `${label}: the rail must be a row that can wrap`);
  assert.equal(state.wrap, 'wrap', `${label}: the rail must wrap rather than overflow`);

  // 2. "OUTSIDE the message" — not one pixel of the row is inside the card.
  assert.equal(state.buttonsInsideCard, 0,
    `${label}: ${state.buttonsInsideCard} of ${state.buttonCount} buttons are painted INSIDE the message`);
  assert.ok(state.startsAtOrBelowCardBottom,
    `${label}: the row must start at or below the card's bottom edge `
    + `(row top ${state.railBox.top.toFixed(1)} vs card bottom ${state.narrowBox.bottom.toFixed(1)})`);

  // 3. "end up BEHIND another card" (owner, 2026-11-14) must stay fixed: the row
  //    is on screen, above everything, and belongs to its own card when hit-tested.
  assert.equal(state.reachableCount, state.buttonCount,
    `${label}: every button must be hit-testable, saw ${state.reachableCount}/${state.buttonCount}`);
  assert.deepEqual(state.hitFrameIds, new Array(state.buttonCount).fill(NARROW_ID),
    `${label}: every button must surface over its OWN card, saw ${JSON.stringify(state.hitFrameIds)}`);

  // 4. It must not cover the following message either.
  assert.equal(state.overlapWithNextCard, 0,
    `${label}: the row must not overlap the next card (overlapped ${state.overlapWithNextCard.toFixed(1)}px)`);
}

test('Puppeteer: frame quick actions wrap OUTSIDE the message', async (t) => {
  let chromePath = findChromeExecutable();
  if (!chromePath) {
    t.skip('Puppeteer quick-action coverage requires Chrome');
    return;
  }

  let fixture = await startStagehandUIServer({
    sessions: [ { id: 'session_rail_outside', title: 'Rail outside', messageCount: 3 } ],
  });
  fixture.frameRuntime.framesBySessionID.set('session_rail_outside', [
    frame(NARROW_ID, 'UserMessage', 1, 'ss'),
    frame(WIDE_ID, 'UserMessage', 2,
      'a much wider message that makes this card span most of the thread width, '
      + 'which is the card the old gutter rail used to end up behind'),
  ]);

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
        token: 'rail-outside-token', refresh_token: 'rail-outside-refresh',
      }));
    });
    await page.goto(`${fixture.baseURL}/?session=session_rail_outside`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForSelector(`kikx-frame-item[data-frame-id="${NARROW_ID}"]`, { timeout: 15000 });

    // Reveal the row the way a user does: hover the card.
    let anchor = await page.evaluate((id) => {
      let rect = document.querySelector(`kikx-frame-item[data-frame-id="${id}"]`).getBoundingClientRect();
      return { x: rect.x + 30, y: rect.y + rect.height / 2 };
    }, NARROW_ID);
    await page.mouse.move(anchor.x, anchor.y);
    await new Promise((resolve) => setTimeout(resolve, 350));

    let shipped = await page.evaluate(measureInPage);
    assert.equal(shipped.error, undefined, 'the rail must exist on a hovered frame');
    t.diagnostic(`shipped: escapeBottom=${shipped.escapeBottom.toFixed(1)}px `
      + `escapeRight=${shipped.escapeRight.toFixed(1)}px overlap=${shipped.overlapWithNextCard.toFixed(1)}px`);
    assertOutsideContract(shipped, 'shipped');

    // NEGATIVE CONTROL A — the arrangement that shipped before this change:
    // anchored to the card's bottom-right corner, INSIDE the card.
    let inCardTag = await page.addStyleTag({
      content: `
        .kikx-frame__quick-actions {
          top: auto; bottom: 8px; right: 8px;
          flex-direction: row; flex-wrap: wrap;
          width: auto; max-width: calc(100% - 16px);
          pointer-events: auto;
        }
        .kikx-frame:hover, .kikx-frame:focus-within { z-index: auto; }
      `,
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    let inCard = await page.evaluate(measureInPage);
    assert.ok(inCard.buttonsInsideCard > 0,
      'control A must actually reproduce the reported bug (buttons inside the message)');
    assert.throws(() => assertOutsideContract(inCard, 'control A'),
      'the contract must FAIL for the in-card arrangement, otherwise it proves nothing');
    t.diagnostic(`control A reproduced the bug: ${inCard.buttonsInsideCard}/${inCard.buttonCount} buttons inside the card`);
    // Controls must not leak into each other. The first version of this test left
    // control A's stylesheet in place, so B1 still ran with the rail pinned INSIDE
    // the card and reported narrow,narrow,narrow — the control looked like it
    // failed to discriminate when in fact the earlier control was still active.
    await inCardTag.evaluate((node) => node.remove());
    await new Promise((resolve) => setTimeout(resolve, 200));

    // NEGATIVE CONTROLS B1/B2 — the "end up BEHIND another card" failure (owner,
    // 2026-11-14) and the z-index lift that prevents it.
    //
    // Scoped honestly: with the shipped seam reserved, the next card does not
    // reach the rail band, so the lift never fires in this layout. It is
    // INSURANCE for any state where the seam is smaller than the row — the
    // mobile breakpoint, a future margin retune, or a card the reserved margin
    // does not apply to. These controls therefore FORCE that condition
    // (margin-block: 0 on every card, which is what makes the following card
    // overlap the rail band) and then toggle only the lift. Measured:
    //
    //   forced overlap, lift on  -> hitFrameIds narrow,narrow,narrow
    //   forced overlap, lift off -> hitFrameIds wide,wide,wide   ("BEHIND")
    //
    // The first version of this control only zeroed `margin-bottom`; the
    // surviving `margin-block` still supplied a 17.5px seam, the buttons stayed
    // clear, and the control failed to discriminate. Zero BOTH margins, or the
    // control proves nothing.
    await page.addStyleTag({
      content: `
        .kikx-frame { margin-top: 0 !important; margin-bottom: 0 !important; }
        /* B1: no card lift. */
        .kikx-frame:hover, .kikx-frame:focus-within { z-index: auto !important; }
      `,
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    let unLifted = await page.evaluate(measureInPage);
    assert.throws(() => assertOutsideContract(unLifted, 'control B1'),
      'the contract must FAIL when the card is not lifted, otherwise the lift proves nothing');
    assert.ok(
      unLifted.hitFrameIds.some((id) => id !== NARROW_ID),
      'control B1 must reproduce "BEHIND another card" (buttons resolving to the '
      + `following card), saw ${JSON.stringify(unLifted.hitFrameIds)}`,
    );
    t.diagnostic(`control B1 reproduced "BEHIND another card": buttons resolved to `
      + `${JSON.stringify(unLifted.hitFrameIds)} instead of ${NARROW_ID}`);

    // B2: same forced overlap, lift restored. The buttons must return to their own
    // card's rail purely because the CARD was lifted — that is the fix under test.
    await page.addStyleTag({
      content: `.kikx-frame:hover, .kikx-frame:focus-within { z-index: 2 !important; }`,
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    let lifted = await page.evaluate(measureInPage);
    assert.deepEqual(lifted.hitFrameIds, new Array(lifted.buttonCount).fill(NARROW_ID),
      'with the card lifted, the rail must paint above the following card '
      + `(saw ${JSON.stringify(lifted.hitFrameIds)})`);
    t.diagnostic(`control B2: lifting the card alone restored `
      + `${lifted.reachableCount}/${lifted.buttonCount} buttons to their own rail`);
  } finally {
    await browser?.close();
    await fixture.close();
  }
});
