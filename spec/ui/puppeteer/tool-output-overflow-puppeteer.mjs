'use strict';

// Regression guard for "stuff is escaping the message container": an expanded
// shell result must stay inside its frame. The tool-output grid used to size its
// implicit column from the longest `pre`/command line, so the output (and the
// command block in the compact summary) painted far to the right of the
// card. Long stdout still scrolls inside the `pre`; it must not widen the card.
//
// Three assumptions in this spec had rotted, all fixed here:
//
// 1. Shell result frames render minimized by default (kikx-frame-item.mjs
//    `_shouldMinimize`: every tool frame whose name is not in
//    MINIMIZED_EXCEPTIONS, landed in 94a18a7d). A minimized frame sets
//    `.kikx-frame--minimized .kikx-frame__compact { display: none }`
//    (frame-colors.css:422), so its <pre>/<code> have no layout box at all:
//    clientWidth and scrollWidth both read 0. The clipping assertion
//    `codeScrollWidth > codeClientWidth` could therefore never hold (0 > 0).
//    Reveal the frame through the product's own affordance before measuring.
//
// 2. The status tint was asserted as the literals #101c16 / #2f5f45 added by
//    b38b8256. f9d93d0a ("rework frame presentation") deleted both and moved
//    the surface onto the frame colour tokens (--kikx-frame-solid-color /
//    --kikx-frame-border-color, derived from --kikx-frame-type-color via
//    oklch/color-mix). Chrome serialises those as `color(srgb …)`, so a string
//    compare can never match `rgb(…)` again. Assert the token contract instead,
//    normalising through a canvas so it survives palette changes.
//
// 3. The frame's own horizontal overflow was measured on the frame element,
//    but that element deliberately carries two hover affordances painted
//    outside its surface: .kikx-frame__hover-target (inset: -6px -52px -6px
//    -6px) and .kikx-frame__quick-actions (right: -44px), app.css:801-833.
//    They account for exactly the 52px by which scrollWidth exceeded
//    clientWidth, so the assertion measured intentional chrome rather than
//    escaping content. Exclude them and judge the content instead.

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

    // A shell result arrives minimized. Reveal it before measuring geometry: the
    // header carries role="button" while minimized and clicking it is the
    // documented reveal affordance (_revealMinimized).
    let minimized = await page.evaluate(() => document.querySelector('kikx-frame-item[data-frame-id="frame_result"]')
      ?.classList.contains('kikx-frame--minimized') ?? false);
    assert.equal(minimized, true, 'a shell result frame starts minimized');
    await page.evaluate(() => {
      let item = document.querySelector('kikx-frame-item[data-frame-id="frame_result"]');
      item.querySelector('.kikx-frame__meta').click();
    });
    await page.waitForFunction(() => {
      let item = document.querySelector('kikx-frame-item[data-frame-id="frame_result"]');
      let details = item?.querySelector('details.kikx-frame__compact');
      return Boolean(details) && !item.classList.contains('kikx-frame--minimized')
        && getComputedStyle(details).display !== 'none';
    });
    await delay(200);

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
    // Guard the precondition as well as the conclusion, so a future
    // re-minimisation fails here with a readable message instead of a bare
    // `0 > 0` comparison.
    assert.ok(collapsedCommand.codeClientWidth > 0,
      `the collapsed command has a layout box (clientWidth ${collapsedCommand.codeClientWidth})`);
    assert.ok(collapsedCommand.codeScrollWidth > collapsedCommand.codeClientWidth,
      `the collapsed command is clipped horizontally (${collapsedCommand.codeScrollWidth} > ${collapsedCommand.codeClientWidth})`);
    assert.ok(collapsedCommand.scrollHeight <= collapsedCommand.clientHeight + 1, 'the collapsed command row is not vertically clipped');

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

    let headerOrder = await page.evaluate(() => {
      let header = document.querySelector('kikx-frame-item[data-frame-id="frame_result"] kikx-shell-tool-use .kikx-tool-card__header');
      return header ? [ ...header.children ].map((node) => node.textContent) : [];
    });
    assert.deepEqual(headerOrder, [ 'Shell', 'Result:', 'success' ], 'tool name precedes the result/status badges');

    // The frame surface is a token-derived colour, not a literal. Resolve it
    // through a canvas so any CSS syntax (hex, rgb(), color(srgb …)) normalises
    // to comparable 8-bit channels, then assert the contract rather than a
    // frozen hex: a palette change that keeps the contract green stays green,
    // while a frame that stops being tinted at all fails.
    let tint = await page.evaluate(() => {
      const normalize = (value) => {
        let canvas = document.createElement('canvas');
        canvas.width = 1;
        canvas.height = 1;
        let context = canvas.getContext('2d');
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = '#000000';
        context.fillStyle = value;
        context.fillRect(0, 0, 1, 1);
        let [ r, g, b, a ] = context.getImageData(0, 0, 1, 1).data;
        return { r, g, b, a };
      };

      let item = document.querySelector('kikx-frame-item[data-frame-id="frame_result"]');
      // The frame colour tokens are declared on the frame element, so the probe
      // has to live inside it; appending to <body> inherits nothing and reads
      // back the body text colour instead.
      const resolve = (token) => {
        let probe = document.createElement('span');
        probe.style.color = `var(${token})`;
        item.appendChild(probe);
        let value = getComputedStyle(probe).color;
        probe.remove();
        return normalize(value);
      };

      let style = getComputedStyle(item);
      return {
        className: item.className,
        statusColor: resolve('--kikx-frame-status-color'),
        solid: resolve('--kikx-frame-solid-color'),
        type: resolve('--kikx-frame-type-color'),
        background: normalize(style.backgroundColor),
        border: normalize(style.borderColor),
      };
    });

    assert.ok(/kikx-frame--status-success/.test(tint.className),
      'a successful shell result carries the success status class');
    // The surface must be a real painted colour, not transparent (the failure
    // mode this guards: a frame that lost its tint entirely).
    assert.ok(tint.background.a > 0, `the frame surface is painted (alpha ${tint.background.a})`);
    assert.ok(tint.border.a > 0, `the frame border is painted (alpha ${tint.border.a})`);
    // Success green: the status token is green-dominant.
    assert.ok(tint.statusColor.g > tint.statusColor.r && tint.statusColor.g > tint.statusColor.b,
      `the success status colour is green-dominant (r${tint.statusColor.r} g${tint.statusColor.g} b${tint.statusColor.b})`);
    // The border is derived from the tool's type colour, so it must stay in that
    // colour family (exec is amber): warmer than it is blue.
    assert.ok(tint.border.r >= tint.border.b && tint.border.g >= tint.border.b,
      `the frame border follows the tool type colour (r${tint.border.r} g${tint.border.g} b${tint.border.b})`);
    // The solid surface is the type colour mixed toward near-black at 30%, so
    // it must be darker than the raw type colour and not pure black.
    let typeLuma = 0.2126 * tint.type.r + 0.7152 * tint.type.g + 0.0722 * tint.type.b;
    let solidLuma = 0.2126 * tint.solid.r + 0.7152 * tint.solid.g + 0.0722 * tint.solid.b;
    assert.ok(solidLuma < typeLuma, `the solid surface is darker than the type colour (${Math.round(solidLuma)} < ${Math.round(typeLuma)})`);
    assert.ok(solidLuma > 0, 'the solid surface is not pure black');

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
      // The frame carries two hover affordances that are deliberately painted
      // outside its surface: .kikx-frame__hover-target is
      // `position: absolute; inset: -6px -52px -6px -6px` and
      // .kikx-frame__quick-actions sits at `right: -44px` (app.css:801-833,
      // which explains the hover region must extend past the card so the
      // actions do not close on the pointer's way to them). Neither is content
      // escaping the container, so exclude them before judging whether the
      // frame's own content overflows horizontally.
      let affordances = [ ...item.querySelectorAll('.kikx-frame__hover-target, .kikx-frame__quick-actions') ];
      let restore = affordances.map((node) => node.style.display);
      for (let node of affordances)
        node.style.display = 'none';
      let contentScrollWidth = item.scrollWidth;
      affordances.forEach((node, index) => { node.style.display = restore[index]; });
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
          scrollWidth: contentScrollWidth,
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
    assert.ok(metrics.frame.scrollWidth <= metrics.frame.clientWidth + 1,
      `the frame content must not gain horizontal overflow (${metrics.frame.scrollWidth} <= ${metrics.frame.clientWidth + 1})`);
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
