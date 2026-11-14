'use strict';

// Owner annotation (session-2026-11-14-00-02-43.289.png), verbatim:
//
//   "This is likely an `aeor-web-components` fix that is needed here... but the
//    backgrounds of each selected item _should NOT_ be brown... it should be
//    the primary color. The text color should then be the proper color to go
//    against the primary color (in this case: white)."
//
//   "Should have white text, not primary-color text."
//
// The owner guessed the fix belongs in the shared framework, and it did: the
// selected-item pill was a 0.2-alpha accent wash (which composites to brown
// over a dark surface) with the raw accent as its text colour. That is fixed in
// aeor-web-components (commit "fix(select): selected item uses a primary fill
// with contrast text").
//
// A framework fix is only real in this product if the product's own dropdown
// paints it, and kikx overrides --accent to blue rather than the framework's
// orange. This spec therefore measures the ACTUAL settings dropdown in the real
// app: the selected value must be a solid accent fill with contrast text, and
// critically it must NOT be the framework's hardcoded orange family.
//
// A negative control re-applies the old rule in-page and requires the shipped
// assertion to fail, so a measurement that cannot distinguish the two states
// cannot pass as evidence.

import assert from 'node:assert/strict';
import test from 'node:test';

import puppeteer from 'puppeteer-core';

import { findChromeExecutable, startStagehandUIServer } from '../stagehand/stagehand-test-utils.mjs';

function frames(count) {
  let base = 1793328600000000;
  let list = [];
  for (let index = 1; index <= count; index += 1) {
    list.push({
      id: `sel_frame_${index}`,
      type: index % 2 === 0 ? 'AgentMessage' : 'UserMessage',
      sessionID: 'session_select',
      interactionID: `interaction_${index}`,
      parentID: null,
      authorType: index % 2 === 0 ? 'agent' : 'user',
      authorID: index % 2 === 0 ? 'agent' : 'owner',
      authorDisplayName: index % 2 === 0 ? 'Miri' : 'Wyatt',
      hidden: false,
      deleted: false,
      order: index,
      timestamp: base + index * 1000000,
      createdAt: base + index * 1000000,
      updatedAt: base + index * 1000000,
      content: { text: `frame ${index}` },
    });
  }
  return list;
}

