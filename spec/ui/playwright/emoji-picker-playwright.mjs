'use strict';

// Real-browser coverage for the composer emoji typeahead (owner request
// 2026-10-30: "Slack/Discord-style emoji selector ... filter to emojis, and
// allow me to select them with the mouse or keyboard").
//
// This lane exists because mini-dom cannot prove any of the following: it has
// no KeyboardEvent, no setSelectionRange and no selectionStart, and no layout
// engine or CSS cascade. The unit specs prove the span maths and the key
// claiming; only Chromium can prove that a real `:` keystroke opens a popup
// that is actually on screen, that a real Enter inserts instead of submitting,
// and that the caret really lands after the glyph.

import assert from 'node:assert/strict';
import test from 'node:test';

import { chromium } from 'playwright';

import {
  findChromeExecutable,
  startStagehandUIServer,
} from '../stagehand/stagehand-test-utils.mjs';

const TEXTAREA = 'form.kikx-composer textarea[name="message"]';
const PICKER = 'kikx-emoji-picker';
const OPTION = 'kikx-emoji-picker .kikx-emoji-picker__option';

test('the composer emoji typeahead opens on a real colon, filters, and inserts by key and by mouse', async (t) => {
  let chromePath = findChromeExecutable();
  if (!chromePath) {
    t.skip('real-browser coverage requires Chrome');
    return;
  }

  let fixture = await startStagehandUIServer({
    sessions: [ { id: 'session_1', title: 'Emoji Session', messageCount: 0 } ],
  });

  let browser = await chromium.launch({
    headless: true,
    executablePath: chromePath,
    chromiumSandbox: false,
    args: [ '--no-sandbox', '--disable-setuid-sandbox' ],
  });

  let pageErrors = [];
  try {
    let page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.on('pageerror', (error) => pageErrors.push(String(error)));

    await page.addInitScript(() => {
      sessionStorage.setItem('kikx.auth.session', JSON.stringify({ token: 'playwright-test-token', refresh_token: 'playwright-test-refresh' }));
    });

    await page.goto(`${fixture.baseURL}/`, { waitUntil: 'domcontentloaded', timeout: 10000 });
    await page.waitForSelector('kikx-session-card', { timeout: 10000 });
    await page.locator('kikx-session-card').first().locator('article.kikx-session-card').click();
    await page.waitForSelector(TEXTAREA, { timeout: 10000 });

    // The picker must be registered AND mounted in the real shell, not merely
    // importable -- an unwired component is the failure mode this asserts against.
    assert.equal(
      await page.evaluate(() => document.querySelectorAll('kikx-emoji-picker').length),
      1,
      'exactly one picker is mounted in the composer',
    );
    assert.equal(
      await page.evaluate(() => document.querySelector('kikx-emoji-picker')?.hidden === true),
      true,
      'the picker starts closed',
    );

    // --- 1. a real colon + query opens a popup that is actually on screen ----
    let textarea = page.locator(TEXTAREA);
    await textarea.click();
    await textarea.type(':smi', { delay: 30 });
    await page.waitForSelector(`${PICKER}:not([hidden])`, { timeout: 5000 });

    let openState = await page.evaluate(({ pickerSel, optionSel }) => {
      let picker = document.querySelector(pickerSel);
      let box = picker?.getBoundingClientRect();
      let composer = document.querySelector('form.kikx-composer')?.getBoundingClientRect();
      let options = [...document.querySelectorAll(optionSel)];
      return {
        visible: picker ? getComputedStyle(picker).display !== 'none' : false,
        width: box ? Math.round(box.width) : 0,
        height: box ? Math.round(box.height) : 0,
        options: options.length,
        firstGlyph: options[0]?.getAttribute('data-emoji') || '',
        firstCode: options[0]?.textContent || '',
        // The popup floats above the composer rather than pushing it around.
        aboveComposer: box && composer ? box.bottom <= composer.top + 1 : null,
      };
    }, { pickerSel: PICKER, optionSel: OPTION });

    assert.equal(openState.visible, true, 'the popup must be displayed, not just un-hidden');
    assert.ok(openState.width > 0 && openState.height > 0,
      `the popup must have a real box, got ${openState.width}x${openState.height} -- a zero box means the CSS never applied`);
    assert.ok(openState.options > 1, `a :smi query should list several emoji, got ${openState.options}`);
    assert.ok(openState.firstGlyph.length > 0, 'each option carries its glyph');
    assert.ok(openState.firstCode.includes(':'), 'each option shows its shortcode');
    assert.notEqual(openState.aboveComposer, false, 'the popup sits above the composer');

    // --- 2. a real Enter INSERTS and must not submit the message ------------
    let before = await page.evaluate(() => document.querySelector('kikx-app')?._state?.draft);
    assert.equal(before, ':smi');

    await textarea.press('Enter');
    await page.waitForTimeout(200);

    let afterEnter = await page.evaluate(({ taSel, pickerSel }) => {
      let ta = document.querySelector(taSel);
      return {
        value: ta?.value ?? null,
        caret: ta?.selectionStart ?? -1,
        length: ta?.value?.length ?? 0,
        pickerHidden: document.querySelector(pickerSel)?.hidden === true,
        draft: document.querySelector('kikx-app')?._state?.draft,
      };
    }, { taSel: TEXTAREA, pickerSel: PICKER });

    assert.ok(afterEnter.value && !afterEnter.value.includes(':'),
      `Enter must insert the glyph, not send the literal ":smi"; got ${JSON.stringify(afterEnter.value)}`);
    assert.equal(afterEnter.caret, afterEnter.length,
      'the caret lands immediately after the inserted glyph');
    assert.equal(afterEnter.pickerHidden, true, 'the picker closes after insertion');
    assert.equal(afterEnter.draft, afterEnter.value,
      'the draft tracks the insertion exactly as typing would');

    // Nothing was sent: the composer still holds the glyph.
    assert.ok(
      await page.evaluate((taSel) => document.querySelector(taSel)?.value?.length > 0, TEXTAREA),
      'Enter did not submit the message',
    );

    // --- 3. mouse selection inserts the clicked option ----------------------
    await textarea.fill('');
    await textarea.click();
    await textarea.type(':tad', { delay: 30 });
    await page.waitForSelector(`${PICKER}:not([hidden])`, { timeout: 5000 });

    let target = page.locator(OPTION).first();
    let targetGlyph = await target.getAttribute('data-emoji');
    await target.click();
    await page.waitForTimeout(200);

    let afterClick = await page.evaluate(({ taSel, pickerSel }) => ({
      value: document.querySelector(taSel)?.value ?? null,
      caret: document.querySelector(taSel)?.selectionStart ?? -1,
      pickerHidden: document.querySelector(pickerSel)?.hidden === true,
      // A click that steals focus would make this the active element instead.
      focusedTag: document.activeElement?.tagName?.toLowerCase() || '',
    }), { taSel: TEXTAREA, pickerSel: PICKER });

    assert.equal(afterClick.value, targetGlyph,
      'a mouse click inserts exactly the option that was clicked');
    assert.equal(afterClick.caret, afterClick.value.length, 'the caret follows the mouse insertion too');
    assert.equal(afterClick.pickerHidden, true, 'mouse selection closes the picker');
    assert.equal(afterClick.focusedTag, 'textarea',
      'the click must not steal focus away from the composer');

    // --- 4. Escape closes without editing -----------------------------------
    await textarea.fill('');
    await textarea.type(':roc', { delay: 30 });
    await page.waitForSelector(`${PICKER}:not([hidden])`, { timeout: 5000 });
    await textarea.press('Escape');
    await page.waitForTimeout(150);

    let afterEscape = await page.evaluate(({ taSel, pickerSel }) => ({
      value: document.querySelector(taSel)?.value ?? null,
      pickerHidden: document.querySelector(pickerSel)?.hidden === true,
    }), { taSel: TEXTAREA, pickerSel: PICKER });

    assert.equal(afterEscape.value, ':roc', 'Escape leaves the typed text alone');
    assert.equal(afterEscape.pickerHidden, true, 'Escape closes the picker');

    // --- 5. a colon mid-URL must not open the popup -------------------------
    await textarea.fill('');
    await textarea.click();
    await textarea.type('https://example.com', { delay: 20 });
    await page.waitForTimeout(200);
    assert.equal(
      await page.evaluate((pickerSel) => document.querySelector(pickerSel)?.hidden === true, PICKER),
      true,
      'a colon inside a URL must not open the picker',
    );

    assert.deepEqual(pageErrors, [], 'no page errors during the whole flow');
  } finally {
    await browser.close();
    await fixture.close();
  }
});
