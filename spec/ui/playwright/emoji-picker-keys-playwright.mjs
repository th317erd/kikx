'use strict';

// Real-browser coverage for the emoji typeahead's KEYBOARD path.
//
// Two things the existing browser spec cannot express, both measured in
// Chromium before this file was written:
//
//   1. `overflow-y: auto` lives on the PICKER element, not on
//      `.kikx-emoji-picker__list` (the list reports overflow-y: visible and
//      scrollHeight === clientHeight). Measured: `:a` -> picker
//      scrollHeight 484 / clientHeight 318, list 472/472. So the scroll port
//      is the picker; asserting on the list passes without ever testing scroll.
//   2. If the picker fails to claim Enter, `_onComposerKeydown` falls through
//      to `shouldSubmitComposerKey` -> `form.requestSubmit()` and the
//      half-written ":a" is POSTed as a message. Value-length is an indirect
//      proxy; counting the actual POST is direct, and a negative control
//      proves the counter works.

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
const MESSAGE_POST = '/api/v1/sessions/session_1/messages';

test('arrow keys drive the emoji highlight inside the picker scroll port, and Enter posts nothing', async (t) => {
  let chromePath = findChromeExecutable();
  if (!chromePath) {
    t.skip('real-browser coverage requires Chrome');
    return;
  }

  let fixture = await startStagehandUIServer({
    sessions: [ { id: 'session_1', title: 'Emoji Keys', messageCount: 0 } ],
  });

  let browser = await chromium.launch({
    headless: true,
    executablePath: chromePath,
    chromiumSandbox: false,
    args: [ '--no-sandbox', '--disable-setuid-sandbox' ],
  });

  let pageErrors = [];
  let messagePosts = 0;

  try {
    let page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.on('pageerror', (error) => pageErrors.push(String(error)));
    page.on('request', (request) => {
      if (request.method() !== 'POST')
        return;
      if (request.url().split('?')[0].endsWith(MESSAGE_POST))
        messagePosts += 1;
    });

    await page.addInitScript(() => {
      sessionStorage.setItem('kikx.auth.session', JSON.stringify({
        token: 'playwright-test-token',
        refresh_token: 'playwright-test-refresh',
      }));
    });

    await page.goto(`${fixture.baseURL}/`, { waitUntil: 'domcontentloaded', timeout: 10000 });
    await page.waitForSelector('kikx-session-card', { timeout: 10000 });
    await page.locator('kikx-session-card').first().locator('article.kikx-session-card').click();
    await page.waitForSelector(TEXTAREA, { timeout: 10000 });

    let textarea = page.locator(TEXTAREA);

    // --- 0. negative control for the POST counter -------------------------
    // With the picker CLOSED, Enter really does submit. If this does not
    // register exactly one POST, the counter is broken and the "posted
    // nothing" assertion below would pass for the wrong reason.
    await textarea.click();
    await textarea.type('control message', { delay: 15 });
    await textarea.press('Enter');
    await page.waitForTimeout(500);
    assert.equal(
      messagePosts,
      1,
      'the POST counter must observe a real submit, or the no-submit assertion proves nothing',
    );

    // --- 1. arrow keys move the highlight ---------------------------------
    await textarea.fill('');
    await textarea.click();
    await textarea.type(':a', { delay: 25 });
    await page.waitForSelector(`${PICKER}:not([hidden])`, { timeout: 5000 });

    let opened = await page.evaluate(({ pickerSel, optSel }) => {
      let picker = document.querySelector(pickerSel);
      let options = [ ...document.querySelectorAll(optSel) ];
      return {
        options: options.length,
        selected: options.findIndex((node) => node.getAttribute('aria-selected') === 'true'),
        scrollHeight: picker?.scrollHeight ?? 0,
        clientHeight: picker?.clientHeight ?? 0,
      };
    }, { pickerSel: PICKER, optSel: OPTION });

    assert.ok(opened.options > 1, `a :a query must list more than one emoji, got ${opened.options}`);
    assert.equal(opened.selected, 0, 'the first option starts highlighted');
    assert.ok(
      opened.scrollHeight > opened.clientHeight,
      `the picker must actually overflow for a scroll assertion to mean anything `
        + `(picker scrollHeight=${opened.scrollHeight}, clientHeight=${opened.clientHeight})`,
    );

    await textarea.press('ArrowDown');
    await page.waitForTimeout(120);

    let afterOneDown = await page.evaluate(({ optSel, taSel }) => {
      let options = [ ...document.querySelectorAll(optSel) ];
      let active = options.find((node) => node.getAttribute('aria-selected') === 'true');
      let ta = document.querySelector(taSel);
      return {
        selected: options.indexOf(active),
        activeDescendant: ta?.getAttribute('aria-activedescendant') || '',
        selectedID: active?.id || '',
        pickerHidden: document.querySelector('kikx-emoji-picker')?.hidden === true,
        value: ta?.value ?? '',
      };
    }, { optSel: OPTION, taSel: TEXTAREA });

    assert.equal(afterOneDown.selected, 1, 'ArrowDown moves the highlight to the second option');
    assert.equal(afterOneDown.pickerHidden, false, 'ArrowDown does not close the picker');
    assert.equal(
      afterOneDown.activeDescendant,
      afterOneDown.selectedID,
      'aria-activedescendant follows the highlight so a screen reader tracks it',
    );
    // TRAP 2: ArrowDown also drives message history. If the picker had not
    // claimed the key, the composer value would have been replaced.
    assert.equal(afterOneDown.value, ':a', 'ArrowDown must not fire the composer history (no text swap)');

    // --- 2. every arrow step keeps the active row inside the scroll port ---
    let optionCount = opened.options;
    let offscreen = [];
    let scrollTops = [];
    let indices = [];

    for (let step = 0; step < optionCount + 2; step += 1) {
      await textarea.press('ArrowDown');
      await page.waitForTimeout(70);
      let state = await page.evaluate(({ pickerSel, optSel }) => {
        let picker = document.querySelector(pickerSel);
        let options = [ ...document.querySelectorAll(optSel) ];
        let active = options.find((node) => node.getAttribute('aria-selected') === 'true');
        let box = picker.getBoundingClientRect();
        let row = active ? active.getBoundingClientRect() : null;
        return {
          index: active ? options.indexOf(active) : -1,
          scrollTop: Math.round(picker.scrollTop),
          inside: row ? row.top >= box.top - 1 && row.bottom <= box.bottom + 1 : false,
        };
      }, { pickerSel: PICKER, optSel: OPTION });
      indices.push(state.index);
      scrollTops.push(state.scrollTop);
      if (!state.inside)
        offscreen.push({ step, ...state });
    }

    // Every step is sampled 70ms later, so the repaint has happened: the row
    // must be inside the port. That is what scrollIntoView({block:'nearest'})
    // exists to guarantee, and it is unprovable in mini-dom (no layout).
    assert.deepEqual(
      offscreen,
      [],
      `the highlighted row must be inside the picker scroll port after every arrow step; `
        + `offscreen at ${JSON.stringify(offscreen.slice(0, 3))}`,
    );
    assert.ok(
      indices.includes(optionCount - 1),
      `arrowing must reach the last option, saw indices ${indices.join(',')}`,
    );
    assert.ok(
      Math.max(...scrollTops) > 0,
      `the picker must actually scroll to reach the last row, saw scrollTop trace ${scrollTops.join(',')}`,
    );

    // --- 3. Enter accepts the HIGHLIGHTED option, and posts nothing -------
    // Re-open on a fresh query and move exactly one row, so "which row was
    // accepted" is unambiguous.
    await textarea.fill('');
    await textarea.click();
    await textarea.type(':a', { delay: 25 });
    await page.waitForSelector(`${PICKER}:not([hidden])`, { timeout: 5000 });
    await textarea.press('ArrowDown');
    await page.waitForTimeout(120);

    let highlighted = await page.evaluate((optSel) => {
      let options = [ ...document.querySelectorAll(optSel) ];
      let active = options.find((node) => node.getAttribute('aria-selected') === 'true');
      return { glyph: active?.getAttribute('data-emoji') || '', index: options.indexOf(active) };
    }, OPTION);

    assert.equal(highlighted.index, 1, 'the highlight sits on the second option before Enter');
    assert.ok(highlighted.glyph.length > 0, 'the highlighted option carries a glyph');

    let postsBeforeEnter = messagePosts;
    await textarea.press('Enter');
    await page.waitForTimeout(400);

    let afterEnter = await page.evaluate(({ taSel, pickerSel }) => {
      let ta = document.querySelector(taSel);
      return {
        value: ta?.value ?? '',
        caret: ta?.selectionStart ?? -1,
        pickerHidden: document.querySelector(pickerSel)?.hidden === true,
      };
    }, { taSel: TEXTAREA, pickerSel: PICKER });

    assert.equal(
      afterEnter.value,
      highlighted.glyph,
      'Enter inserts the option the arrows navigated to, not the first one',
    );
    assert.equal(afterEnter.caret, afterEnter.value.length, 'the caret lands after the inserted glyph');
    assert.equal(afterEnter.pickerHidden, true, 'the picker closes after accepting');
    // TRAP 1, proven at the network boundary rather than by value length.
    assert.equal(
      messagePosts,
      postsBeforeEnter,
      'Enter with the picker open must not POST the half-written message',
    );

    // --- 4. Enter still submits once the picker is closed -----------------
    await textarea.fill('');
    let postsBeforeClosedEnter = messagePosts;
    await textarea.type('closed picker message', { delay: 15 });
    await textarea.press('Escape');
    await page.waitForTimeout(100);
    await textarea.press('Enter');
    await page.waitForTimeout(500);
    assert.equal(
      messagePosts,
      postsBeforeClosedEnter + 1,
      'with the picker closed Enter still submits, so the claim above is about the open picker only',
    );

    assert.deepEqual(pageErrors, [], 'no page errors during the whole flow');
  } finally {
    // Order is load-bearing: closing the fixture first leaves keep-alive
    // sockets holding http.Server.close() open and node:test reports an opaque
    // timeout instead of the real assertion failure.
    await browser.close();
    await fixture.close();
  }
});