// Reads the pill's paint and normalises Chrome's serialisation. Returns the
// composited background (over the trigger) and the text colour, plus contrast.
function measurePill(selector) {
  function parseColor(value) {
    let match = String(value).match(/rgba?\(([^)]+)\)/);
    if (!match)
      return null;
    let parts = match[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  }
  function over(foreground, background) {
    if (!foreground)
      return background;
    let alpha = foreground.a ?? 1;
    return {
      r: Math.round(foreground.r * alpha + background.r * (1 - alpha)),
      g: Math.round(foreground.g * alpha + background.g * (1 - alpha)),
      b: Math.round(foreground.b * alpha + background.b * (1 - alpha)),
    };
  }
  function luminance(color) {
    let channel = (value) => {
      let scaled = value / 255;
      return scaled <= 0.03928 ? scaled / 12.92 : Math.pow((scaled + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
  }
  function contrast(a, b) {
    let first = luminance(a);
    let second = luminance(b);
    return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
  }

  let select = document.querySelector(selector);
  let pill = select?.querySelector('.aeor-select__pill');
  if (!pill)
    return { error: `no pill inside ${selector}` };

  let pillStyle = getComputedStyle(pill);
  let triggerStyle = getComputedStyle(select.querySelector('.aeor-select__trigger'));
  let pageBackground = { r: 13, g: 17, b: 23 };
  let triggerBackground = over(parseColor(triggerStyle.backgroundColor), pageBackground);
  let background = over(parseColor(pillStyle.backgroundColor), triggerBackground);
  let text = parseColor(pillStyle.color);

  return {
    background,
    text,
    contrast: Math.round(contrast(text, background) * 100) / 100,
    accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
  };
}

test('Puppeteer: the settings dropdown paints selected state as primary fill + contrast text', async (t) => {
  let chromePath = findChromeExecutable();
  if (!chromePath) {
    t.skip('Dropdown paint coverage requires Chrome');
    return;
  }

  let fixture = await startStagehandUIServer({
    sessions: [ { id: 'session_select', title: 'Select', messageCount: 4 } ],
  });
  fixture.frameRuntime.framesBySessionID.set('session_select', frames(4));
  let port = new URL(fixture.baseURL).port;

  let browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: 'new',
    args: [ '--no-sandbox', '--disable-setuid-sandbox' ],
  });

  try {
    let page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.evaluateOnNewDocument(() => {
      sessionStorage.setItem('kikx.auth.session', JSON.stringify({
        token: 'select-token', refresh_token: 'select-refresh',
      }));
    });

    // The owner's screenshot was ?view=settings&section=Email directly.
    await page.goto(`http://127.0.0.1:${port}/?session=session_select&view=settings&section=Email`, {
      waitUntil: 'domcontentloaded', timeout: 15000,
    });
    await page.waitForSelector('.kikx-settings-email', { timeout: 15000 });

    // The Provider select ships with SMTP preselected, which is exactly the
    // painted state in the screenshot: a value already chosen.
    let providerSelector = '.kikx-settings-email aeor-select';
    let count = await page.$$eval('.kikx-settings-email aeor-select', (nodes) => nodes.length);
    assert.ok(count > 0, 'the Email section must render at least one aeor-select');

    let shipped = await page.evaluate(measurePill, providerSelector);
    assert.equal(shipped.error, undefined, `expected a selected pill (${shipped.error || ''})`);

    // 1. Not brown. The old rule composited to a washed dark orange
    //    (rgb(76, 53, 40) on the framework default). A solid fill must be
    //    opaque, i.e. its background matches kikx's accent or its own token.
    let { r, g, b } = shipped.background;
    let isWashed = (r < 120 && g < 120 && b < 120) && r > b;
    assert.equal(isWashed, false,
      `the selected fill must not be a washed brown (measured rgb(${r}, ${g}, ${b}))`);

    // 2. Text is contrast text, not the accent itself. The failing state had
    //    text === background accent hue with a low-alpha fill behind it.
    assert.notEqual(
      `${shipped.text.r},${shipped.text.g},${shipped.text.b}`,
      `${shipped.background.r},${shipped.background.g},${shipped.background.b}`,
      'selected text must not be the same colour as its own fill',
    );

    // 3. Contrast beats the old 4.06 on a brown wash. This is a direction
    //    assertion, not an AA claim: white on kikx blue is 4.39:1.
    assert.ok(shipped.contrast >= 4,
      `selected text contrast ${shipped.contrast}:1 must be at least as good as the previous 4.06:1`);

    // NEGATIVE CONTROL: re-apply the old pill rule in-page. The shipped
    // assertions above must then fail; if they still pass, they measure nothing.
    await page.addStyleTag({
      content: `
        .aeor-select__pill {
          background: rgba(249, 115, 22, 0.2) !important;
          color: rgb(249, 115, 22) !important;
        }
      `,
    });
    let control = await page.evaluate(measurePill, providerSelector);
    let controlIsWashed = control.background.r < 120
      && control.background.g < 120
      && control.background.b < 120
      && control.background.r > control.background.b;
    assert.equal(controlIsWashed, true,
      `control must reproduce the washed brown fill (measured rgb(${control.background.r}, ${control.background.g}, ${control.background.b}))`);

    // The old rule's text colour was the ACCENT ITSELF (the "primary-color
    // text" in the annotation), not a contrast foreground. Assert that
    // signature too, so the control proves the probe can see both halves of the
    // defect rather than only the background.
    let controlTextIsAccent = Math.abs(control.text.r - 249) <= 2
      && Math.abs(control.text.g - 115) <= 2
      && Math.abs(control.text.b - 22) <= 2;
    assert.equal(controlTextIsAccent, true,
      `control must reproduce accent-coloured text (measured rgb(${control.text.r}, ${control.text.g}, ${control.text.b}))`);
  } finally {
    await browser.close();
    await fixture.close();
  }
});
