'use strict';

// The user-state contract at the shell boundary: typing must survive a full
// app render and a programmatic textarea wipe, and an expanded end-turn frame
// must stay expanded. This is deliberately a real browser test because the
// native <details> toggle and textarea value setter are the things the unit
// doubles cannot faithfully reproduce.

import assert from 'node:assert/strict';
import test from 'node:test';

import puppeteer from 'puppeteer-core';

import { findChromeExecutable, startStagehandUIServer } from '../stagehand/stagehand-test-utils.mjs';

function frame(id, type, order, content) {
  let timestamp = 1781035260000000 + order * 1000000;
  return {
    id,
    type,
    sessionID: 'session_state',
    interactionID: `interaction_${order}`,
    authorType: type === 'UserMessage' ? 'user' : 'agent',
    authorID: type === 'UserMessage' ? 'state-user' : 'state-agent',
    authorDisplayName: type === 'UserMessage' ? 'Wyatt' : 'State Agent',
    hidden: false,
    deleted: false,
    order,
    timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
    content,
  };
}

async function waitForComposer(page) {
  await page.waitForSelector('textarea[name="message"]', { timeout: 15000 });
}

test('Puppeteer preserves typed text and expansion across a full shell render', async (t) => {
  let chromePath = findChromeExecutable();
  if (!chromePath) {
    t.skip('Puppeteer state coverage requires Chrome');
    return;
  }

  let fixture = await startStagehandUIServer({
    sessions: [ { id: 'session_state', title: 'State Session', messageCount: 2 } ],
    agents: [ { id: 'state-agent', name: 'State Agent', pluginID: 'test-agent', enabled: true } ],
  });
  fixture.frameRuntime.framesBySessionID.set('session_state', [
    frame('user_1', 'UserMessage', 1, { text: 'Please answer this.' }),
    frame('final_2', 'AgentMessage', 2, {
      status: 'complete',
      turnReport: true,
      summary: 'I need two answers from you.',
      text: 'I need two answers from you.',
      details: '- Which database?\n- Which port?',
    }),
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
      sessionStorage.setItem('kikx.auth.session', JSON.stringify({ token: 'state-test-token', refresh_token: 'state-test-refresh' }));
    });
    await page.goto(`${fixture.baseURL}/?session=session_state`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await waitForComposer(page);
    await page.waitForSelector('kikx-frame-item[data-frame-id="final_2"]', { timeout: 15000 });

    let text = 'This draft must survive every render. It has two lines.\nSecond line.';
    await page.click('textarea[name="message"]');
    // Use insertText/value+input rather than page.type with `\n`: Enter submits
    // the form in this composer, so a real newline would create two messages.
    await page.evaluate((value) => {
      let input = document.querySelector('textarea[name="message"]');
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, text);

    // Expand the compact end-turn report with the questions.
    let expanded = await page.evaluate(() => {
      let item = document.querySelector('kikx-frame-item[data-frame-id="final_2"]');
      let details = item?.querySelector('details.kikx-frame__compact');
      details.open = true;
      details.dispatchEvent(new Event('toggle'));
      return details.open;
    });
    assert.equal(expanded, true);

    await page.evaluate(() => document.querySelector('kikx-app')._render());
    await waitForComposer(page);
    let afterRender = await page.evaluate(() => {
      let item = document.querySelector('kikx-frame-item[data-frame-id="final_2"]');
      let details = item?.querySelector('details.kikx-frame__compact');
      return {
        value: document.querySelector('textarea[name="message"]')?.value || '',
        open: details?.open === true,
      };
    });
    assert.equal(afterRender.value, text, 'full shell render must not wipe the composer');
    assert.equal(afterRender.open, true, 'full shell render must not collapse the expanded frame');

    await new Promise((resolve) => setTimeout(resolve, 250));
    let stored = await page.evaluate(() => {
      let raw = localStorage.getItem('kikx.composerDraft.session_state');
      return raw ? JSON.parse(raw).text : null;
    });
    assert.equal(stored, text, 'the draft must be present in the local recovery cache');

    // A programmatic wipe is the path native `input` does not report. The
    // valuechange defense must preserve the old value before clearing it.
    await page.evaluate(() => {
      document.querySelector('textarea[name="message"]').value = '';
    });
    await page.evaluate(() => document.querySelector('kikx-app')._render());
    await waitForComposer(page);
    let afterWipe = await page.evaluate(() => document.querySelector('textarea[name="message"]')?.value || '');
    assert.equal(afterWipe, text, 'a programmatic wipe must be recoverable');
  } finally {
    await browser?.close();
    await fixture.close();
  }
});
