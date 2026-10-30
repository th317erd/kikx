'use strict';

// The screenshot regression was a UserMessage showing literal underscore
// emphasis and an unstyled ordered list. The parser unit test covers the HTML;
// this lane proves the real UserMessage component and its CSS actually apply it.

import assert from 'node:assert/strict';
import test from 'node:test';

import puppeteer from 'puppeteer-core';

import { findChromeExecutable, startStagehandUIServer } from '../stagehand/stagehand-test-utils.mjs';

test('Puppeteer renders underscore emphasis and ordered lists in UserMessage', async (t) => {
  let chromePath = findChromeExecutable();
  if (!chromePath) {
    t.skip('Puppeteer markdown coverage requires Chrome');
    return;
  }

  let text = [
    'FYI: the message is _from me_ ...',
    '',
    '1. It should be _hidden_.',
    '2. It should _appear_ seamless.',
  ].join('\n');
  let timestamp = 1793328600000000;
  let fixture = await startStagehandUIServer({
    sessions: [ { id: 'session_markdown', title: 'Markdown Session', messageCount: 1 } ],
  });
  fixture.frameRuntime.framesBySessionID.set('session_markdown', [{
    id: 'user_markdown_1',
    type: 'UserMessage',
    sessionID: 'session_markdown',
    interactionID: 'interaction_markdown_1',
    authorType: 'user',
    authorID: 'owner',
    authorDisplayName: 'Wyatt',
    hidden: false,
    deleted: false,
    order: 1,
    timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
    content: { text },
  }]);

  let browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: 'new',
    args: [ '--no-sandbox', '--disable-setuid-sandbox' ],
  });
  try {
    let page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.evaluateOnNewDocument(() => {
      sessionStorage.setItem('kikx.auth.session', JSON.stringify({ token: 'markdown-test-token', refresh_token: 'markdown-test-refresh' }));
    });
    await page.goto(`${fixture.baseURL}/?session=session_markdown`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForSelector('.kikx-frame--UserMessage .kikx-markdown', { timeout: 15000 });

    let result = await page.evaluate(() => {
      let root = document.querySelector('.kikx-frame--UserMessage .kikx-markdown');
      let emphasis = [ ...root.querySelectorAll('em') ];
      let list = root.querySelector('ol');
      return {
        emphasis: emphasis.map((node) => node.textContent),
        emphasisStyle: emphasis[0] ? getComputedStyle(emphasis[0]).fontStyle : null,
        listItems: list ? [ ...list.querySelectorAll('li') ].map((node) => node.textContent) : [],
        listStyle: list ? getComputedStyle(list).display : null,
        listMarker: list ? getComputedStyle(list).listStyleType : null,
        text: root.textContent,
      };
    });

    assert.deepEqual(result.emphasis, [ 'from me', 'hidden', 'appear' ]);
    assert.equal(result.emphasisStyle, 'italic');
    assert.deepEqual(result.listItems, [ 'It should be hidden.', 'It should appear seamless.' ]);
    assert.equal(result.listStyle, 'block');
    assert.equal(result.listMarker, 'decimal');
    assert.doesNotMatch(result.text, /_from me_|_hidden_|_appear_/);
  } finally {
    await browser?.close();
    await fixture.close();
  }
});
