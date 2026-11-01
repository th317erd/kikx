'use strict';

// Rendered proof for user-message delivery, in a real browser.
//
// WHY THIS EXISTS ALONGSIDE THE DOM SPEC
// `spec/client/user-message-delivery-dom-spec.mjs` proves the element gets
// `data-delivery`, the modifier class and an `aria-label`. All three are
// *attributes*. None of them proves the stylesheet actually applies: the visual
// signal is `box-shadow: inset 3px 0 0 var(--kikx-frame-delivery-color)`
// (styles/app.css:698) and the caption is a `::after` pseudo-element
// (styles/app.css:701) whose text never enters `textContent`. A spec that only
// reads attributes cannot tell a working feature from a class that no selector
// matches, a token that fails to resolve, or a `content:` string that was
// edited to something else. That class of blindness is exactly what this lane
// closes.
//
// WHAT IS ASSERTED
//   1. neutral renders as nothing: no inset, no caption, no announced label.
//      "Nothing" here is measured, not assumed: an element with no generated
//      content computes `content: normal` and no shadow computes `none`.
//      Note the two elements carry the state differently and BOTH are pinned:
//      the frame item reports `data-delivery="neutral"` (a real state, because
//      the item owns the modifier class), while the bubble element omits the
//      attribute entirely. A future change that makes them disagree fails here.
//   2. `received` applies: the inset exists, its colour resolves to a real
//      colour (not an empty/invalid token), the caption reads "Received" and the
//      bubble announces itself to assistive tech.
//   3. the owner's "grey is fine" constraint is pinned: the computed background
//      colour of the frame is identical before and after delivery. A future
//      change that recolours the bubble instead of adding a quiet accent fails
//      here rather than shipping.
//   4. the update arrives on the live event path, in place: the frame item node
//      is the same object before and after `frame.updated`, and the rendered
//      text survives. A rebuild would drop the node identity.
//   5. the state is reversible: flipping back to neutral removes the class, the
//      caption and the label, so a stale tint cannot stick to a message.
//
// WHY TWO FRAMES
// The agent's reply is present so the user message is not the only frame in the
// thread. That keeps the assertion honest about *which* frame carries delivery:
// only the UserMessage may ever be tinted.

import assert from 'node:assert/strict';
import test from 'node:test';

import puppeteer from 'puppeteer-core';

import { findChromeExecutable, startStagehandUIServer } from '../stagehand/stagehand-test-utils.mjs';

const RECEIVED_LABEL = 'Received by the agent';

function userFrame(overrides = {}) {
  let timestamp = 1793328600000000;
  return {
    id: 'frame_delivery_1',
    type: 'UserMessage',
    sessionID: 'session_delivery',
    interactionID: 'interaction_delivery_1',
    authorType: 'user',
    authorID: 'owner',
    authorDisplayName: 'Wyatt',
    hidden: false,
    deleted: false,
    order: 1,
    timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
    content: { text: 'Please implement the delivery status for my message.' },
    ...overrides,
  };
}

function replyFrame() {
  let timestamp = 1793328601000000;
  return {
    id: 'frame_reply_1',
    type: 'AgentMessage',
    sessionID: 'session_delivery',
    interactionID: 'interaction_delivery_1',
    authorType: 'agent',
    authorID: 'agent_1',
    authorDisplayName: 'Bode',
    hidden: false,
    deleted: false,
    order: 2,
    timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
    content: { text: 'On it.' },
  };
}

// Everything that matters about the rendered state, read from the live page.
// Computed style, not attributes: this is the layer the DOM spec cannot see.
function readDelivery(page) {
  return page.evaluate((expectedLabel) => {
    let item = document.querySelector('kikx-frame-item[data-frame-id="frame_delivery_1"]');
    if (!item)
      return { present: false };

    let content = item.querySelector('.kikx-frame__content--user-message');
    let bubble = item.querySelector('kikx-user-message-frame');
    let itemStyle = getComputedStyle(item);
    // The caption lives on the ::after pseudo-element, NOT on the element: the
    // element's own computed `content` is always `normal`, so it must be read
    // with the second argument or the assertion is structurally blind.
    let afterStyle = content ? getComputedStyle(content, '::after') : null;

    return {
      present: true,
      // The inset is the visual signal; `none` is the absence of it.
      boxShadow: itemStyle.boxShadow,
      background: itemStyle.backgroundColor,
      // The caption text lives only in CSS, so computed style is the only way
      // to read it. No generated content computes as `normal` (an element with
      // no ::after rule never reports `none`).
      afterContent: afterStyle ? afterStyle.content : null,
      hasModifierClass: item.classList.contains('kikx-frame--delivery-received'),
      dataDelivery: item.getAttribute('data-delivery'),
      bubbleDelivery: bubble ? bubble.getAttribute('data-delivery') : null,
      ariaLabel: bubble ? bubble.getAttribute('aria-label') : null,
      expectedLabel,
      text: content ? content.textContent : null,
      // Proof the item is a live node and not a detached copy.
      connected: item.isConnected,
    };
  }, RECEIVED_LABEL);
}

