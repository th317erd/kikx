'use strict';

// AgentProgress is a normal message card, not a compact status row. It must
// show the complete update and use the lilac progress treatment.

import assert from 'node:assert/strict';
import test from 'node:test';

import puppeteer from 'puppeteer-core';

import {
  findChromeExecutable,
  startStagehandUIServer,
} from '../stagehand/stagehand-test-utils.mjs';

const PROGRESS_TEXT = [
  'Investigation plan: (1) read the submit path in kikx-question-card.mjs / kikx-inbox-view.mjs',
  'to see what state, if any, is set on click; (2) check whether any pending/disabled/success',
  'affordance exists in CSS or markup; (3) confirm the POST path and where the card list is',
  'reconciled. Expectation: the list should update only after the server round-trip without',
  'losing the typed draft or the card the user is working on.',
].join(' ');

test('Puppeteer shows a complete lilac AgentProgress message card', async (t) => {
  let chromePath = findChromeExecutable();
  if (!chromePath) {
    t.skip('Puppeteer local smoke requires Chrome');
    return;
  }

  let fixture = await startStagehandUIServer({
    sessions: [ { id: 'session_1', title: 'Progress Text', messageCount: 1 } ],
  });
  fixture.frameRuntime.framesBySessionID.set('session_1', [{
    id: 'progress_1',
    type: 'AgentProgress',
    sessionID: 'session_1',
    authorType: 'agent',
    authorID: 'agent_1',
    authorDisplayName: 'Zav',
    timestamp: 1781035260000000,
    createdAt: 1781035260000000,
    updatedAt: 1781035260000000,
    order: 1,
    hidden: false,
    deleted: false,
    content: { text: PROGRESS_TEXT, status: 'progress' },
  }]);

  let browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: process.env.KIKX_PUPPETEER_HEADLESS === '0' ? false : 'new',
    args: [ '--no-sandbox', '--disable-setuid-sandbox' ],
  });

  try {
    let page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.evaluateOnNewDocument(() => {
      sessionStorage.setItem('kikx.auth.session', JSON.stringify({ token: 'puppeteer-test-token', refresh_token: 'puppeteer-test-refresh' }));
    });
    await page.goto(`${fixture.baseURL}/?view=thread`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForSelector('kikx-frame-item[data-frame-id="progress_1"]', { timeout: 15000 });

    let result = await page.evaluate(() => {
      let item = document.querySelector('kikx-frame-item[data-frame-id="progress_1"]');
      let content = item.querySelector('.kikx-frame__content');
      let style = getComputedStyle(item);
      return {
        text: content?.textContent || '',
        compact: item.classList.contains('kikx-frame--compact'),
        background: style.backgroundColor,
        border: style.borderColor,
        height: content?.getBoundingClientRect().height || 0,
      };
    });

    assert.equal(result.text, PROGRESS_TEXT, 'the complete update text is present');
    assert.equal(result.compact, false, 'progress is a normal message card');
    assert.equal(result.background, 'rgb(27, 22, 38)', 'progress uses the lilac background');
    assert.equal(result.border, 'rgb(95, 75, 134)', 'progress uses the lilac border');
    assert.ok(result.height > 24, 'the update occupies multiple lines');
  } finally {
    await browser.close().catch(() => {});
    await fixture.close().catch(() => {});
  }
});
