'use strict';

// Pixel-level parity between the in-thread Question frame and the Inbox row.
//
// The owner reported, twice, that the Inbox rows are not styled like a Question
// frame. Every previous attempt fixed class NAMES and asserted on names, so the
// assertion could pass while the paint stayed wrong: mini-DOM has no cascade,
// and a spec that reads `className` cannot see a colour or a box.
//
// This spec renders BOTH surfaces through the PRODUCTION renderers, against the
// real `questions.css` AND the real vendored `aeor-web-components` stylesheets
// (the close and dismiss controls are custom elements whose size comes from
// those files), then asks Chrome for the computed style of the matching element
// on each side. A difference is a failure that names both values.
//
// Why a static server rather than `page.setContent`: the latter yields an
// `about:blank` origin, where a relative ESM import cannot resolve. A harness
// that cannot import the renderers renders nothing, and "nothing" compares equal
// to "nothing" — it "passes". Serving the repo root and the vendor root at the
// same paths the real server uses (`src/server/static-files.mjs`) is what makes
// the measurement real.
//
// The frame element self-registers (`kikx-question-frame.mjs` calls
// `customElements.define` at module load), so importing the module is enough.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize, resolve } from 'node:path';

import { chromium } from 'playwright';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const VENDOR = process.env.KIKX_AEOR_WEB_COMPONENTS_ROOT
  || '/home/wyatt/Projects/aeor-web-components';

// The vendor stylesheets the shell loads, in the shell's order. Without these
// the two custom-element controls have no box at all, and a comparison of a
// 0x0 node against a 0x0 node is not a comparison.
const VENDOR_STYLES = [
  'styles/tokens.css',
  'styles/globals.css',
  'styles/components.css',
  'components/aeor-input.css',
  'components/aeor-modal.css',
  'components/aeor-select.css',
  'components/aeor-checkbox.css',
  'components/aeor-confirm-button.css',
  'components/aeor-progress-button.css',
];

const APP_STYLES = [
  'client/styles/app.css',
  'client/styles/questions.css',
];

// Both surfaces get the SAME width, so a column-width difference cannot
// masquerade as a styling difference.
//
// Several widths are measured, not one. The Inbox lives in a sidebar far
// narrower than the chat column, and a wrapping difference in the meta row is
// invisible at 420px: a `flex-wrap` mutant survives there. A width where the
// row is tight is the only place that behaviour can be observed.
const COLUMN_WIDTHS = [420, 300, 240];

// Elements that must match: [label, selector inside #thread, selector inside #inbox]
const MUST_MATCH = [
  // The BOX, not just what is inside it. Every earlier comparison started at
  // the first child, so the container rule was the one thing never measured —
  // and a container rule is exactly what "does not look like a QuestionFrame"
  // describes. The Inbox row's outer <article> is the analogue of the
  // frame's __card, so they must compute alike too.
  ['row box', '.kikx-question-frame__card', '.kikx-question-card__answer'],
  ['meta row', '.kikx-question-frame__meta', '.kikx-question-card__header'],
  ['agent', '.kikx-question-frame__agent', '.kikx-question-card__agent'],
  ['age', '.kikx-question-frame__age', '.kikx-question-card__age'],
  ['question text', '.kikx-question-frame__text', '.kikx-question-card__text'],
  ['answer textarea', '.kikx-question-frame__answer', '.kikx-question-card__input'],
  ['submit', '.kikx-question-frame__submit', '.kikx-question-card__submit'],
  ['answer actions row', '.kikx-question-frame__actions', '.kikx-question-card__actions'],
  ['close control', '.kikx-question-frame__meta .kikx-question-card__dismiss-close',
    '.kikx-question-card__header .kikx-question-card__dismiss-close'],
];