// No generated content computes as `normal` or `none`; real content is a quoted
// string such as `"Received"`. Normalising both absences to '' keeps the
// neutral assertions readable and stops 'normal' from looking like a caption.
function captionText(value) {
  if (!value || value === 'none' || value === 'normal')
    return '';
  return String(value).replace(/^['"]|['"]$/g, '');
}

// A class landing and the computed style settling are NOT the same instant, and
// this is measured, not assumed. The shared frame shell declares a multiline
// `transition` that includes `box-shadow 180ms ease` (styles/app.css:941),
// so the delivery accent fades in and out over ~180ms. Sampling on the class flip
// returned `oklab(0.73303 -0.161978 0.0790371 / 0.0839879) 0.251964px ... inset`
// on the way in and `... / 0.916817) 2.75045px ... inset` on the way out: the
// spread and alpha scaled by the SAME factor, which is indistinguishable from a
// broken colour token if read once. `document.getAnimations()` confirms it is a
// real CSSTransition on `box-shadow` targeting the frame item.
//
// So the spec waits for the settled value in BOTH directions and asserts on that.
// Asserting on a transitional frame would make this spec flaky; asserting on a
// magic threshold would hide the very spread it is meant to pin.
async function waitForSettledShadow(page, label, isSettled) {
  let deadline = Date.now() + 5000;
  let first = null;
  let last = null;
  while (Date.now() < deadline) {
    last = await page.evaluate(() => {
      let item = document.querySelector('kikx-frame-item[data-frame-id="frame_delivery_1"]');
      let style = item ? getComputedStyle(item) : null;
      return {
        boxShadow: style ? style.boxShadow : null,
        // A running transition means the value is mid-flight, whatever it reads.
        animating: item ? item.getAnimations().some((animation) => animation.playState === 'running') : false,
      };
    });
    if (first === null)
      first = last;
    if (last && last.boxShadow !== null && !last.animating && isSettled(last.boxShadow))
      return { settled: last.boxShadow, first: first?.boxShadow ?? null };
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`${label}: shadow never settled within 5000ms, last=${JSON.stringify(last)}`);
}

// The accent COLOUR must be pinned, not just "some 3px inset exists".
//
// This was found by a failed negative control: replacing
// `var(--kikx-frame-delivery-color)` with a hardcoded neutral grey still passed,
// because the assertions only required a 3px opaque inset of any colour. A spec
// that cannot tell the delivery accent from a grey border is not guarding the
// feature. So resolve the token through the real cascade and require the painted
// inset to BE that colour.
//
// Both values are produced by the same serialisation path - a probe carrying the
// token inside the item, and the item's own shadow - so the comparison does not
// depend on guessing Chrome's colour format for a given syntax.
function resolveAccentColours(page) {
  return page.evaluate(() => {
    let item = document.querySelector('kikx-frame-item[data-frame-id="frame_delivery_1"]');
    let probe = document.createElement('div');
    // Absolute + zero size so appending cannot shift the thread layout, and
    // removed before returning so the DOM is unchanged by measuring it.
    probe.style.position = 'absolute';
    probe.style.width = '0';
    probe.style.height = '0';
    probe.style.boxShadow = 'inset 3px 0 0 var(--kikx-frame-delivery-color)';
    item.appendChild(probe);
    let tokenShadow = getComputedStyle(probe).boxShadow;
    probe.remove();

    let painted = getComputedStyle(item).boxShadow;
    // Strip the geometry tail (`3px 0px 0px 0px inset`) to leave the colour.
    let strip = (value) => String(value).replace(/\s-?[\d.]+px[\s\S]*$/, '').trim();
    return { tokenColour: strip(tokenShadow), paintedColour: strip(painted), painted, tokenShadow };
  });
}

test('Puppeteer renders user-message delivery as an accent, never a recolour', async (t) => {
  let chromePath = findChromeExecutable();
  if (!chromePath) {
    t.skip('Puppeteer delivery coverage requires Chrome');
    return;
  }

  let fixture = await startStagehandUIServer({
    sessions: [ { id: 'session_delivery', title: 'Delivery Session', messageCount: 2 } ],
  });
  fixture.frameRuntime.framesBySessionID.set('session_delivery', [ userFrame(), replyFrame() ]);

  let browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: 'new',
    args: [ '--no-sandbox', '--disable-setuid-sandbox' ],
  });
  try {
    let page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.evaluateOnNewDocument(() => {
      sessionStorage.setItem('kikx.auth.session', JSON.stringify({ token: 'delivery-test-token', refresh_token: 'delivery-test-refresh' }));
    });
    await page.goto(`${fixture.baseURL}/?session=session_delivery`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForSelector('kikx-frame-item[data-frame-id="frame_delivery_1"] .kikx-frame__content--user-message', { timeout: 15000 });

    // ---- 1. neutral renders as nothing, measured ---------------------------------
    let neutral = await readDelivery(page);
    assert.equal(neutral.present, true, 'the user message must render');
    assert.equal(neutral.connected, true, 'the user message must be attached');
    assert.equal(neutral.boxShadow, 'none', 'neutral must add no inset accent');
    assert.equal(captionText(neutral.afterContent), '', 'neutral must render no caption');
    assert.equal(neutral.hasModifierClass, false, 'neutral must carry no delivery modifier');
    assert.equal(neutral.dataDelivery, 'neutral', 'the item reports neutral as a real state');
    assert.equal(neutral.bubbleDelivery, null, 'the bubble must carry no delivery attribute while neutral');
    assert.equal(neutral.ariaLabel, null, 'neutral must announce nothing');
    assert.ok(
      String(neutral.text).includes('delivery status'),
      'the message text must be rendered in the neutral state',
    );

    // ---- 2. the state arrives on the live event path, in place -------------------
    // Same node identity is captured before the update so a rebuild is detectable.
    await page.evaluate(() => {
      window.__kikxDeliveryNode = document.querySelector('kikx-frame-item[data-frame-id="frame_delivery_1"]');
    });

    let receivedFrame = userFrame({
      updatedAt: 1793328699000000,
      content: { text: 'Please implement the delivery status for my message.', delivery: 'received', deliveryAt: 1793328699000000 },
    });
    fixture.frameRuntime.framesBySessionID.set('session_delivery', [ receivedFrame, replyFrame() ]);
    fixture.frameRuntime.emitEvent('frame.updated', { sessionID: 'session_delivery', frame: receivedFrame });

    await page.waitForFunction(() => (
      document.querySelector('kikx-frame-item[data-frame-id="frame_delivery_1"]')
        ?.classList.contains('kikx-frame--delivery-received')
    ), { timeout: 5000 });

    let inset = await waitForSettledShadow(
      page,
      'received',
      // The settled accent is the declared 3px spread and it is fully opaque.
      (value) => /3px/.test(value) && !/\/\s*0\.\d+\s*\)/.test(value),
    );
    let received = await readDelivery(page);
    assert.equal(received.hasModifierClass, true, 'a delivered message must carry the delivery modifier');
    assert.equal(received.dataDelivery, 'received', 'a delivered message must report its state');
    assert.equal(received.bubbleDelivery, 'received', 'the bubble must report the delivered state');

    // The accent inset must actually apply and resolve to a real colour. A token
    // that fails to resolve computes to an empty colour, which would leave the
    // feature invisible while every attribute assertion still passed.
    assert.match(
      String(inset.settled),
      /inset/,
      'delivery must paint an inset accent, not rely on a class name',
    );
    assert.match(
      String(inset.settled),
      /3px/,
      `the accent must settle at its declared 3px spread, got: ${inset.settled}`,
    );
    // A colour token that failed to resolve would compute to nothing or stay
    // fully transparent; a settled accent is opaque and carries a real colour.
    assert.match(
      String(inset.settled),
      /(rgb|oklab|oklch|color)\(/,
      `the delivery accent colour must resolve, got: ${inset.settled}`,
    );
    assert.doesNotMatch(
      String(inset.settled),
      /\/\s*0(\.0+)?\s*\)/,
      `the accent must be opaque once settled, got: ${inset.settled}`,
    );

    // The painted accent must BE the delivery token, not merely some colour.
    // This is the check the first negative control proved was missing.
    let colours = await resolveAccentColours(page);
    assert.ok(
      colours.tokenColour,
      `the delivery colour token must resolve to a colour, got: ${JSON.stringify(colours)}`,
    );
    assert.equal(
      colours.paintedColour,
      colours.tokenColour,
      `the inset must use the delivery token, painted=${colours.paintedColour} token=${colours.tokenColour}`,
    );

    // The caption is a pseudo-element, so computed style is the only way to see it.
    assert.equal(
      captionText(received.afterContent),
      'Received',
      'delivery must render the caption text',
    );

    // Assistive technology needs the state in an attribute, not only in CSS.
    assert.equal(received.ariaLabel, RECEIVED_LABEL, 'delivery must announce itself');

    // ---- 3. the owner constraint: grey stays grey --------------------------------
    assert.equal(
      received.background,
      neutral.background,
      'delivery must not recolour the bubble; the grey fill is a shipped requirement',
    );

    // ---- 4. in place, and the text survives -------------------------------------
    let identity = await page.evaluate(() => ({
      sameNode: window.__kikxDeliveryNode === document.querySelector('kikx-frame-item[data-frame-id="frame_delivery_1"]'),
      connected: window.__kikxDeliveryNode?.isConnected === true,
    }));
    assert.equal(identity.sameNode, true, 'frame.updated must update the existing item, not rebuild it');
    assert.equal(identity.connected, true, 'the updated item must still be attached');
    assert.ok(
      String(received.text).includes('delivery status'),
      'the rendered message text must survive the delivery update',
    );

    // Only the person's message may be tinted; the agent reply must stay untouched.
    let agentTinted = await page.evaluate(() => (
      document.querySelector('kikx-frame-item[data-frame-id="frame_reply_1"]')
        ?.classList.contains('kikx-frame--delivery-received') === true
    ));
    assert.equal(agentTinted, false, 'delivery is a promise about a person message; an agent frame must never carry it');

    // ---- 5. reversible -----------------------------------------------------------
    // `delivery: null` is deliberate. The client merges frame content additively
    // (`mergeContent`, frame-manager.mjs:518-529 copies only keys present in the
    // patch), so an update that OMITS `delivery` keeps the previous value. A
    // removal has to be stated. Measured: omission left the message `received`
    // and this wait timed out, which is why the patch sets null explicitly.
    let backToNeutral = userFrame({
      updatedAt: 1793328700000000,
      content: { text: 'Please implement the delivery status for my message.', delivery: null },
    });
    fixture.frameRuntime.framesBySessionID.set('session_delivery', [ backToNeutral, replyFrame() ]);
    fixture.frameRuntime.emitEvent('frame.updated', { sessionID: 'session_delivery', frame: backToNeutral });

    await page.waitForFunction(() => (
      document.querySelector('kikx-frame-item[data-frame-id="frame_delivery_1"]')
        ?.classList.contains('kikx-frame--delivery-received') === false
    ), { timeout: 5000 });

    let revertedShadow = await waitForSettledShadow(page, 'reverted', (value) => value === 'none');
    let reverted = await readDelivery(page);
    assert.equal(reverted.hasModifierClass, false, 'neutral must clear the delivery modifier');
    assert.equal(
      revertedShadow.settled,
      'none',
      `neutral must settle back to no inset accent, saw ${revertedShadow.first} on the way out`,
    );
    assert.equal(captionText(reverted.afterContent), '', 'neutral must clear the caption');
    assert.equal(reverted.dataDelivery, 'neutral', 'neutral must report its state after a revert');
    assert.equal(reverted.bubbleDelivery, null, 'the bubble must drop its delivery attribute on revert');
    assert.equal(reverted.ariaLabel, null, 'neutral must stop announcing delivery');
  } finally {
    await browser.close();
    await fixture.close();
  }
});
