'use strict';

// Owner annotation (session-2026-11-17-17-39-05.907.png), verbatim:
//
//   "Invisible container on the side... items WRAP in this container
//    (when the container doesn't have enough vertical space)."
//
// The drawing shows a rectangle to the RIGHT of the message card holding the
// three action buttons — one on top, two below — with a red X through the row of
// buttons that currently sits BELOW the card. So this retires BOTH previous
// arrangements:
//
//   * inside the CARD        (23ccab4b, "wrap inside their container" read as card)
//   * a ROW BELOW the card   (77a8fc4a, "OUTSIDE the message" read as below)
//
// and asks for a third: a container BESIDE the card, exactly as tall as the card,
// whose items stack vertically and WRAP INTO A SECOND COLUMN when the vertical
// space runs out.
//
// RIGHT, not left — measured against the real cascade, not assumed. Participant
// cards are flush LEFT (spaceLeft 0px, a left rail would land on other content),
// while both card alignments leave free space to the right (operator cards
// 96-106px, participant cards 294-587px).
//
// Everything is measured on the rendered page. A CSS-text assertion cannot tell
// "the rule that says beside" from "the buttons are painted beside", and CSS text
// is exactly what let the previous wrong arrangement pass its own test.
//
// Three controls run the SAME contract and must fail it:
//   A. the row-below-the-card arrangement (77a8fc4a)
//   B. a vertical rail that does not wrap (the pre-23ccab4b rail's failure —
//      "push down too far vertically")
//   C. the wrap case itself, on a container deliberately given only one row of
//      vertical space, so the "wrap when there isn't enough vertical space"
//      branch is actually exercised rather than assumed reachable.

import assert from 'node:assert/strict';
import test from 'node:test';

import puppeteer from 'puppeteer-core';

import { findChromeExecutable, startStagehandUIServer } from '../stagehand/stagehand-test-utils.mjs';

const NARROW_ID = 'side_container_narrow';
const WIDE_ID = 'side_container_wide';

