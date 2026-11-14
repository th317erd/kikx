'use strict';

// Owner annotation (session-2026-11-14-02-02-31.771.png), verbatim:
//
//   "Quick-action buttons can end up BEHIND another card, or push down too far
//    vertically. Can we have them wrap inside their container please?"
//
// The quick-action rail used to be a vertical COLUMN parked in a 72px gutter
// outside the frame surface (`position: absolute; top: 8px; right: -44px;
// flex-direction: column`). Two consequences, one per clause of the annotation:
//
//   * absolutely positioned outside its card's box, a later sibling card paints
//     over it -> "end up BEHIND another card";
//   * a 3-button column is taller than a short card -> "push down too far
//     vertically".
//
// The fix anchors the rail INSIDE the card as a wrapping row at the card's
// bottom-right. These assertions are geometric (getBoundingClientRect and
// elementFromPoint), because a CSS-text assertion cannot distinguish "the rail
// is inside its card" from "the rule that says so exists".
//
// A negative control restores the old geometry in-page and requires the same
// assertions to FAIL, so a test that passes with and without the fix cannot
// masquerade as evidence.

import assert from 'node:assert/strict';
import test from 'node:test';

import puppeteer from 'puppeteer-core';

import { findChromeExecutable, startStagehandUIServer } from '../stagehand/stagehand-test-utils.mjs';