const PROPS = [
  'display',
  'color',
  'backgroundColor',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'lineHeight',
  'letterSpacing',
  'textTransform',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'borderTopWidth',
  'borderLeftWidth',
  'borderTopLeftRadius',
  // Colours, not just widths. Without these the row could keep a neutral grey
  // edge beside the frame's pink one and every assertion would still pass —
  // which is exactly the class of miss that let \"does not look like a Question
  // Frame\" survive several rounds of green tests.
  'borderTopColor',
  'borderLeftColor',
  'borderTopStyle',
  'minHeight',
];

const MIME = {
  '.mjs': 'text/javascript',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.html': 'text/html',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

function readIfPresent(absolutePath) {
  try {
    return readFileSync(absolutePath, 'utf8');
  } catch {
    return null;
  }
}

function styleTags() {
  let missingVendor = [];
  let blocks = [];

  for (let rel of VENDOR_STYLES) {
    let text = readIfPresent(join(VENDOR, rel));
    if (text === null) {
      missingVendor.push(rel);
      continue;
    }
    blocks.push(`<style data-vendor="${rel}">${text}</style>`);
  }

  for (let rel of APP_STYLES)
    blocks.push(`<style data-app="${rel}">${readIfPresent(join(REPO, 'src', rel)) ?? ''}</style>`);

  return { html: blocks.join('\n'), missingVendor };
}

const QUESTION = {
  id: 'q-parity',
  groupID: 'g-parity',
  index: 1,
  status: 'open',
  mode: 'wait',
  sessionID: 'session_1',
  agentID: 'Zav',
  text: 'Ship the Inbox as-is, or split the card renderer first?',
  priority: 'normal',
  askedAt: 1_700_000_000_000,
  readAt: null,
  contextRefs: [],
  deleted: false,
};

function harnessPage() {
  let { html, missingVendor } = styleTags();

  return {
    missingVendor,
    page: `<!doctype html>
<html><head><meta charset="utf-8"><title>parity</title>
<style>
  body { margin: 0; background: #0d1117; font-family: system-ui, sans-serif; }
  :root { --column-width: ${COLUMN_WIDTHS[0]}px; }
  #thread, #inbox { width: var(--column-width); }
</style>
${html}
</head><body>
  <div id="thread"></div>
  <div id="inbox"></div>
  <script type="module">
    window.__result = { stage: 'start' };
    try {
      const { renderInboxQuestionRow } = await import('/src/client/components/kikx-question-surface.mjs');
      await import('/src/client/components/kikx-question-frame.mjs');

      const QUESTION = ${JSON.stringify(QUESTION)};
      const NOW = 1700000000000;

      const frame = document.createElement('kikx-question-frame');
      document.getElementById('thread').appendChild(frame);
      frame.updateFrame(
        { content: { question: QUESTION } },
        { app: null },
        { inboxChrome: false, now: NOW },
      );

      const row = renderInboxQuestionRow(
        { ownerDocument: document },
        QUESTION,
        { handlers: null, groupCount: 1, now: NOW },
      );
      if (row)
        document.getElementById('inbox').appendChild(row);

      window.__result = {
        stage: 'rendered',
        threadCard: !!document.querySelector('#thread .kikx-question-frame__card'),
        inboxRow: !!document.querySelector('#inbox .kikx-question-card'),
        inboxFrame: !!document.querySelector('#inbox kikx-question-frame'),
        threadClose: !!document.querySelector('#thread .kikx-question-card__dismiss-close'),
        inboxClose: !!document.querySelector('#inbox .kikx-question-card__dismiss-close'),
      };
    } catch (error) {
      window.__result = { stage: 'error', error: String((error && error.stack) || error) };
    }
  </script>
</body></html>`,
  };
}

// Serve the two roots the real server serves, at the same URL prefixes.
function startStaticServer(harnessHTML) {
  // `fonts/` is here because the vendor stylesheets are inlined into the page,
  // which makes their relative `../fonts/*.woff2` references resolve against the
  // document URL rather than the stylesheet URL. Serving them keeps text metrics
  // identical to the real shell instead of falling back to a system face.
  let roots = [
    ['/vendor/aeor-web-components/', VENDOR],
    ['/fonts/', join(VENDOR, 'fonts')],
    ['/src/', join(REPO, 'src')],
  ];

  let server = createServer((request, response) => {
    let url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/__parity')
      return response.writeHead(200, { 'content-type': 'text/html' }).end(harnessHTML);

    for (let [prefix, root] of roots) {
      if (!url.pathname.startsWith(prefix))
        continue;

      let target = normalize(join(root, url.pathname.slice(prefix.length)));
      // Refuse traversal: the resolved path must stay inside its root.
      if (!target.startsWith(normalize(root)))
        return response.writeHead(403).end('forbidden');

      let body;
      try {
        body = readFileSync(target);
      } catch {
        return response.writeHead(404).end('not found');
      }

      return response.writeHead(200, {
        'content-type': MIME[extname(target)] || 'application/octet-stream',
      }).end(body);
    }

    return response.writeHead(404).end('not found');
  });

  return new Promise((resolvePromise) => {
    server.listen(0, '127.0.0.1', () => resolvePromise({ server, port: server.address().port }));
  });
}

test('the Inbox row and the in-thread Question frame compute to the same visual style', async (t) => {
  let { page: harnessHTML, missingVendor } = harnessPage();

  assert.deepEqual(missingVendor, [],
    'the vendored aeor-web-components stylesheets must be present, or the custom-element '
    + 'controls have no box to measure. Set KIKX_AEOR_WEB_COMPONENTS_ROOT if the checkout moved.');

  let { server, port } = await startStaticServer(harnessHTML);
  t.after(() => new Promise((done) => server.close(done)));

  let browser = await chromium.launch();
  t.after(() => browser.close());

  let page = await browser.newPage({ viewport: { width: 900, height: 1400 } });

  // A page error must fail the run: a broken import renders nothing, and
  // "nothing" compares equal to "nothing".
  let pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  let failedResponses = [];
  page.on('response', (response) => {
    if (response.status() >= 400)
      failedResponses.push(response.status() + ' ' + response.url());
  });
  page.on('console', (message) => {
    if (message.type() === 'error')
      pageErrors.push(message.text());
  });

  await page.goto(`http://127.0.0.1:${port}/__parity`, { waitUntil: 'networkidle' });

  await page.waitForFunction(
    () => window.__result && window.__result.stage !== 'start',
    null,
    { timeout: 20000 },
  );
  let result = await page.evaluate(() => window.__result);

  t.diagnostic('render report: ' + JSON.stringify(result));
  if (pageErrors.length > 0)
    t.diagnostic('page errors: ' + pageErrors.join(' | '));

  if (failedResponses.length > 0)
    t.diagnostic('failed requests: ' + failedResponses.join(' | '));

  assert.deepEqual(pageErrors.filter((text) => !text.includes('Failed to load resource')), [],
    'the harness page threw script errors');
  assert.deepEqual(failedResponses, [], 'every asset the harness asked for must exist');
  assert.equal(result.stage, 'rendered', 'the harness failed: ' + (result.error || ''));
  assert.ok(result.threadCard, 'the production frame produced no card');
  assert.ok(result.inboxRow, 'the production Inbox adapter produced no row');
  assert.ok(result.inboxFrame, 'the Inbox row did not mount a real kikx-question-frame');
  assert.ok(result.threadClose, 'the frame rendered no close control');
  assert.ok(result.inboxClose, 'the Inbox row rendered no close control');

  // Custom elements upgrade asynchronously; measure only after they have.
  await page.waitForTimeout(150);

  let measuredByWidth = {};
  for (let width of COLUMN_WIDTHS) {
    await page.evaluate((value) => {
      document.documentElement.style.setProperty('--column-width', value + 'px');
    }, width);
    await page.waitForTimeout(60);

    measuredByWidth[width] = await page.evaluate(measure, { mustMatch: MUST_MATCH, props: PROPS });
  }

  function measure({ mustMatch, props }) {
    // The gap is measured from the OUTER card box, not the immediate parent.
    // The two surfaces nest differently — the frame's form IS the card, while the
    // Inbox row wraps the form in an <article> — so a parent-relative gap compares
    // a padded box against an unpadded one and reports identical pixels as a
    // difference.
    function snapshot(scope, selector, rootSelector) {
      let node = document.querySelector(scope + ' ' + selector);
      if (!node)
        return null;

      let root = document.querySelector(scope + ' ' + rootSelector);
      if (!root)
        return null;

      let style = getComputedStyle(node);
      let box = node.getBoundingClientRect();
      let parentBox = root.getBoundingClientRect();

      let out = {
        width: Math.round(box.width),
        height: Math.round(box.height),
        // The reported symptom was the close button sliding left, so measure
        // where it actually sits rather than inferring it from margin rules.
        rightGap: Math.round(parentBox.right - box.right),
      };
      for (let prop of props)
        out[prop] = style[prop];
      return out;
    }

    const FRAME_ROOT = '.kikx-question-frame__card';
    // The FORM, not the <article> wrapper: the box lives on the form now, and
    // measuring the close control's inset against a padding-free wrapper would
    // compare two different reference edges on the two sides.
    const INBOX_ROOT = '.kikx-question-card__answer';

    return mustMatch.map(([label, frameSelector, inboxSelector]) => {
      let frameNode = document.querySelector('#thread ' + frameSelector);
      let inboxNode = document.querySelector('#inbox ' + inboxSelector);
      return {
        label,
        frame: snapshot('#thread', frameSelector, FRAME_ROOT),
        inbox: snapshot('#inbox', inboxSelector, INBOX_ROOT),
        frameTag: frameNode ? frameNode.tagName.toLowerCase() : null,
        inboxTag: inboxNode ? inboxNode.tagName.toLowerCase() : null,
        inboxParentTag: inboxNode?.parentElement ? inboxNode.parentElement.tagName.toLowerCase() : null,
        inboxParentClass: inboxNode?.parentElement?.className ?? null,
      };
    });
  }

  // The wrapper must stay a wrapper.
  //
  // The defect this whole spec exists to catch had a second half: the Inbox row
  // painted its own bordered, padded, tinted box while the frame inside it
  // painted another one. Nested boxes are why a row read as a different
  // component from the question it renders. Moving the box onto the form fixed
  // it; this assertion is what stops it coming back, because a difference-only
  // comparison cannot see a box that appears on BOTH sides.
  let wrapper = await page.evaluate(() => {
    let node = document.querySelector('#inbox .kikx-question-card');
    if (!node)
      return null;
    let style = getComputedStyle(node);
    return {
      display: style.display,
      paddingTop: style.paddingTop,
      paddingRight: style.paddingRight,
      paddingBottom: style.paddingBottom,
      paddingLeft: style.paddingLeft,
      borderTopWidth: style.borderTopWidth,
      borderLeftWidth: style.borderLeftWidth,
      backgroundColor: style.backgroundColor,
    };
  });
  t.diagnostic('inbox wrapper: ' + JSON.stringify(wrapper));

  assert.deepEqual(wrapper, {
    display: 'block',
    paddingTop: '0px',
    paddingRight: '0px',
    paddingBottom: '0px',
    paddingLeft: '0px',
    borderTopWidth: '0px',
    borderLeftWidth: '0px',
    backgroundColor: 'rgba(0, 0, 0, 0)',
  }, 'the Inbox row wrapper must contribute NO box: the question\'s form owns the '
    + 'padding, edge and fill, exactly as on the in-thread surface');

  let missing = [];
  let differences = [];
  for (let width of COLUMN_WIDTHS) {
    for (let row of measuredByWidth[width]) {
      if (!row.frame || !row.inbox) {
        missing.push(`${width}px ${row.label}: frame=${row.frame ? 'ok' : 'MISSING'} inbox=${row.inbox ? 'ok' : 'MISSING'}`);
        continue;
      }
      for (let prop of [...PROPS, 'width', 'height', 'rightGap']) {
        if (row.frame[prop] !== row.inbox[prop]) {
          differences.push({
            width,
            label: row.label,
            prop,
            frame: row.frame[prop],
            inbox: row.inbox[prop],
          });
        }
      }
    }
  }

  // Parity alone is not enough for the close control. If BOTH surfaces drifted
  // left together, every comparison above would pass and the reported bug would
  // be back. So also pin it to the end of the row in absolute terms.
  //
  // Two separate assertions, because they are two different defects:
  //
  //   1. LEFT DRIFT — a large POSITIVE gap between the control's right edge and
  //      the card's right edge. This is the reported bug ("the close button is
  //      now shifting over to the left"), and it must hold at every width. It is
  //      the regression this file exists to catch.
  //
  //   2. OVERFLOW — a NEGATIVE gap, the control hanging past the card's right
  //      edge. Measured at 300px (-24) and 240px (-84) on BOTH surfaces, so it
  //      is a pre-existing narrow-column defect, not a unification regression,
  //      and at the realistic width it does not occur. Recorded as a diagnostic
  //      rather than silently tolerated: asserting the exact overflow pixels
  //      would turn another browser's rounding into a false failure.
  let drifted = [];
  let overflowed = [];
  let gaps = [];
  for (let width of COLUMN_WIDTHS) {
    for (let row of measuredByWidth[width]) {
      if (row.label !== 'close control') continue;
      for (let side of ['inbox', 'frame']) {
        if (!row[side]) continue;
        let gap = row[side].rightGap;
        gaps.push(`  @${width}px ${side}: rightGap=${gap}`);
        if (gap > 20) drifted.push({ width, side, rightGap: gap });
        if (gap < 0) overflowed.push(`@${width}px ${side} overflow=${-gap}px`);
      }
    }
  }

  // The primary column is the width the owner actually reported against; there
  // the control must be flush with the end of the row, not merely consistent.
  let primary = measuredByWidth[COLUMN_WIDTHS[0]]
    .filter((row) => row.label === 'close control' && row.inbox)
    .map((row) => row.inbox.rightGap);
  assert.ok(primary.length > 0, 'the close control must be measured on the Inbox side');
  for (let gap of primary)
    assert.ok(
      gap >= 0 && gap <= 20,
      `at ${COLUMN_WIDTHS[0]}px the close control must sit at the end of the row, `
        + `but its right gap is ${gap}px`,
    );

  let structure = measuredByWidth[COLUMN_WIDTHS[0]];
  t.diagnostic('structure:\n' + structure
    .map((row) => `  ${row.label}: frame=<${row.frameTag}> inbox=<${row.inboxTag}> parent=<${row.inboxParentTag} class="${row.inboxParentClass}">`)
    .join('\n'));

  t.diagnostic('close control right gap (px from the card\'s right edge, negative = overflow):\n'
    + gaps.join('\n'));
  t.diagnostic('narrow-column overflow (' + overflowed.length + '):\n'
    + (overflowed.join('  ') || '  (none)'));

  t.diagnostic('style differences across widths ' + COLUMN_WIDTHS.join('/') + ':\n'
    + (differences.map((diff) => `  @${diff.width}px ${diff.label}.${diff.prop}: frame=${diff.frame} inbox=${diff.inbox}`).join('\n') || '  (none)'));

  assert.deepEqual(missing, [], 'both surfaces must render every compared element');
  assert.deepEqual(
    drifted,
    [],
    'the close control drifted left of the end of the row at some width; this is the '
      + 'reported "close button shifted over to the left" bug',
  );
  assert.deepEqual(differences, [],
    'the Inbox row must compute to the same visual style as the in-thread frame');
});
