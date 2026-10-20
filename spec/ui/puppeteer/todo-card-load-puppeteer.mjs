'use strict';

// Todo results can be larger than the 8 KiB inline preview. The full state is
// stored separately; the card must fetch it so counts/titles are real even
// before the user expands the output details.

import assert from 'node:assert/strict';
import test from 'node:test';

import puppeteer from 'puppeteer-core';

import {
  findChromeExecutable,
  startStagehandUIServer,
} from '../stagehand/stagehand-test-utils.mjs';

const TODO_STATE = {
  items: [
    { id: 'a', title: 'Loaded todo item', notes: 'Full output title', status: 'complete', children: [] },
    { id: 'b', title: 'Second todo', status: 'pending', children: [] },
  ],
  focus: null,
};

test('Puppeteer loads a truncated todo result and renders real titles/counts', async (t) => {
  let chromePath = findChromeExecutable();
  if (!chromePath) {
    t.skip('Puppeteer local smoke requires Chrome');
    return;
  }

  let fixture = await startStagehandUIServer({
    sessions: [ { id: 'session_1', title: 'Todo Load', messageCount: 1 } ],
    toolOutputStore: {
      async storeToolOutput() {
        throw new Error('todo load fixture should not store output');
      },
      async getToolOutput(input) {
        return {
          id: input.id,
          toolName: 'todo-get',
          format: 'json',
          sizeBytes: 256,
          start: 0,
          end: 256,
          returnedBytes: 256,
          truncated: false,
          content: JSON.stringify(TODO_STATE),
        };
      },
    },
  });

  let timestamp = 1781035260000000;
  fixture.frameRuntime.framesBySessionID.set('session_1', [{
    id: 'todo_result',
    type: 'TodoGetToolFrame',
    sessionID: 'session_1',
    authorType: 'tool',
    authorID: 'todo-get',
    authorDisplayName: 'todo-get',
    timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
    order: 1,
    hidden: false,
    deleted: false,
    content: {
      toolName: 'todo-get',
      phase: 'result',
      status: 'success',
      format: 'json',
      toolOutputID: 'TODO1',
      sizeBytes: 256,
      // Deliberately cut off mid-JSON, exactly like the 8 KiB inline preview.
      preview: '{"items":[{"id":"a","title":"Loaded',
    },
  }]);

  let browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: process.env.KIKX_PUPPETEER_HEADLESS === '0' ? false : 'new',
    args: [ '--no-sandbox', '--disable-setuid-sandbox' ],
  });

  try {
    let page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.evaluateOnNewDocument(() => {
      sessionStorage.setItem('kikx.auth.session', JSON.stringify({ token: 'puppeteer-test-token', refresh_token: 'puppeteer-test-refresh' }));
    });
    await page.goto(`${fixture.baseURL}/?view=thread`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForFunction(() => document.querySelector('kikx-app')?._state?.clientToolComponentsByName?.['todo-get']);
    await page.evaluate(() => {
      for (let details of document.querySelectorAll('details.kikx-frame__compact')) {
        details.setAttribute('open', '');
        details.open = true;
        details.dispatchEvent(new Event('toggle'));
      }
    });
    await page.waitForSelector('kikx-todo-tool-use .kikx-todo-item__title', { timeout: 15000 });

    let result = await page.evaluate(() => {
      let card = document.querySelector('kikx-todo-tool-use');
      return {
        text: card?.textContent || '',
        facts: [ ...(card?.querySelectorAll('.kikx-tool-card__facts span') || []) ].map((node) => node.textContent),
        titles: [ ...(card?.querySelectorAll('.kikx-todo-item__title') || []) ].map((node) => node.textContent),
        errors: document.querySelector('kikx-error-surface')?.textContent || '',
      };
    });

    assert.match(result.text, /1 open/);
    assert.match(result.text, /1 done/);
    assert.deepEqual(result.titles, [ 'Loaded todo item', 'Second todo' ]);
    assert.match(result.text, /Full output title/);
    assert.equal(result.text.includes('TODO1'), false, 'the stored output id is not a todo title');
  } finally {
    await browser.close().catch(() => {});
    await fixture.close().catch(() => {});
  }
});
