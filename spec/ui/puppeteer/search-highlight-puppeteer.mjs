'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';
import puppeteer from 'puppeteer-core';
import { findChromeExecutable, startStagehandUIServer } from '../stagehand/stagehand-test-utils.mjs';

function frame(id, order, text) {
  let timestamp = 1793328600000000 + order * 1000000;
  return { id, type: 'UserMessage', sessionID: 'session_highlight', interactionID: `i${order}`, parentID: null, authorType: 'user', authorID: 'owner', authorDisplayName: 'Wyatt', hidden: false, deleted: false, order, timestamp, createdAt: timestamp, updatedAt: timestamp, content: { text } };
}

test('Puppeteer highlights search matches in the rendered thread', async (t) => {
  let chromePath = findChromeExecutable();
  if (!chromePath) { t.skip('Puppeteer highlight coverage requires Chrome'); return; }
  let fixture = await startStagehandUIServer({ sessions: [ { id: 'session_highlight', title: 'Highlight', messageCount: 3 } ] });
  fixture.frameRuntime.framesBySessionID.set('session_highlight', [
    frame('one', 1, 'Deploy the deployable message.'),
    frame('two', 2, 'nothing here'),
    frame('three', 3, 'deploy again'),
  ]);
  let browser = await puppeteer.launch({ executablePath: chromePath, headless: 'new', args: [ '--no-sandbox', '--disable-setuid-sandbox' ] });
  try {
    let page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.evaluateOnNewDocument(() => sessionStorage.setItem('kikx.auth.session', JSON.stringify({ token: 'highlight-token', refresh_token: 'highlight-refresh' })));
    await page.goto(`${fixture.baseURL}/?session=session_highlight`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForSelector('kikx-frame-item', { timeout: 15000 });
    await new Promise((resolve) => setTimeout(resolve, 800));
    let input = await page.$('.kikx-session-search input');
    await input.click();
    await page.keyboard.type('deploy');
    // The query debounce is 1000 ms; allow the re-scope and page projection to land.
    await new Promise((resolve) => setTimeout(resolve, 1400));
    let result = await page.evaluate(() => ({
      search: document.querySelector('kikx-app')?._state?.sessionSearch || '',
      marks: [ ...document.querySelectorAll('mark.kikx-search-highlight') ].map((mark) => mark.textContent),
    }));
    assert.equal(result.search, 'deploy');
    assert.deepEqual(result.marks, [ 'Deploy', 'deploy', 'deploy' ]);
  } finally {
    await browser?.close();
    await fixture.close();
  }
});
