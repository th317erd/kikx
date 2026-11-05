'use strict';

// Copy quick action in a real browser (owner, 2026-11-06): the hover rail's
// double-paper button copies the frame's RAW markdown to the clipboard —
// message frames only; tool/command frames get no button ("not command
// output, and all that nonsense") — and flashes the check glyph afterwards.

import assert from 'node:assert/strict';
import test from 'node:test';

import puppeteer from 'puppeteer-core';

import { findChromeExecutable, startStagehandUIServer } from '../stagehand/stagehand-test-utils.mjs';

const RAW = '**bold** reply with _lite_ text\nsecond line `code` and https://example.test/x';

function frame(id, order, type, content) {
  const timestamp = 1793328600000000 + order * 1000000;
  return {
    id,
    type,
    sessionID: 'session_copy',
    interactionID: `copy_i_${order}`,
    authorType: type === 'UserMessage' ? 'user' : 'agent',
    authorID: type === 'UserMessage' ? 'owner' : 'agent_1',
    authorDisplayName: type === 'UserMessage' ? 'Wyatt' : 'Agent',
    hidden: false,
    deleted: false,
    order,
    timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
    content,
  };
}

test('Puppeteer: the Copy quick action puts the raw markdown on the clipboard', async (t) => {
  let chromePath = findChromeExecutable();
  if (!chromePath) {
    t.skip('Puppeteer quick-action copy coverage requires Chrome');
    return;
  }

  const fixture = await startStagehandUIServer({
    sessions: [ { id: 'session_copy', title: 'Quick Copy', messageCount: 6 } ],
  });
  fixture.frameRuntime.framesBySessionID.set('session_copy', [
    frame('msg_1', 1, 'AgentMessage', { text: RAW }),
    frame('user_1', 2, 'UserMessage', { text: 'user **markdown** line' }),
    frame('tool_1', 3, 'ToolCall', { toolName: 'exec', text: 'ran a command', command: 'ls -la', output: 'file1 file2' }),
    frame('msg_2', 4, 'AgentMessage', { text: 'plain tail' }),
    frame('user_2', 5, 'UserMessage', { text: 'two' }),
    frame('msg_3', 6, 'AgentMessage', { text: 'three' }),
  ]);

  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: process.env.KIKX_PUPPETEER_HEADLESS === '0' ? false : 'new',
    args: [ '--no-sandbox', '--disable-setuid-sandbox' ],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.evaluateOnNewDocument(() => {
      sessionStorage.setItem('kikx.auth.session', JSON.stringify({ token: 'copy-token', refresh_token: 'copy-refresh' }));
    });
    await page.goto(`http://127.0.0.1:${new URL(fixture.baseURL).port}/?session=session_copy`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForSelector('kikx-frame-item[data-frame-id="msg_1"]', { timeout: 15000 });
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Deterministic clipboard: capture the write instead of relying on
    // headless clipboard permissions.
    await page.evaluate(() => {
      window.__copied = null;
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText(text) { window.__copied = text; return Promise.resolve(); } },
        configurable: true,
      });
    });

    // Message frame: hover reveals the rail, Copy carries the double-paper icon.
    const message = await page.$('kikx-frame-item[data-frame-id="msg_1"]');
    await message.hover();
    const copyButton = await message.$('.kikx-frame__quick-action--copy');
    assert.ok(copyButton, 'a message frame offers the Copy quick action');
    const iconBefore = await copyButton.evaluate((node) => node.querySelector('svg')?.dataset?.icon);
    assert.equal(iconBefore, 'copy', 'the double-paper copy icon renders');

    await copyButton.click();
    await page.waitForFunction(() => window.__copied !== null, { timeout: 5000 });
    const copied = await page.evaluate(() => window.__copied);
    assert.equal(copied, RAW, 'the clipboard received the frame raw markdown, exactly');

    // Feedback: check glyph, then back to the copy icon.
    await page.waitForFunction(() => {
      const button = document.querySelector('kikx-frame-item[data-frame-id="msg_1"] .kikx-frame__quick-action--copy');
      return button?.querySelector('svg')?.dataset?.icon === 'check';
    }, { timeout: 3000 });
    await page.waitForFunction(() => {
      const button = document.querySelector('kikx-frame-item[data-frame-id="msg_1"] .kikx-frame__quick-action--copy');
      return button?.querySelector('svg')?.dataset?.icon === 'copy';
    }, { timeout: 4000 });

    // User message copies too.
    const user = await page.$('kikx-frame-item[data-frame-id="user_1"]');
    await user.hover();
    await page.evaluate(() => { window.__copied = null; });
    const userCopy = await user.$('.kikx-frame__quick-action--copy');
    assert.ok(userCopy, 'user messages offer Copy as well');
    await userCopy.click();
    await page.waitForFunction(() => window.__copied !== null, { timeout: 5000 });
    assert.equal(await page.evaluate(() => window.__copied), 'user **markdown** line');

    // Tool/command frame: rail exists (quote) but NO Copy — command output
    // must never land on the clipboard through this affordance.
    const tool = await page.$('kikx-frame-item[data-frame-id="tool_1"]');
    await tool.hover();
    const toolParts = await tool.evaluate((node) => ({
      rail: Boolean(node.querySelector('.kikx-frame__quick-actions')),
      quote: Boolean(node.querySelector('.kikx-frame__quick-action--quote')),
      copy: Boolean(node.querySelector('.kikx-frame__quick-action--copy')),
    }));
    assert.ok(toolParts.rail, 'the tool frame still has its rail');
    assert.equal(toolParts.copy, false, 'tool/command frames get no Copy button');
    await page.evaluate(() => { window.__copied = null; });
    if (toolParts.quote) {
      // Nothing copies from this frame through the rail.
      assert.equal(await page.evaluate(() => window.__copied), null);
    }
  } finally {
    await browser.close();
    await fixture.close();
  }
});
