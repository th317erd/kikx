'use strict';

// Raw Markdown is a view mode, so its contract is visual: the delimiters are
// visible AND the content between them is still formatted. This test drives the
// real toolbar button and the real markdown renderer rather than asserting on a
// string that could drift away from the rendered frame.

import assert from 'node:assert/strict';
import test from 'node:test';

import puppeteer from 'puppeteer-core';

import { findChromeExecutable, startStagehandUIServer } from '../stagehand/stagehand-test-utils.mjs';

function frame(id, order, text, type = 'UserMessage') {
  let timestamp = 1793328600000000 + order * 1000000;
  return {
    id,
    type,
    sessionID: 'session_raw',
    interactionID: `interaction_${order}`,
    authorType: type === 'UserMessage' ? 'user' : 'agent',
    authorID: type === 'UserMessage' ? 'owner' : 'agent',
    authorDisplayName: type === 'UserMessage' ? 'Wyatt' : 'Agent',
    hidden: false,
    deleted: false,
    order,
    timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
    content: { text },
  };
}

test('Puppeteer Raw mode shows Markdown source and keeps inline formatting', async (t) => {
  let chromePath = findChromeExecutable();
  if (!chromePath) {
    t.skip('Puppeteer Raw Markdown coverage requires Chrome');
    return;
  }

  let fixture = await startStagehandUIServer({
    sessions: [ { id: 'session_raw', title: 'Raw Markdown', messageCount: 2 } ],
  });
  fixture.frameRuntime.framesBySessionID.set('session_raw', [
    frame('raw_1', 1, '**bold** and _italics_ are ~~cool~~ AWESOME!!!\n# Heading'),
    frame('agent_1', 2, 'Agent **source** and _prose_', 'AgentMessage'),
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
      sessionStorage.setItem('kikx.auth.session', JSON.stringify({ token: 'raw-test-token', refresh_token: 'raw-test-refresh' }));
    });
    await page.goto(`${fixture.baseURL}/?session=session_raw`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForSelector('kikx-frame-item[data-frame-id="raw_1"] .kikx-markdown', { timeout: 15000 });
    await page.waitForSelector('kikx-frame-item[data-frame-id="agent_1"] .kikx-markdown', { timeout: 15000 });

    let rendered = await page.evaluate(() => {
      let content = document.querySelector('kikx-frame-item[data-frame-id="raw_1"] .kikx-markdown');
      return {
        text: content.innerText,
        strong: content.querySelector('strong')?.textContent || '',
        em: content.querySelector('em')?.textContent || '',
        del: content.querySelector('del')?.textContent || '',
      };
    });
    assert.equal(rendered.text.includes('**bold**'), false, 'normal mode removes the delimiters');
    assert.deepEqual({ strong: rendered.strong, em: rendered.em, del: rendered.del }, {
      strong: 'bold',
      em: 'italics',
      del: 'cool',
    });

    await page.click('.kikx-raw-toggle');
    await page.waitForFunction(() => {
      let content = document.querySelector('kikx-frame-item[data-frame-id="raw_1"] .kikx-markdown');
      return content?.classList.contains('kikx-markdown--raw') === true;
    }, { timeout: 15000 });

    let raw = await page.evaluate(() => {
      let content = document.querySelector('kikx-frame-item[data-frame-id="raw_1"] .kikx-markdown');
      let button = document.querySelector('.kikx-raw-toggle');
      return {
        text: content.innerText,
        strong: content.querySelector('strong')?.textContent || '',
        em: content.querySelector('em')?.textContent || '',
        del: content.querySelector('del')?.textContent || '',
        pressed: button?.getAttribute('aria-pressed'),
      };
    });
    assert.match(raw.text, /\*\*bold\*\*/);
    assert.match(raw.text, /_italics_/);
    assert.match(raw.text, /~~cool~~/);
    assert.match(raw.text, /# Heading/);
    assert.deepEqual({ strong: raw.strong, em: raw.em, del: raw.del }, {
      strong: 'bold',
      em: 'italics',
      del: 'cool',
    });
    let agent = await page.evaluate(() => {
      let content = document.querySelector('kikx-frame-item[data-frame-id="agent_1"] .kikx-markdown');
      return { text: content?.innerText || '', strong: content?.querySelector('strong')?.textContent || '' };
    });
    assert.match(agent.text, /\*\*source\*\*/);
    assert.equal(agent.strong, 'source', 'agent messages follow the same raw-mode contract');
    assert.equal(raw.pressed, 'true');

    await page.click('.kikx-raw-toggle');
    await page.waitForFunction(() => {
      let content = document.querySelector('kikx-frame-item[data-frame-id="raw_1"] .kikx-markdown');
      return content?.classList.contains('kikx-markdown--raw') === false;
    }, { timeout: 15000 });
    let normalAgain = await page.evaluate(() => document.querySelector('kikx-frame-item[data-frame-id="raw_1"] .kikx-markdown')?.innerText || '');
    assert.equal(normalAgain.includes('**bold**'), false);
  } finally {
    await browser?.close();
    await fixture.close();
  }
});
