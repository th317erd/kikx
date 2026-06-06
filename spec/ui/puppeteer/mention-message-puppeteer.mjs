'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import puppeteer from 'puppeteer-core';

import {
  findChromeExecutable,
  startStagehandUIServer,
} from '../stagehand/stagehand-test-utils.mjs';

test('Puppeteer sends an @mention message and verifies mention metadata', async (t) => {
  let chromePath = findChromeExecutable();
  if (!chromePath) {
    t.skip('Puppeteer local smoke requires Chrome');
    return;
  }

  let fixture = await startStagehandUIServer({
    sessions: [
      { id: 'session_1', title: 'Mention Smoke' },
    ],
    agents: [
      { id: 'agent_mention', name: 'Mention Bot', pluginID: 'test-agent', enabled: true },
    ],
  });
  let browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: process.env.KIKX_PUPPETEER_HEADLESS === '0' ? false : 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
    ],
  });

  try {
    let page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(`${fixture.baseURL}/?code=puppeteer-test`, {
      waitUntil: 'domcontentloaded',
      timeout: 10000,
    });
    await page.waitForSelector('.kikx-composer textarea:not([disabled])', { timeout: 10000 });

    await page.focus('.kikx-composer textarea');
    await page.keyboard.type('Please review this @"Mention Bot"');
    await page.keyboard.press('Enter');

    await page.waitForSelector('.kikx-frame--UserMessage', { timeout: 10000 });
    let frames = await page.evaluate(async () => {
      let response = await fetch('/api/v1/sessions/session_1/frames');
      return (await response.json()).data.frames;
    });
    let message = frames.find((frame) => frame.type === 'UserMessage');

    assert.equal(message.content.text, 'Please review this @"Mention Bot"');
    assert.deepEqual(message.mentions.agent_mention, {
      id: 'agent_mention',
      type: 'agent',
      name: 'Mention Bot',
      username: null,
      fullName: 'Mention Bot',
      reference: 'Mention Bot',
    });
  } finally {
    await browser.close().catch(() => {});
    await fixture.close().catch(() => {});
  }
});
