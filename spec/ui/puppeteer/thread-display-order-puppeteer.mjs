'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import puppeteer from 'puppeteer-core';

import { findChromeExecutable, startStagehandUIServer } from '../stagehand/stagehand-test-utils.mjs';

function frame(id, type, order, extra = {}) {
  let timestamp = 1793328600000000 + order * 1000000;
  return {
    id,
    type,
    sessionID: 'session_order',
    interactionID: `interaction_${order}`,
    parentID: null,
    authorType: type === 'UserMessage' ? 'user' : 'agent',
    authorID: type === 'UserMessage' ? 'owner' : 'agent',
    authorDisplayName: type === 'UserMessage' ? 'Wyatt' : 'Miri',
    hidden: false,
    deleted: false,
    order,
    commitOrder: order,
    timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
    content: { text: `frame ${id}` },
    ...extra,
  };
}

function frames() {
  let output = [
    frame('trigger', 'UserMessage', 1, { content: { text: 'Do the work.' } }),
    frame('final-response', 'AgentMessage', 2, {
      commitOrder: 200,
      content: { status: 'complete', text: 'Final answer after the tools.' },
    }),
    frame('tool-call', 'ShellToolFrame', 130, {
      commitOrder: 100,
      content: {
        toolName: 'exec',
        phase: 'call',
        toolCallID: 'call-1',
        status: 'running',
        input: { command: 'echo done' },
      },
      state: { status: 'running' },
    }),
    frame('tool-result', 'ShellToolFrame', 131, {
      commitOrder: 101,
      parentID: 'tool-call',
      content: {
        toolName: 'exec',
        phase: 'result',
        toolCallID: 'call-1',
        toolCallFrameID: 'tool-call',
        status: 'success',
        message: 'done',
      },
      state: { status: 'success' },
    }),
  ];
  for (let order = 3; order < 130; order++)
    output.push(frame(`filler-${order}`, 'UserMessage', order, { content: { text: `filler ${order}` } }));
  return output.sort((a, b) => a.order - b.order);
}

test('Puppeteer puts a completed response at the bottom after its later tools', async (t) => {
  let chromePath = findChromeExecutable();
  if (!chromePath) {
    t.skip('Puppeteer display-order coverage requires Chrome');
    return;
  }

  let fixture = await startStagehandUIServer({
    sessions: [ { id: 'session_order', title: 'Display Order', messageCount: 132 } ],
  });
  fixture.frameRuntime.framesBySessionID.set('session_order', frames());

  let browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: 'new',
    args: [ '--no-sandbox', '--disable-setuid-sandbox' ],
  });
  try {
    let page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.evaluateOnNewDocument(() => {
      sessionStorage.setItem('kikx.auth.session', JSON.stringify({ token: 'order-test-token', refresh_token: 'order-test-refresh' }));
    });
    await page.goto(`${fixture.baseURL}/?session=session_order`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForSelector('kikx-frame-item[data-frame-id="filler-120"]', { timeout: 15000 });

    // Force the older page to mount, then return to the tail. The page source
    // has the final response in page 0, while its tools are in page 1.
    await page.evaluate(() => document.querySelector('kikx-app')._scrollview?.element?.scrollToPage(0, { animate: false }));
    await page.waitForSelector('kikx-frame-item[data-frame-id="final-response"]', { timeout: 15000 });
    await page.evaluate(() => document.querySelector('kikx-app')._scrollview?.element?.scrollToPage(1, { animate: false }));
    await new Promise((resolve) => setTimeout(resolve, 300));

    let result = await page.evaluate(() => {
      let ids = [ ...document.querySelectorAll('.kikx-frame-list kikx-frame-item[data-frame-id]') ].map((item) => item.dataset.frameId);
      return { ids, last: ids.at(-1), tailText: document.querySelector('.kikx-frame-list')?.innerText.slice(-500) };
    });
    assert.equal(result.last, 'final-response', 'the completed response must be the last visible frame');
    assert.match(result.tailText, /Final answer after the tools/);
  } finally {
    await browser?.close();
    await fixture.close();
  }
});
