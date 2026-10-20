'use strict';

// Regression guard for "stuff is escaping the message container": an expanded
// shell result must stay inside its frame. The tool-output grid used to size its
// implicit column from the longest `pre`/command line, so the output (and the
// command block in the compact summary) painted far to the right of the
// card. Long stdout still scrolls inside the `pre`; it must not widen the card.

import assert from 'node:assert/strict';
import test from 'node:test';

import puppeteer from 'puppeteer-core';

import { stripInjectedCwdPrefix } from '../../../src/client/components/tool-frame-summary.mjs';

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
    await page.waitForFunction(() => document.querySelector('kikx-app')?._state?.clientToolComponentsByName?.exec);

    let collapsedCommand = await page.evaluate(() => {
      let pre = document.querySelector('kikx-frame-item[data-frame-id="frame_result"] .kikx-frame__compact-command');
      let code = pre?.querySelector('code');
      let style = pre ? getComputedStyle(pre) : null;
      let codeStyle = code ? getComputedStyle(code) : null;
      return pre && style && codeStyle ? {
        overflowY: style.overflowY,
        clientHeight: pre.clientHeight,
        scrollHeight: pre.scrollHeight,
        whiteSpace: codeStyle.whiteSpace,
        textOverflow: codeStyle.textOverflow,
        codeClientWidth: code.clientWidth,
        codeScrollWidth: code.scrollWidth,
      } : null;
    });
    assert.ok(collapsedCommand, 'the collapsed command block is rendered');
    assert.equal(collapsedCommand.overflowY, 'hidden', 'a collapsed command must not capture the session scroll');
    assert.equal(collapsedCommand.whiteSpace, 'nowrap', 'a collapsed command is one line');
    assert.equal(collapsedCommand.textOverflow, 'ellipsis', 'a collapsed command overflows into an ellipsis');
    assert.ok(collapsedCommand.codeScrollWidth > collapsedCommand.codeClientWidth, 'the collapsed command is clipped horizontally');

    let collapsedDom = await page.evaluate(() => {
      let item = document.querySelector('kikx-frame-item[data-frame-id="frame_result"]');
      return {
        toolCard: Boolean(item.querySelector('kikx-shell-tool-use')),
        output: Boolean(item.querySelector('.kikx-tool-output--exec')),
      };
    });
    assert.equal(collapsedDom.toolCard, false, 'a collapsed frame must not build the tool card');
    assert.equal(collapsedDom.output, false, 'a collapsed frame must not build the output');

    await page.evaluate(() => {
      let outer = document.querySelector('kikx-frame-item[data-frame-id="frame_result"] details.kikx-frame__compact');
      outer.setAttribute('open', '');
      outer.open = true;
      outer.dispatchEvent(new Event('toggle'));
    });
    await page.waitForSelector('kikx-shell-tool-use', { timeout: 5000 });

    let outerExpandedDom = await page.evaluate(() => {
      let item = document.querySelector('kikx-frame-item[data-frame-id="frame_result"]');
      return {
        toolCard: Boolean(item.querySelector('kikx-shell-tool-use')),
        output: Boolean(item.querySelector('.kikx-tool-output--exec')),
      };
    });
    assert.equal(outerExpandedDom.toolCard, true, 'expanding the frame builds the tool card');
    assert.equal(outerExpandedDom.output, false, 'nested output stays lazy until its own disclosure opens');

    await page.evaluate(() => {
      let item = document.querySelector('kikx-frame-item[data-frame-id="frame_result"]');
      let outer = item.querySelector('details.kikx-frame__compact');
      for (let details of outer.querySelectorAll('details')) {
        details.setAttribute('open', '');
        details.open = true;
        details.dispatchEvent(new Event('toggle'));
      }
    });
    await page.waitForSelector('.kikx-tool-output--exec', { timeout: 5000 });
    await delay(200);

    let tint = await page.evaluate(() => {
      let item = document.querySelector('kikx-frame-item[data-frame-id="frame_result"]');
      let style = getComputedStyle(item);
      return { background: style.backgroundColor, border: style.borderColor };
    });
    assert.equal(tint.background, 'rgb(16, 28, 22)', 'the whole successful frame is tinted green');
    assert.equal(tint.border, 'rgb(47, 95, 69)', 'the successful frame border is green');

    let expandedCommand = await page.evaluate(() => {
      let item = document.querySelector('kikx-frame-item[data-frame-id="frame_result"]');
      let outer = item.querySelector('details.kikx-frame__compact');
      outer.open = true;
      let pre = outer.querySelector('.kikx-frame__compact-command');
      let code = pre?.querySelector('code');
      return pre && code ? {
        overflowY: getComputedStyle(pre).overflowY,
        whiteSpace: getComputedStyle(code).whiteSpace,
        textOverflow: getComputedStyle(code).textOverflow,
      } : null;
    });
    assert.equal(expandedCommand?.overflowY, 'auto', 'an expanded command may scroll internally');
    assert.equal(expandedCommand?.whiteSpace, 'pre-wrap', 'an expanded command is multiline');
    assert.equal(expandedCommand?.textOverflow, 'clip', 'an expanded command is not ellipsized');

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
    assert.equal(metrics.commandTextContent, stripInjectedCwdPrefix(COMMAND), 'the command is inside the code block without the injected cwd wrapper');
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
