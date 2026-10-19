'use strict';

// Regression guard for "stuff is escaping the message container": an expanded
// shell result must stay inside its frame. The tool-output grid used to size its
// implicit column from the longest `pre`/command line, so the output (and the
// command block in the compact summary) painted far to the right of the
// card. Long stdout still scrolls inside the `pre`; it must not widen the card.

import assert from 'node:assert/strict';
import test from 'node:test';

import puppeteer from 'puppeteer-core';

import {
  findChromeExecutable,
  startStagehandUIServer,
} from '../stagehand/stagehand-test-utils.mjs';

const COMMAND = "cd /home/wyatt/Projects/kikx-workspace/kikx2 && timeout 240 node --test --test-timeout=30000 'spec/**/*.spec.mjs' > /tmp/p2-mid.log 2>&1; echo \"REAL_EXIT=$?\"; grep -E \"^i (tests|pass|fail)\" /tmp/p2-mid.log; echo \"--- fails ---\"; grep -E \"^X|not ok\" /tmp/p2-mid.log | head -20";
const LONG_STDOUT = 'test output '.repeat(80);

test('Puppeteer keeps expanded shell-result output inside its frame', async (t) => {
  let chromePath = findChromeExecutable();
  if (!chromePath) {
    t.skip('Puppeteer local smoke requires Chrome');
    return;
  }

  let fixture = await startStagehandUIServer({
    sessions: [ { id: 'session_1', title: 'Output Overflow', messageCount: 1 } ],
  });
  fixture.frameRuntime.framesBySessionID.set('session_1', [ shellResultFrame() ]);

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
    await page.waitForSelector('kikx-frame-item[data-frame-id="frame_result"]', { timeout: 15000 });

    await page.evaluate(() => {
      let item = document.querySelector('kikx-frame-item[data-frame-id="frame_result"]');
      for (let details of item.querySelectorAll('details'))
        details.open = true;
    });
    await page.waitForSelector('.kikx-tool-output--exec', { timeout: 5000 });
    await delay(200);

    let metrics = await page.evaluate(() => {
      let item = document.querySelector('kikx-frame-item[data-frame-id="frame_result"]');
      let frame = item.getBoundingClientRect();
      let commandPre = item.querySelector('.kikx-frame__compact-command');
      let commandCode = item.querySelector('.kikx-frame__compact-command-code');
      let preview = item.querySelector('.kikx-tool-card__preview');
      let commandRange = document.createRange();
      if (commandCode)
        commandRange.selectNodeContents(commandCode);

      return {
        frame: {
          right: frame.right,
          clientWidth: item.clientWidth,
          scrollWidth: item.scrollWidth,
        },
        commandPre: commandPre ? {
          ...box(commandPre.getBoundingClientRect()),
          clientWidth: commandPre.clientWidth,
          scrollWidth: commandPre.scrollWidth,
        } : null,
        commandCode: commandCode ? box(commandCode.getBoundingClientRect()) : null,
        commandText: commandCode ? box(commandRange.getBoundingClientRect()) : null,
        commandTextContent: commandCode?.textContent || '',
        preview: preview ? {
          ...box(preview.getBoundingClientRect()),
          clientWidth: preview.clientWidth,
          scrollWidth: preview.scrollWidth,
        } : null,
        documentScrollWidth: document.documentElement.scrollWidth,
        viewportWidth: innerWidth,
      };

      function box(rect) {
        return { right: rect.right, width: rect.width, height: rect.height };
      }
    });

    assert.ok(metrics.commandPre, 'the full command block is rendered');
    assert.equal(metrics.commandTextContent, COMMAND, 'the entire command is inside the code block');
    assert.ok(metrics.preview, 'the stdout block is rendered');

    let frameRight = metrics.frame.right;
    assert.ok(metrics.commandPre.right <= frameRight + 1, `command block escapes the frame by ${Math.round(metrics.commandPre.right - frameRight)}px`);
    assert.ok(metrics.commandCode.right <= frameRight + 1, `command code escapes the frame by ${Math.round(metrics.commandCode.right - frameRight)}px`);
    assert.ok(metrics.commandText.right <= frameRight + 1, `command text escapes the frame by ${Math.round(metrics.commandText.right - frameRight)}px`);
    assert.ok(metrics.preview.right <= frameRight + 1, `stdout block escapes the frame by ${Math.round(metrics.preview.right - frameRight)}px`);
    assert.ok(metrics.commandPre.clientWidth <= metrics.frame.clientWidth, 'command block is narrower than the frame');
    assert.ok(metrics.commandPre.scrollWidth <= metrics.commandPre.clientWidth + 1, 'the wrapped command does not need horizontal scrolling');
    assert.ok(metrics.frame.scrollWidth <= metrics.frame.clientWidth + 1, 'the frame itself must not gain horizontal overflow');
    assert.ok(metrics.documentScrollWidth <= metrics.viewportWidth + 1, 'the page must not gain horizontal overflow');

    // Code output is allowed to be wider than its box, but it must scroll inside
    // that box rather than widening the card or the page.
    assert.ok(metrics.preview.clientWidth <= metrics.frame.clientWidth, 'stdout box is narrower than the frame');
    assert.ok(metrics.preview.scrollWidth > metrics.preview.clientWidth, 'long stdout remains horizontally scrollable inside the pre');
  } finally {
    await browser.close().catch(() => {});
    await fixture.close().catch(() => {});
  }
});

function shellResultFrame() {
  let timestamp = 1781035260000000;
  return {
    id: 'frame_result',
    type: 'ShellToolFrame',
    sessionID: 'session_1',
    interactionID: 'interaction_1',
    authorType: 'tool',
    authorID: 'exec',
    authorDisplayName: 'exec',
    timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
    hidden: false,
    deleted: false,
    order: 1,
    content: {
      toolName: 'exec',
      phase: 'result',
      status: 'success',
      input: { command: COMMAND, cwd: '/home/wyatt/Projects/kikx-workspace/kikx2' },
      format: 'json',
      preview: JSON.stringify({
        result: {
          command: COMMAND,
          cwd: '/home/wyatt/Projects/kikx-workspace/kikx2',
          exitCode: 0,
          durationMs: 1234,
          stdout: LONG_STDOUT,
          stderr: '',
        },
      }),
      sizeBytes: 4096,
    },
    state: { status: 'success' },
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
