'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';
import puppeteer from 'puppeteer-core';
import { findChromeExecutable, startStagehandUIServer } from '../stagehand/stagehand-test-utils.mjs';

function frame(id, type, order, text) {
  let timestamp = 1793328600000000 + order * 1000000;
  return {
    id,
    type,
    sessionID: 'session_send',
    interactionID: `i${order}`,
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
    content: { text, ...(type === 'AgentMessage' ? { status: 'complete' } : {}) },
  };
}

test('Puppeteer sends a message without remounting the thread or showing a loading page', async (t) => {
  let chromePath = findChromeExecutable();
  if (!chromePath) { t.skip('Puppeteer send coverage requires Chrome'); return; }

  let fixture = await startStagehandUIServer({
    sessions: [ { id: 'session_send', title: 'Send Test', messageCount: 2 } ],
  });
  fixture.frameRuntime.framesBySessionID.set('session_send', [
    frame('old_user', 'UserMessage', 1, 'old message'),
    frame('old_answer', 'AgentMessage', 2, 'old answer'),
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
      sessionStorage.setItem('kikx.auth.session', JSON.stringify({ token: 'send-test-token', refresh_token: 'send-test-refresh' }));
    });
    await page.goto(`${fixture.baseURL}/?session=session_send`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForFunction(() => document.querySelector('kikx-app')?._startupSettled === true, { timeout: 15000 });
    await page.waitForSelector('kikx-frame-item[data-frame-id="old_answer"]', { timeout: 15000 });

    let before = await page.evaluate(() => {
      window.__sendBeforeView = document.querySelector('.kikx-thread__body kikx-chat-view');
      window.__sendBeforeOld = document.querySelector('kikx-frame-item[data-frame-id="old_answer"]');
      return { scrollTop: document.querySelector('.kikx-frame-list')?.scrollTop || 0 };
    });

    await page.click('textarea[name="message"]');
    await page.keyboard.type('new message');
    await page.keyboard.press('Enter');

    await page.waitForFunction(() => (
      [ ...document.querySelectorAll('kikx-frame-item') ]
        .some((item) => item.innerText.includes('new message'))
    ), { timeout: 10000 });

    let after = await page.evaluate(() => {
      let view = document.querySelector('.kikx-thread__body kikx-chat-view');
      let list = document.querySelector('.kikx-frame-list');
      return {
        sameView: view === window.__sendBeforeView,
        sameOldNode: document.querySelector('kikx-frame-item[data-frame-id="old_answer"]') === window.__sendBeforeOld,
        loadingVisible: [ ...document.querySelectorAll('.aeor-scrollview__status') ]
          .some((status) => !status.hidden && /Loading page/.test(status.textContent)),
        atBottom: list ? Math.abs(list.scrollHeight - list.clientHeight - list.scrollTop) < 8 : false,
        composer: document.querySelector('textarea[name="message"]')?.value || '',
      };
    });

    assert.equal(after.sameView, true, 'send must not replace the chat view');
    assert.equal(after.sameOldNode, true, 'send must not replace existing frame nodes');
    assert.equal(after.loadingVisible, false, 'send must not reveal a loading-page status');
    assert.equal(after.composer, '', 'the composer must clear after send');
    assert.equal(after.atBottom, true, 'the sent message must land at the bottom');
  } finally {
    await browser?.close();
    await fixture.close();
  }
});
