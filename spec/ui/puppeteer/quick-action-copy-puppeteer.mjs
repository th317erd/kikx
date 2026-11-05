'use strict';

// Copy quick action in a real browser (owner, 2026-11-06, refined the same
// day): the hover rail's double-paper button copies the frame's VISIBLE text
// (message frames: raw markdown, message key first) to the clipboard and
// flashes the check glyph. Coverage is quote-parity — "add this button pretty
// much everywhere": messages, progress frames and tool rows all carry it;
// only a frame with nothing to copy gets no button.

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
    frame('progress_1', 4, 'AgentProgress', { text: 'migrating the deploy now' }),
    frame('msg_2', 5, 'AgentMessage', { text: 'plain tail' }),
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

    // Feedback: check glyph + success green on the WHOLE button, then back.
    await page.waitForFunction(() => {
      const button = document.querySelector('kikx-frame-item[data-frame-id="msg_1"] .kikx-frame__quick-action--copy');
      return button?.querySelector('svg')?.dataset?.icon === 'check';
    }, { timeout: 3000 });
    // The green is a 140ms transition — wait for it to land before sampling
    // computed colors, then read class + paint together.
    await page.waitForFunction(() => {
      const button = document.querySelector('kikx-frame-item[data-frame-id="msg_1"] .kikx-frame__quick-action--copy');
      return button && getComputedStyle(button).color === 'rgb(63, 185, 80)';
    }, { timeout: 2000 });
    const green = await page.evaluate(() => {
      const button = document.querySelector('kikx-frame-item[data-frame-id="msg_1"] .kikx-frame__quick-action--copy');
      const style = getComputedStyle(button);
      return {
        hasClass: button.classList.contains('is-copied'),
        color: style.color,
        border: style.borderTopColor,
      };
    });
    assert.ok(green.hasClass, 'the success class rides the check flip');
    assert.equal(green.color, 'rgb(63, 185, 80)', `the icon/glyph turns success green (got ${green.color})`);
    assert.equal(green.border, 'rgb(63, 185, 80)', `the border joins in (got ${green.border})`);
    await page.waitForFunction(() => {
      const button = document.querySelector('kikx-frame-item[data-frame-id="msg_1"] .kikx-frame__quick-action--copy');
      return button?.querySelector('svg')?.dataset?.icon === 'copy';
    }, { timeout: 4000 });
    await page.waitForFunction(() => {
      const button = document.querySelector('kikx-frame-item[data-frame-id="msg_1"] .kikx-frame__quick-action--copy');
      return button && getComputedStyle(button).color !== 'rgb(63, 185, 80)';
    }, { timeout: 2000 });
    const restored = await page.evaluate(() => {
      const button = document.querySelector('kikx-frame-item[data-frame-id="msg_1"] .kikx-frame__quick-action--copy');
      return { hasClass: button.classList.contains('is-copied'), color: getComputedStyle(button).color };
    });
    assert.equal(restored.hasClass, false, 'the green state leaves with the check');
    assert.notEqual(restored.color, 'rgb(63, 185, 80)', 'the button returns to its normal chrome');

    // User message copies too.
    const user = await page.$('kikx-frame-item[data-frame-id="user_1"]');
    await user.hover();
    await page.evaluate(() => { window.__copied = null; });
    const userCopy = await user.$('.kikx-frame__quick-action--copy');
    assert.ok(userCopy, 'user messages offer Copy as well');
    await userCopy.click();
    await page.waitForFunction(() => window.__copied !== null, { timeout: 5000 });
    assert.equal(await page.evaluate(() => window.__copied), 'user **markdown** line');

    // Tool rows and progress frames get Copy too (owner follow-up,
    // 2026-11-05: "add this button pretty much everywhere"): quote-parity —
    // anything with visible text can be copied, message text first, and the
    // tool row's own visible content when that IS the frame.
    const tool = await page.$('kikx-frame-item[data-frame-id="tool_1"]');
    // Tool frames start minimized, where the whole rail (Quote included) is
    // deliberately hidden; expand it via its header first.
    const minimizedBefore = await tool.evaluate((node) => node.classList.contains('kikx-frame--minimized'));
    if (minimizedBefore) {
      await tool.click('.kikx-frame__meta');
      await page.waitForFunction(() => {
        const node = document.querySelector('kikx-frame-item[data-frame-id="tool_1"]');
        return node && !node.classList.contains('kikx-frame--minimized');
      }, { timeout: 5000 });
    }
    await tool.hover();
    const toolCopy = await tool.$('.kikx-frame__quick-action--copy');
    assert.ok(toolCopy, 'an expanded tool row with visible text gets the Copy button too');
    await page.evaluate(() => { window.__copied = null; });
    await toolCopy.click();
    await page.waitForFunction(() => window.__copied !== null, { timeout: 5000 });
    assert.equal(await page.evaluate(() => window.__copied), 'ran a command',
      'the tool row copies its visible content (message-text first)');

    const progress = await page.$('kikx-frame-item[data-frame-id="progress_1"]');
    await progress.hover();
    assert.ok(await progress.$('.kikx-frame__quick-action--copy'),
      'progress frames — the class most often missing it — offer Copy');
    await page.evaluate(() => { window.__copied = null; });
    const progressCopy = await progress.$('.kikx-frame__quick-action--copy');
    await progressCopy.click();
    await page.waitForFunction(() => window.__copied !== null, { timeout: 5000 });
    assert.equal(await page.evaluate(() => window.__copied), 'migrating the deploy now');
  } finally {
    await browser.close();
    await fixture.close();
  }
});