function frame(id, type, order, text) {
  let timestamp = 1793328600000000 + order * 1000000;
  return {
    id,
    type,
    sessionID: 'session_rail',
    interactionID: `interaction_${order}`,
    parentID: null,
    authorType: type === 'UserMessage' ? 'user' : 'agent',
    authorID: type === 'UserMessage' ? 'owner' : 'agent',
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

// A NARROW card above a WIDE card is the arrangement that exposes the bug: the
// narrow card's gutter rail sits where the wide card below will paint.
const NARROW_ID = 'rail_narrow';
const WIDE_ID = 'rail_wide';

function measureInPage() {
  function box(node) {
    if (!node)
      return null;
    let rect = node.getBoundingClientRect();
    return {
      left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
      width: rect.width, height: rect.height,
    };
  }
  function overlapWidth(a, b) {
    if (!a || !b)
      return 0;
    let horizontal = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    let vertical = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    return horizontal > 0 && vertical > 0 ? horizontal : 0;
  }

  // This function is serialised into the page: it cannot see module scope.
  const NARROW_ID = 'rail_narrow';
  const WIDE_ID = 'rail_wide';
  let narrow = document.querySelector(`kikx-frame-item[data-frame-id="${NARROW_ID}"]`);
  let wide = document.querySelector(`kikx-frame-item[data-frame-id="${WIDE_ID}"]`);
  let rail = narrow?.querySelector('.kikx-frame__quick-actions');
  if (!rail)
    return { error: 'no rail' };

  let railBox = box(rail);
  let narrowBox = box(narrow);
  let wideBox = box(wide);
  let style = getComputedStyle(rail);

  let buttons = [ ...rail.querySelectorAll('.kikx-frame__quick-action') ];
  let reachable = buttons.map((button) => {
    let rect = button.getBoundingClientRect();
    let hit = document.elementFromPoint(
      Math.round(rect.left + rect.width / 2),
      Math.round(rect.top + rect.height / 2),
    );
    return hit?.closest?.('kikx-frame-item')?.dataset?.frameId === NARROW_ID;
  });

  return {
    direction: style.flexDirection,
    wrap: style.flexWrap,
    railBox,
    narrowBox,
    wideBox,
    // > 0 means the rail paints outside its own card on the right.
    escapeRight: railBox.right - narrowBox.right,
    escapeBottom: railBox.bottom - narrowBox.bottom,
    overlapWithNextCard: overlapWidth(railBox, wideBox),
    buttonCount: buttons.length,
    reachableCount: reachable.filter(Boolean).length,
  };
}

test('Puppeteer: frame quick actions wrap inside their own card', async (t) => {
  let chromePath = findChromeExecutable();
  if (!chromePath) {
    t.skip('Puppeteer quick-action coverage requires Chrome');
    return;
  }

  let fixture = await startStagehandUIServer({
    sessions: [ { id: 'session_rail', title: 'Rail', messageCount: 3 } ],
  });
  fixture.frameRuntime.framesBySessionID.set('session_rail', [
    frame(NARROW_ID, 'UserMessage', 1, 'ss'),
    frame(WIDE_ID, 'UserMessage', 2,
      'a much wider message that makes this card span most of the thread width, '
      + 'which is what puts the following card over the previous card action rail'),
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
        token: 'rail-test-token', refresh_token: 'rail-test-refresh',
      }));
    });
    await page.goto(`${fixture.baseURL}/?session=session_rail`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForSelector(`kikx-frame-item[data-frame-id="${NARROW_ID}"]`, { timeout: 15000 });

    // Reveal the rail the way a user does: hover the card.
    let anchor = await page.evaluate((id) => {
      let rect = document.querySelector(`kikx-frame-item[data-frame-id="${id}"]`).getBoundingClientRect();
      return { x: rect.x + 30, y: rect.y + rect.height / 2 };
    }, NARROW_ID);
    await page.mouse.move(anchor.x, anchor.y);
    await new Promise((resolve) => setTimeout(resolve, 300));

    let shipped = await page.evaluate(measureInPage);
    assert.equal(shipped.error, undefined, 'the rail must exist on a hovered frame');
    assert.ok(shipped.buttonCount >= 2, `expected at least Quote and Copy, saw ${shipped.buttonCount}`);

    // 1. "wrap inside their container" — a horizontal wrapping row, not a column.
    assert.equal(shipped.direction, 'row', 'the rail is a row that can wrap, not a vertical column');
    assert.equal(shipped.wrap, 'wrap', 'the rail wraps rather than overflowing');

    // 2. The rail never paints outside its own card.
    assert.ok(shipped.escapeRight <= 0.5,
      `the rail must not paint past its card's right edge (escaped ${shipped.escapeRight.toFixed(1)}px)`);
    assert.ok(shipped.escapeBottom <= 0.5,
      `the rail must not paint past its card's bottom edge (escaped ${shipped.escapeBottom.toFixed(1)}px)`);
    assert.equal(shipped.overlapWithNextCard, 0,
      'the rail must not overlap the following card');

    // 3. "push down too far vertically" — the row cannot be taller than the card.
    assert.ok(shipped.railBox.height <= shipped.narrowBox.height,
      `rail height ${shipped.railBox.height} must fit inside card height ${shipped.narrowBox.height}`);

    // 4. Every button still belongs to its own card when hit-tested.
    assert.equal(shipped.reachableCount, shipped.buttonCount,
      'every quick-action button must be hit-testable inside its own card');

    // NEGATIVE CONTROL: restore the old gutter geometry in-page. If the
    // assertions above are insensitive, this control would still pass.
    await page.addStyleTag({
      content: `
        .kikx-frame__quick-actions {
          top: 8px; bottom: auto; right: -44px;
          flex-direction: column; flex-wrap: nowrap; max-width: none;
        }
        .kikx-frame__hover-target { inset: -6px -52px -6px -6px; }
      `,
    });
    let control = await page.evaluate(measureInPage);
    assert.equal(control.direction, 'column', 'control must actually restore the old column');
    assert.ok(control.escapeRight > 20,
      `control must reproduce the rail escaping its card (escaped ${control.escapeRight.toFixed(1)}px)`);
    if (control.overlapWithNextCard > 0 || control.escapeRight > 20)
      t.diagnostic(`control reproduced the bug: escapeRight=${control.escapeRight.toFixed(1)}px, overlapWithNextCard=${control.overlapWithNextCard.toFixed(1)}px`);
  } finally {
    await browser.close();
    await fixture.close();
  }
});
