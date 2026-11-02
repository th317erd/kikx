'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';
import puppeteer from 'puppeteer-core';
import { findChromeExecutable, startStagehandUIServer } from '../stagehand/stagehand-test-utils.mjs';

function frame(id, order, content) {
  let timestamp = 1793328600000000 + order * 1000000;
  return { id, type: 'AgentMessage', sessionID: 'session_collapsed', interactionID: `i${order}`, parentID: null, authorType: 'agent', authorID: 'agent', authorDisplayName: 'Miri', hidden: false, deleted: false, order, timestamp, createdAt: timestamp, updatedAt: timestamp, content };
}

test('Puppeteer highlights matches after a collapsed frame is expanded and explains hidden matches', async (t) => {
  let chromePath = findChromeExecutable();
  if (!chromePath) { t.skip('Puppeteer collapsed-highlight coverage requires Chrome'); return; }
  let fixture = await startStagehandUIServer({ sessions: [ { id: 'session_collapsed', title: 'Collapsed', messageCount: 2 } ] });
  fixture.frameRuntime.framesBySessionID.set('session_collapsed', [
    frame('collapsed', 1, { summary: 'Turn completed.', text: '# Needle in the body', turnReport: true, status: 'done' }),
    frame('visible', 2, { summary: 'Visible needle summary.', text: 'Another message.', turnReport: true, status: 'done' }),
  ]);
  let browser = await puppeteer.launch({ executablePath: chromePath, headless: 'new', args: [ '--no-sandbox', '--disable-setuid-sandbox' ] });
  try {
    let page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.evaluateOnNewDocument(() => sessionStorage.setItem('kikx.auth.session', JSON.stringify({ token: 'collapsed-token', refresh_token: 'collapsed-refresh' })));
    await page.goto(`${fixture.baseURL}/?session=session_collapsed`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForSelector('kikx-frame-item', { timeout: 15000 });
    await new Promise((resolve) => setTimeout(resolve, 800));

    let input = await page.$('.kikx-session-search input');
    await input.click();
    await page.keyboard.type('needle');
    await new Promise((resolve) => setTimeout(resolve, 1400));

    let before = await page.evaluate(() => {
      let collapsed = document.querySelector('kikx-frame-item[data-frame-id="collapsed"]');
      return {
        marks: [ ...collapsed.querySelectorAll('mark.kikx-search-highlight') ].map((mark) => mark.textContent),
        visibleMarks: [ ...document.querySelector('kikx-frame-item[data-frame-id="visible"]').querySelectorAll('mark.kikx-search-highlight') ].map((mark) => mark.textContent),
        hint: collapsed.querySelector('.kikx-search-match-hint')?.textContent || null,
        open: collapsed.querySelector('.kikx-frame__compact')?.open === true,
      };
    });
    assert.deepEqual(before.marks, [], 'the hidden body match should not be marked while collapsed');
    assert.deepEqual(before.visibleMarks, [ 'needle' ], 'a visible compact summary lost its search highlight');
    assert.equal(before.hint, 'Match inside', 'collapsed hidden match did not get an explanation hint');
    assert.equal(before.open, false, 'the frame should start collapsed');

    await page.click('kikx-frame-item[data-frame-id="collapsed"] .kikx-frame__compact-summary');
    await new Promise((resolve) => setTimeout(resolve, 350));

    let after = await page.evaluate(() => {
      let collapsed = document.querySelector('kikx-frame-item[data-frame-id="collapsed"]');
      return {
        marks: [ ...collapsed.querySelectorAll('mark.kikx-search-highlight') ].map((mark) => mark.textContent),
        hint: collapsed.querySelector('.kikx-search-match-hint')?.textContent || null,
        open: collapsed.querySelector('.kikx-frame__compact')?.open === true,
      };
    });
    assert.equal(after.open, true, 'the frame did not expand');
    assert.deepEqual(after.marks, [ 'Needle' ], 'expanded body match was not highlighted');
    assert.equal(after.hint, null, 'the hidden-match hint should disappear once the match is visible');
    let animation = await page.evaluate(() => {
      let mark = document.querySelector('mark.kikx-search-highlight');
      return mark ? getComputedStyle(mark).animationName : '';
    });
    assert.equal(animation, 'kikx-search-highlight-pulse', 'search highlights should pulse');
  } finally {
    await browser?.close();
    await fixture.close();
  }
});
