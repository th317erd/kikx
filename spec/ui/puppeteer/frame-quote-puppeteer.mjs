'use strict';

// The quote action lives in the right gutter, outside the frame surface. The
// user has to be able to move the pointer from the frame into that gutter and
// click it; making the rail pointer-events:none while hidden made the icon
// visible but unreachable.

import assert from 'node:assert/strict';
import test from 'node:test';

import puppeteer from 'puppeteer-core';

import { findChromeExecutable, startStagehandUIServer } from '../stagehand/stagehand-test-utils.mjs';

function frame(id, type, order, text) {
  let timestamp = 1793328600000000 + order * 1000000;
  return {
    id,
    type,
    sessionID: 'session_quote',
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

test('Puppeteer can move from a frame into the quote gutter and click Quote', async (t) => {
  let chromePath = findChromeExecutable();
  if (!chromePath) {
    t.skip('Puppeteer quote coverage requires Chrome');
    return;
  }

  let fixture = await startStagehandUIServer({
    sessions: [ { id: 'session_quote', title: 'Quote', messageCount: 3 } ],
  });
  fixture.frameRuntime.framesBySessionID.set('session_quote', [
    frame('quote_1', 'UserMessage', 1, 'quote me'),
    frame('quote_2', 'UserMessage', 2, 'quote two'),
    frame('answer_1', 'AgentMessage', 3, 'the answer'),
  ]);

  let browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: 'new',
    args: [ '--no-sandbox', '--disable-setuid-sandbox' ],
  });
  try {
    let page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.evaluateOnNewDocument(() => {
      sessionStorage.setItem('kikx.auth.session', JSON.stringify({ token: 'quote-test-token', refresh_token: 'quote-test-refresh' }));
    });
    await page.goto(`${fixture.baseURL}/?session=session_quote`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForSelector('kikx-frame-item[data-frame-id="quote_1"]', { timeout: 15000 });

    let geometry = await page.evaluate(() => {
      let item = document.querySelector('kikx-frame-item[data-frame-id="quote_1"]');
      let itemRect = item.getBoundingClientRect();
      let button = item.querySelector('.kikx-frame__quick-action--quote');
      let buttonRect = button.getBoundingClientRect();
      return {
        item: { x: itemRect.x + 80, y: itemRect.y + 50 },
        button: { x: buttonRect.x + buttonRect.width / 2, y: buttonRect.y + buttonRect.height / 2 },
      };
    });

    await page.mouse.move(geometry.item.x, geometry.item.y);
    await new Promise((resolve) => setTimeout(resolve, 150));
    await page.mouse.move(geometry.button.x, geometry.button.y);
    await new Promise((resolve) => setTimeout(resolve, 150));

    let reachable = await page.evaluate(({ x, y }) => {
      let hit = document.elementFromPoint(x, y);
      let item = hit?.closest?.('kikx-frame-item');
      let rail = item?.querySelector('.kikx-frame__quick-actions');
      return {
        frameID: item?.dataset.frameId || null,
        pointer: rail ? getComputedStyle(rail).pointerEvents : null,
        opacity: rail ? getComputedStyle(rail).opacity : null,
      };
    }, geometry.button);
    assert.equal(reachable.frameID, 'quote_1', 'the quote gutter must remain hit-testable outside the frame');
    assert.equal(reachable.pointer, 'auto');
    assert.equal(reachable.opacity, '1');

    await page.mouse.click(geometry.button.x, geometry.button.y);
    await page.waitForFunction(() => (
      document.querySelector('textarea[name="message"]')?.value || ''
    ).includes('User is asking about and referring to frame id[quote_1]:'), { timeout: 15000 });

    let value = await page.evaluate(() => document.querySelector('textarea[name="message"]')?.value || '');
    assert.match(value, /quote me/);

    // A second quote must not be blocked by the first quote's draft-save chain.
    await page.evaluate(() => document.querySelector('kikx-frame-item[data-frame-id="quote_2"] .kikx-frame__quick-action--quote')?.click());
    await page.waitForFunction(() => (
      document.querySelector('textarea[name="message"]')?.value || ''
    ).includes('frame id[quote_2]:'), { timeout: 15000 });
    value = await page.evaluate(() => document.querySelector('textarea[name="message"]')?.value || '');
    assert.match(value, /quote two/);
  } finally {
    await browser?.close();
    await fixture.close();
  }
});
