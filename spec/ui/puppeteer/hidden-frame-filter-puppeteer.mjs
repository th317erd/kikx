'use strict';

// The eyewear popup's Hidden control must reveal both hidden and soft-deleted
// frames. The unit predicate proves the rule; this lane proves the popup,
// page-source filtering and frame rendering agree in a real browser.

import assert from 'node:assert/strict';
import test from 'node:test';

import puppeteer from 'puppeteer-core';

import { findChromeExecutable, startStagehandUIServer } from '../stagehand/stagehand-test-utils.mjs';

function frame(id, order, extra = {}) {
  let timestamp = 1793328600000000 + order * 1000000;
  return {
    id,
    type: 'UserMessage',
    sessionID: 'session_hidden',
    interactionID: `interaction_${order}`,
    authorType: 'user',
    authorID: 'owner',
    authorDisplayName: 'Wyatt',
    hidden: false,
    deleted: false,
    order,
    timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
    content: { text: `frame ${id}` },
    ...extra,
  };
}

test('Puppeteer Hidden filter reveals hidden and soft-deleted frames', async (t) => {
  let chromePath = findChromeExecutable();
  if (!chromePath) {
    t.skip('Puppeteer Hidden filter coverage requires Chrome');
    return;
  }

  let fixture = await startStagehandUIServer({
    sessions: [ { id: 'session_hidden', title: 'Hidden Filter', messageCount: 4 } ],
  });
  fixture.frameRuntime.framesBySessionID.set('session_hidden', [
    frame('visible_1', 1),
    frame('hidden_2', 2, { hidden: true }),
    frame('deleted_3', 3, { deleted: true }),
    frame('both_4', 4, { hidden: true, deleted: true }),
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
      sessionStorage.setItem('kikx.auth.session', JSON.stringify({ token: 'hidden-test-token', refresh_token: 'hidden-test-refresh' }));
    });
    await page.goto(`${fixture.baseURL}/?session=session_hidden`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForSelector('kikx-frame-item[data-frame-id="visible_1"]', { timeout: 15000 });

    let before = await page.evaluate(() => [ ...document.querySelectorAll('kikx-frame-item[data-frame-id]') ].map((item) => item.dataset.frameId));
    assert.deepEqual(before, [ 'visible_1' ], 'hidden and deleted frames stay out by default');

    await page.click('.kikx-frame-filter__button');
    await page.waitForSelector('[data-filter-key="deleted"]', { timeout: 10000 });
    let gateLabel = await page.$eval('[data-filter-key="deleted"] .kikx-frame-filter__label', (node) => node.textContent.trim());
    assert.equal(gateLabel, 'Hidden');
    await page.evaluate(() => {
      document.querySelector('[data-filter-key="deleted"] .kikx-frame-filter__label')?.click();
    });
    await page.waitForSelector('kikx-frame-item[data-frame-id="hidden_2"]', { timeout: 15000 });

    let after = await page.evaluate(() => [ ...document.querySelectorAll('kikx-frame-item[data-frame-id]') ].map((item) => item.dataset.frameId));
    assert.deepEqual(after, [ 'visible_1', 'hidden_2', 'deleted_3', 'both_4' ]);
  } finally {
    await browser?.close();
    await fixture.close();
  }
});