function frame(id, type, order, text) {
  let timestamp = 1793328600000000 + order * 1000000;
  return {
    id,
    type,
    sessionID: 'session_side_container',
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
  const NARROW = 'side_container_narrow';
  const WIDE = 'side_container_wide';

  function box(node) {
    if (!node)
      return null;
    let rect = node.getBoundingClientRect();
    return {
      left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
      width: rect.width, height: rect.height,
    };
  }

  let narrowItem = document.querySelector(`kikx-frame-item[data-frame-id="${NARROW}"]`);
  let wideItem = document.querySelector(`kikx-frame-item[data-frame-id="${WIDE}"]`);
  let rail = narrowItem?.querySelector('.kikx-frame__quick-actions');
  if (!rail || !narrowItem)
    return { error: 'no rail' };

  let list = document.querySelector('.kikx-frame-list');
  let listRect = list.getBoundingClientRect();
  let listStyle = getComputedStyle(list);
  let contentRight = listRect.right - (parseFloat(listStyle.paddingRight) || 0);

  let railBox = box(rail);
  let cardBox = box(narrowItem);
  let wideBox = box(wideItem);

  let buttons = [ ...rail.querySelectorAll('.kikx-frame__quick-action') ];
  let rects = buttons.map((button) => button.getBoundingClientRect());

  // Grid columns/rows read from the BUTTONS, not from CSS text: distinct
  // horizontal positions are columns, distinct vertical positions are rows.
  let cols = new Set(rects.map((r) => Math.round(r.left))).size;
  let rows = new Set(rects.map((r) => Math.round(r.top))).size;

  let hits = buttons.map((button) => {
    let rect = button.getBoundingClientRect();
    let hit = document.elementFromPoint(
      Math.round(rect.left + rect.width / 2),
      Math.round(rect.top + rect.height / 2),
    );
    return {
      hitFrameId: hit?.closest?.('kikx-frame-item')?.dataset?.frameId || null,
      hitIsButton: Boolean(hit?.closest?.('.kikx-frame__quick-action')),
    };
  });

  return {
    railBox,
    cardBox,
    wideBox,
    buttonCount: buttons.length,
    cols,
    rows,
    // "on the side": every button fully to the right of the card's border box.
    buttonsInsideCard: rects.filter((r) => r.left < cardBox.right - 0.5).length,
    // How far each button dips BELOW the card — the failure the old column rail
    // produced ("push down too far vertically") and that wrapping must prevent.
    maxBottomExcess: Math.max(0, ...rects.map((r) => r.bottom - cardBox.bottom)),
    // Does the vertical content overflow the container it was given? A rail that
    // cannot wrap grows scrollHeight past clientHeight instead of wrapping.
    overflowsVertically: rail.scrollHeight - rail.clientHeight > 1,
    // The container is the card's height (that is what "not enough vertical
    // space" is measured against) when it has not been constrained by a control.
    railTopVsCardTop: railBox.top - cardBox.top,
    railBottomVsCardBottom: railBox.bottom - cardBox.bottom,
    reachableCount: hits.filter((h) => h.hitIsButton).length,
    hitFrameIds: hits.map((h) => h.hitFrameId),
    // Must not push the thread into horizontal scrolling.
    horizontalOverflow: list.scrollWidth - list.clientWidth,
    railWithinList: railBox.right <= contentRight + 0.5,
  };
}

// The assertions that define "items in a container on the side, wrapping when
// the vertical space runs out". Shared with every control on purpose: a control
// must be judged by exactly the contract it is expected to violate.
function assertSideContainerContract(state, label) {
  assert.ok(state.buttonCount >= 2,
    `${label}: expected at least Quote and Copy, saw ${state.buttonCount}`);

  // 1. ON THE SIDE — not one button may overlap the card's box.
  assert.equal(state.buttonsInsideCard, 0,
    `${label}: ${state.buttonsInsideCard} of ${state.buttonCount} buttons overlap the message`);
  assert.ok(state.buttonsInsideCard === 0 && state.railBox.left >= state.cardBox.right - 0.5,
    `${label}: the container must sit to the RIGHT of the card `
    + `(rail left ${state.railBox.left.toFixed(1)} vs card right ${state.cardBox.right.toFixed(1)})`);

  // 2. Not below it, either — that is the arrangement this change retires.
  assert.equal(state.maxBottomExcess, 0,
    `${label}: no button may hang below the card (worst was ${state.maxBottomExcess.toFixed(1)}px below)`);

  // 3. The container's vertical budget is the card's: it neither spills past the
  //    card's bottom nor floats above its top.
  assert.ok(state.railBottomVsCardBottom <= 0.5 && state.railTopVsCardTop >= -0.5,
    `${label}: the container must be contained by the card's height `
    + `(top ${state.railTopVsCardTop.toFixed(1)}, bottom ${state.railBottomVsCardBottom.toFixed(1)})`);

  // 4. WRAP, never overflow: whatever vertical space it was given, the items fit.
  assert.equal(state.overflowsVertically, false,
    `${label}: the items must WRAP inside the container instead of overflowing it `
    + `(scrollHeight exceeds clientHeight by more than 1px)`);

  // 5. It must not make the thread scroll sideways.
  assert.equal(state.horizontalOverflow, 0,
    `${label}: the container must not overflow the thread horizontally `
    + `(${state.horizontalOverflow}px wider than the list)`);
  assert.ok(state.railWithinList,
    `${label}: the container's right edge must stay inside the scroll container`);

  // 6. Hover/keyboard reachability and the 2026-11-14 "BEHIND another card" fix
  //    must both survive the move: every button is hit-testable and resolves to
  //    its OWN card's rail.
  assert.equal(state.reachableCount, state.buttonCount,
    `${label}: every button must be hit-testable, saw ${state.reachableCount}/${state.buttonCount}`);
  assert.deepEqual(state.hitFrameIds, new Array(state.buttonCount).fill(NARROW_ID),
    `${label}: every button must surface over its OWN card, saw ${JSON.stringify(state.hitFrameIds)}`);
}

test('Puppeteer: frame quick actions live in a container on the SIDE of the message', async (t) => {
  let chromePath = findChromeExecutable();
  if (!chromePath) {
    t.skip('Puppeteer quick-action coverage requires Chrome');
    return;
  }

  let fixture = await startStagehandUIServer({
    sessions: [ { id: 'session_side_container', title: 'Side container', messageCount: 3 } ],
  });
  fixture.frameRuntime.framesBySessionID.set('session_side_container', [
    frame(NARROW_ID, 'UserMessage', 1, 'ss'),
    frame(WIDE_ID, 'UserMessage', 2,
      'a much wider message that makes this card span most of the thread width, '
      + 'which is the card a below-the-message rail used to cover'),
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
        token: 'side-container-token', refresh_token: 'side-container-refresh',
      }));
    });
    await page.goto(`${fixture.baseURL}/?session=session_side_container`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForSelector(`kikx-frame-item[data-frame-id="${NARROW_ID}"]`, { timeout: 15000 });

    // Reveal the rail the way a user does: hover the card.
    let anchor = await page.evaluate((id) => {
      let rect = document.querySelector(`kikx-frame-item[data-frame-id="${id}"]`).getBoundingClientRect();
      return { x: rect.x + 30, y: rect.y + rect.height / 2 };
    }, NARROW_ID);
    await page.mouse.move(anchor.x, anchor.y);
    await new Promise((resolve) => setTimeout(resolve, 350));

    // ---- SHIPPED, natural vertical space ----
    let shipped = await page.evaluate(measureInPage);
    assert.equal(shipped.error, undefined, 'the rail must exist on a hovered frame');
    t.diagnostic(`shipped: ${shipped.buttonCount} buttons, cols=${shipped.cols} rows=${shipped.rows}, `
      + `rail left=${shipped.railBox.left.toFixed(1)} card right=${shipped.cardBox.right.toFixed(1)}, `
      + `below-card=${shipped.maxBottomExcess.toFixed(1)}px`);
    assertSideContainerContract(shipped, 'shipped');

    // With the card's full height available, the items must STACK VERTICALLY in a
    // single column — the drawing shows them down the side, not spread sideways.
    assert.equal(shipped.cols, 1,
      `shipped: with the card's full height the items must form ONE column, saw ${shipped.cols}`);
    assert.equal(shipped.rows, shipped.buttonCount,
      `shipped: all ${shipped.buttonCount} items must stack vertically, saw ${shipped.rows} rows`);

    // ---- THE WRAP CASE (annotation: "not enough vertical space") ----
    // Give the container room for exactly TWO rows (30px + 6px gap + 30px) when
    // it holds three items. One column can no longer fit them, so they MUST wrap
    // into a second column -- the shape drawn in the annotation (one item on one
    // side, two on the other).
    //
    // Deliberately NOT one row: three single-item columns need 30*3 + 6*2 = 102px
    // of horizontal room, and a right-flush operator card only leaves ~98px
    // between its right edge and the scroll container. That 4px shortfall is a
    // property of the narrowest realistic budget, not of the wrap mechanism, so
    // forcing it would have produced a horizontal overflow and a false failure
    // (it did, on the first run of this spec). Two rows needs 30*2 + 6 = 66px and
    // fits comfortably. The horizontal budget is asserted below so the limit is
    // recorded rather than left to be discovered later.
    let shortTag = await page.addStyleTag({
      content: `
        .kikx-frame__quick-actions {
          bottom: auto !important;
          height: 66px !important;
          opacity: 1 !important;
          pointer-events: auto !important;
        }
      `,
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    let wrapped = await page.evaluate(measureInPage);
    t.diagnostic(`short container: cols=${wrapped.cols} rows=${wrapped.rows} `
      + `overflow=${wrapped.overflowsVertically} below-card=${wrapped.maxBottomExcess.toFixed(1)}px`);
    assert.equal(wrapped.cols, 2,
      `with room for only two rows the three items must WRAP into exactly two columns, `
      + `saw ${wrapped.cols}`);
    assert.equal(wrapped.rows, 2,
      `the wrapped layout must use the two rows it was given, saw ${wrapped.rows}`);
    assert.equal(wrapped.buttonCount, 3,
      `all three actions must survive the wrap, saw ${wrapped.buttonCount}`);
    assert.equal(wrapped.overflowsVertically, false,
      'wrapping must replace overflowing, not happen alongside it');
    assertSideContainerContract(wrapped, 'wrap');

    // ---- CONTROL A: the arrangement this change retires (a row BELOW the card) ----
    await shortTag.evaluate((node) => node.remove());
    let belowTag = await page.addStyleTag({
      content: `
        .kikx-frame__quick-actions {
          top: calc(100% + var(--kikx-frame-border-width)) !important;
          bottom: auto !important;
          left: auto !important;
          right: 0 !important;
          display: flex !important;
          flex-direction: row !important;
          flex-wrap: wrap !important;
          height: auto !important;
          justify-content: flex-end !important;
          opacity: 1 !important;
          pointer-events: auto !important;
        }
        .kikx-frame:hover, .kikx-frame:focus-within { z-index: 2; }
      `,
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    let below = await page.evaluate(measureInPage);
    assert.throws(() => assertSideContainerContract(below, 'control A'),
      'the contract must FAIL for the below-the-card arrangement, otherwise it proves nothing');
    assert.ok(below.railBox.top >= below.cardBox.bottom - 0.5,
      'control A must actually reproduce the retired shape (row starting below the card), '
      + `saw rail top ${below.railBox.top.toFixed(1)} vs card bottom ${below.cardBox.bottom.toFixed(1)}`);
    t.diagnostic('control A reproduced the retired below-the-card row: '
      + `rail top ${below.railBox.top.toFixed(1)} >= card bottom ${below.cardBox.bottom.toFixed(1)}`);
    // Controls must not leak into each other — an earlier control left in place
    // once made a later control look like it failed to discriminate.
    await belowTag.evaluate((node) => node.remove());
    await new Promise((resolve) => setTimeout(resolve, 200));

    // ---- CONTROL B: a side rail that does NOT wrap ----
    // This is the pre-23ccab4b rail's failure ("push down too far vertically"):
    // a plain flex column given less height than its items needs simply overflows
    // the container instead of wrapping. Same one-row budget as the wrap test, so
    // the ONLY difference between this and `wrapped` is the wrap mechanism.
    let noWrapTag = await page.addStyleTag({
      content: `
        .kikx-frame__quick-actions {
          bottom: auto !important;
          height: 66px !important;
          display: flex !important;
          flex-direction: column !important;
          flex-wrap: nowrap !important;
          opacity: 1 !important;
          pointer-events: auto !important;
        }
      `,
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    let noWrap = await page.evaluate(measureInPage);
    assert.equal(noWrap.overflowsVertically, true,
      'control B must actually reproduce the non-wrapping overflow, otherwise the '
      + 'wrap assertion proves nothing');
    assert.throws(() => assertSideContainerContract(noWrap, 'control B'),
      'the contract must FAIL for a non-wrapping vertical rail');
    t.diagnostic('control B reproduced the non-wrapping overflow: '
      + `cols=${noWrap.cols} rows=${noWrap.rows} overflow=${noWrap.overflowsVertically}`);
    await noWrapTag.evaluate((node) => node.remove());

    // ---- Spacing cost is gone ----
    // The previous arrangement reserved 1em + 24px beneath every card and 38px
    // under the list purely to keep a below-the-card row off the next message.
    // With the rail on the side that reservation must be gone, so the seam is the
    // plain 1em again rather than something the user pays for nothing.
    let spacing = await page.evaluate(() => {
      let item = document.querySelector('kikx-frame-item[data-frame-id="side_container_narrow"]');
      let stream = document.querySelector('.kikx-frame-stream');
      let itemStyle = getComputedStyle(item);
      return {
        marginBottom: parseFloat(itemStyle.marginBottom),
        fontSize: parseFloat(itemStyle.fontSize),
        streamPaddingBottom: parseFloat(getComputedStyle(stream).paddingBottom),
      };
    });
    // Horizontal budget, recorded so the wrap's limit is explicit: a 3-item
    // wrap needs one column per item that does not fit vertically. With the
    // current three actions a right-flush operator card (the tightest case)
    // leaves room for two columns + gap, which is why the wrap above asks for
    // two. A future fourth action would need a different arrangement, and this
    // assertion is where that would surface.
    // The true clip boundary is NOT the scroll container's content edge. The
    // AEOR scrollview page owns a `padding-right: 96px` that exists precisely so
    // an outboard Kikx rail can paint outside the card:
    //   aeor-web-components/components/aeor-scrollview.css
    //   .aeor-scrollview__page { padding-right: 96px; content-visibility: auto }
    // with the comment "Reserve room for consumers' overhanging chrome (Kikx's
    // quick-action rail ...)". `content-visibility` gives paint containment, which
    // clips descendants at the PAGE's padding box. So the rail may occupy the
    // page's padding area, and everything beyond it is unreachable no matter what
    // the geometry says.
    //
    // An earlier version of this spec measured against the LIST's content edge
    // (1261) instead of the page's padding box (1251) and so over-reported the
    // budget by the 10px scrollbar gutter. Measure the real boundary.
    let budget = await page.evaluate((id) => {
      let item = document.querySelector(`kikx-frame-item[data-frame-id="${id}"]`);
      let pageNode = item.closest('.aeor-scrollview__page');
      let cardRect = item.getBoundingClientRect();
      let pageRect = pageNode.getBoundingClientRect();
      return {
        cardRight: cardRect.right,
        // Padding box: padding is inside paint containment, so this is paintable.
        clipRight: pageRect.right,
        pagePaddingRight: parseFloat(getComputedStyle(pageNode).paddingRight) || 0,
      };
    }, NARROW_ID);
    let available = budget.clipRight - budget.cardRight - 8;
    t.diagnostic(`horizontal budget right of card: ${available.toFixed(1)}px `
      + `(page padding-right ${budget.pagePaddingRight}px; 2 columns need 66px, 3 need 102px)`);
    assert.ok(available >= 66,
      `a two-column wrap must fit beside the card, available ${available.toFixed(1)}px`);
    // Record the hard ceiling: a third column needs 30*3 + 6*2 = 102px plus the
    // 8px gap, which exceeds the reserved 96px. A future fourth action must not
    // be added without widening the reservation in the vendor stylesheet.
    assert.ok(available + 8 <= budget.pagePaddingRight + 0.5,
      `the rail must fit inside the page's reserved overhang room `
      + `(needs ${(available + 8).toFixed(1)}px, reserved ${budget.pagePaddingRight}px)`);

    t.diagnostic(`spacing: margin-bottom=${spacing.marginBottom.toFixed(1)}px `
      + `(1em=${spacing.fontSize.toFixed(1)}px), list padding-bottom=${spacing.streamPaddingBottom.toFixed(1)}px`);
    assert.ok(Math.abs(spacing.marginBottom - spacing.fontSize) <= 0.5,
      `the seam between messages must be the natural 1em again, saw ${spacing.marginBottom.toFixed(1)}px `
      + `against 1em = ${spacing.fontSize.toFixed(1)}px`);
    assert.ok(spacing.streamPaddingBottom <= 2,
      `the list must no longer reserve a button row beneath the last card, `
      + `saw ${spacing.streamPaddingBottom.toFixed(1)}px`);
  } finally {
    await browser?.close();
    await fixture.close();
  }
});
