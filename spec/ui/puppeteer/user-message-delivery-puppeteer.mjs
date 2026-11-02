'use strict';

// Rendered proof for user-message delivery, in a real browser.
//
// Delivery is a success state, not a bespoke caption. A received UserMessage
// must carry the same success class/tokens as every other successful frame:
// the frame body and its header turn green. There is no "Received" text and no
// separate inset accent. Neutral must remain the untouched grey bubble.
//
// This lane reads computed style, not just attributes: a class that no selector
// matches, or a token that fails to resolve, must not pass.

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

function readDelivery(page) {
  return page.evaluate(() => {
    let item = document.querySelector('kikx-frame-item[data-frame-id="frame_delivery_1"]');
    if (!item)
      return { present: false };

    let content = item.querySelector('.kikx-frame__content--user-message');
    let meta = item.querySelector('.kikx-frame__meta');
    let bubble = item.querySelector('kikx-user-message-frame');
    let itemStyle = getComputedStyle(item);
    let metaStyle = meta ? getComputedStyle(meta) : null;

    return {
      present: true,
      background: itemStyle.backgroundColor,
      headerBackground: metaStyle ? metaStyle.backgroundImage : null,
      statusColor: itemStyle.getPropertyValue('--kikx-frame-status-color').trim(),
      deliveryColor: itemStyle.getPropertyValue('--kikx-frame-delivery-color').trim(),
      afterContent: content ? getComputedStyle(content, '::after').content : null,
      hasModifierClass: item.classList.contains('kikx-frame--delivery-received'),
      hasSuccessClass: item.classList.contains('kikx-frame--status-success'),
      dataDelivery: item.getAttribute('data-delivery'),
      dataFrameStatus: item.getAttribute('data-frame-status'),
      bubbleDelivery: bubble ? bubble.getAttribute('data-delivery') : null,
      ariaLabel: bubble ? bubble.getAttribute('aria-label') : null,
      text: content ? content.textContent : null,
      connected: item.isConnected,
    };
  });
}

function captionText(value) {
  if (!value || value === 'none' || value === 'normal')
    return '';
  return String(value).replace(/^['"]|['"]$/g, '');
}

test('Puppeteer renders received user messages with the shared success treatment', async (t) => {
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

    // ---- neutral: the shipped grey bubble, with nothing pretending delivery ----
    let neutral = await readDelivery(page);
    assert.equal(neutral.present, true, 'the user message must render');
    assert.equal(neutral.connected, true, 'the user message must be attached');
    assert.equal(neutral.hasModifierClass, false, 'neutral must carry no delivery modifier');
    assert.equal(neutral.hasSuccessClass, false, 'neutral must not claim success');
    assert.equal(neutral.dataDelivery, 'neutral', 'the item reports neutral as a real state');
    assert.equal(neutral.dataFrameStatus, null, 'neutral must not expose a success status');
    assert.equal(neutral.bubbleDelivery, null, 'the bubble must carry no delivery attribute while neutral');
    assert.equal(neutral.ariaLabel, null, 'neutral must announce nothing');
    assert.equal(captionText(neutral.afterContent), '', 'neutral must render no caption');
    assert.ok(String(neutral.text).includes('delivery status'), 'the message text must render while neutral');

    // ---- received arrives on the live event path, in place --------------------
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

    // Let the shared frame-shell colour transition settle before sampling.
    await new Promise((resolve) => setTimeout(resolve, 260));
    let received = await readDelivery(page);
    assert.equal(received.hasModifierClass, true, 'a delivered message must carry the delivery modifier');
    assert.equal(received.hasSuccessClass, true, 'delivery must use the shared success status class');
    assert.equal(received.dataDelivery, 'received', 'a delivered message must report its state');
    assert.equal(received.dataFrameStatus, 'success', 'the frame must expose success, like other successful frames');
    assert.equal(received.bubbleDelivery, 'received', 'the bubble must report the delivered state');
    assert.equal(received.ariaLabel, RECEIVED_LABEL, 'delivery must remain accessible');
    assert.equal(captionText(received.afterContent), '', 'there must be no Received caption');

    // The success token must actually paint. A class that no selector matches
    // would leave the old blue frame in place while every attribute still passed.
    assert.equal(received.statusColor, received.deliveryColor, 'delivery must use the shared success colour token');
    assert.equal(received.statusColor !== '', true, 'the success token must resolve');
    assert.notEqual(received.background, neutral.background, 'received must turn the frame body green');
    assert.notEqual(received.headerBackground, neutral.headerBackground, 'received must turn the header green');

    // ---- in place; only the person's message is affected -----------------------
    let identity = await page.evaluate(() => ({
      sameNode: window.__kikxDeliveryNode === document.querySelector('kikx-frame-item[data-frame-id="frame_delivery_1"]'),
      connected: window.__kikxDeliveryNode?.isConnected === true,
    }));
    assert.equal(identity.sameNode, true, 'frame.updated must update the existing item, not rebuild it');
    assert.equal(identity.connected, true, 'the updated item must still be attached');
    assert.ok(String(received.text).includes('delivery status'), 'the rendered message text must survive the update');

    let agentTinted = await page.evaluate(() => (
      document.querySelector('kikx-frame-item[data-frame-id="frame_reply_1"]')
        ?.classList.contains('kikx-frame--delivery-received') === true
    ));
    assert.equal(agentTinted, false, 'delivery is a promise about a person message; an agent frame must never carry it');

    // ---- reversible ------------------------------------------------------------
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

    await new Promise((resolve) => setTimeout(resolve, 260));
    let reverted = await readDelivery(page);
    assert.equal(reverted.hasModifierClass, false, 'neutral must clear the delivery modifier');
    assert.equal(reverted.hasSuccessClass, false, 'neutral must clear the success class');
    assert.equal(reverted.dataDelivery, 'neutral', 'neutral must report its state after a revert');
    assert.equal(reverted.dataFrameStatus, null, 'neutral must clear the success status');
    assert.equal(reverted.background, neutral.background, 'neutral must restore the original grey frame');
    assert.equal(reverted.bubbleDelivery, null, 'the bubble must drop its delivery attribute on revert');
    assert.equal(reverted.ariaLabel, null, 'neutral must stop announcing delivery');
  } finally {
    await browser.close().catch(() => {});
    await fixture.close().catch(() => {});
  }
});
