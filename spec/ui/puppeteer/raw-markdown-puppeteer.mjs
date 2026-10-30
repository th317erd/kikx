'use strict';

// Raw Markdown is a paint-only view mode. The critical contract is not just
// that the delimiters appear, but that toggling does not rebuild the thread,
// blank the screen, lose a node, or move the user's scroll position.

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

test('Puppeteer Raw mode toggles syntax in place without rebuilding the thread', async (t) => {
  let chromePath = findChromeExecutable();
  if (!chromePath) {
    t.skip('Puppeteer Raw Markdown coverage requires Chrome');
    return;
  }

  let fixture = await startStagehandUIServer({
    sessions: [ { id: 'session_raw', title: 'Raw Markdown', messageCount: 40 } ],
  });
  let frames = [
    frame('raw_1', 1, '**bold** and _italics_ are ~~cool~~ AWESOME!!!\n# Heading'),
    frame('agent_1', 2, 'Agent **source** and _prose_', 'AgentMessage'),
  ];
  for (let index = 3; index <= 40; index++)
    frames.push(frame(`filler_${index}`, index, `Filler **row** ${index}.`));
  fixture.frameRuntime.framesBySessionID.set('session_raw', frames);

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
      let list = document.querySelector('.kikx-frame-list');
      list.scrollTop = 180;
      return {
        strong: content.querySelector('strong')?.textContent || '',
        em: content.querySelector('em')?.textContent || '',
        del: content.querySelector('del')?.textContent || '',
        scrollTop: list.scrollTop,
      };
    });
    assert.deepEqual({ strong: rendered.strong, em: rendered.em, del: rendered.del }, {
      strong: 'bold',
      em: 'italics',
      del: 'cool',
    });

    await page.evaluate(() => {
      let content = document.querySelector('kikx-frame-item[data-frame-id="raw_1"] .kikx-markdown');
      window.__rawBeforeNode = content;
      window.__rawBeforeScroll = document.querySelector('.kikx-frame-list').scrollTop;
      document.querySelector('.kikx-raw-toggle')?.click();
    });
    await page.waitForFunction(() => document.querySelector('kikx-app')?.classList.contains('kikx-raw-mode') === true, { timeout: 15000 });

    let raw = await page.evaluate(() => {
      let app = document.querySelector('kikx-app');
      let content = document.querySelector('kikx-frame-item[data-frame-id="raw_1"] .kikx-markdown');
      let strong = content.querySelector('strong');
      let em = content.querySelector('em');
      let del = content.querySelector('del');
      let heading = content.querySelector('h1');
      let list = document.querySelector('.kikx-frame-list');
      let button = document.querySelector('.kikx-raw-toggle');
      return {
        rawClass: app.classList.contains('kikx-raw-mode'),
        sameNode: content === window.__rawBeforeNode,
        scrollTop: list.scrollTop,
        beforeScrollTop: window.__rawBeforeScroll,
        contentConnected: content.isConnected,
        strongBefore: getComputedStyle(strong, '::before').content,
        strongAfter: getComputedStyle(strong, '::after').content,
        emBefore: getComputedStyle(em, '::before').content,
        delBefore: getComputedStyle(del, '::before').content,
        delAfter: getComputedStyle(del, '::after').content,
        headingBefore: heading ? getComputedStyle(heading, '::before').content : '',
        pressed: button?.getAttribute('aria-pressed'),
      };
    });

    assert.equal(raw.rawClass, true);
    assert.equal(raw.sameNode, true, 'the Markdown subtree must stay mounted');
    assert.equal(raw.contentConnected, true);
    assert.equal(raw.scrollTop, raw.beforeScrollTop, 'toggling Raw mode must not move the scroll position');
    assert.ok(raw.strongBefore.includes('**'), 'bold opening delimiter is painted by CSS');
    assert.ok(raw.strongAfter.includes('**'), 'bold closing delimiter is painted by CSS');
    assert.ok(raw.emBefore.includes('_'), 'italic delimiter is painted by CSS');
    assert.ok(raw.delBefore.includes('~~'), 'strike opening delimiter is painted by CSS');
    assert.ok(raw.delAfter.includes('~~'), 'strike closing delimiter is painted by CSS');
    assert.ok(raw.headingBefore.includes('#'), 'heading marker is painted by CSS');
    assert.equal(raw.pressed, 'true');

    await page.evaluate(() => document.querySelector('.kikx-raw-toggle')?.click());
    await page.waitForFunction(() => document.querySelector('kikx-app')?.classList.contains('kikx-raw-mode') === false, { timeout: 15000 });
    let afterOff = await page.evaluate(() => {
      let content = document.querySelector('kikx-frame-item[data-frame-id="raw_1"] .kikx-markdown');
      return {
        contentConnected: content?.isConnected,
        strongBefore: getComputedStyle(content.querySelector('strong'), '::before').content,
        pressed: document.querySelector('.kikx-raw-toggle')?.getAttribute('aria-pressed'),
      };
    });
    assert.equal(afterOff.contentConnected, true);
    assert.ok(!afterOff.strongBefore.includes('**'), 'delimiters disappear with the class');
    assert.equal(afterOff.pressed, 'false');
  } finally {
    await browser?.close();
    await fixture.close();
  }
});
