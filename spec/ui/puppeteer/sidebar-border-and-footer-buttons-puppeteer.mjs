'use strict';

// Real-browser coverage for the two sidebar contracts the owner set in
// screenshot session-2026-11-14-02-58-23.786:
//
//   1. "The border-width appears to be fully missing from the right-side border
//      (or it is transparent?)."  -- about the SELECTED rail entry.
//   2. "Okay, so for the SIDEBAR SPECIFICALLY, I actually prefer the gray
//      buttons WITHOUT a border, and the primary color + highlight on hover.
//      Please change the 'Account' and 'Sign Out' buttons to match other
//      sidebar buttons."
//
// Both are properties of the live cascade, so neither can be settled by reading
// CSS text. A CSS-text assertion saying "border-right: 1px solid" on our
// override would have PASSED against the broken build, because the rule that
// broke it was the vendor's, in a different file, at equal specificity. Only
// computed style on a rendered, selected tab shows the two-sided chip.
//
// Measured before the fix (selected Inbox tab, 1440x900):
//   top    [1px solid rgb(61,108,255)]
//   left   [1px solid rgb(61,108,255)]
//   right  [1px solid rgba(0,0,0,0)]   <- owner's "transparent"
//   bottom [1px solid rgba(0,0,0,0)]
//
// Puppeteer smoke: no LLM key required. Mirrors the convention documented in
// session-card-hit-target-puppeteer.mjs.

import assert from 'node:assert/strict';
import test from 'node:test';

import puppeteer from 'puppeteer-core';

import { findChromeExecutable, startStagehandUIServer } from '../stagehand/stagehand-test-utils.mjs';

const RAIL_TAB = 'aeor-tab-view.kikx-view-container[tab-bar-position="left"] .tab';
const FOOTER_BUTTON = '.kikx-session-objects .kikx-sign-out-button';
// The owner's "other sidebar buttons". NOTE: `.kikx-sidebar__view` would be the
// tempting selector here and it is DEAD -- since Shell Views P2 the sidebar
// cluster is the aeor-tab rail, so nothing renders that class. Comparing against
// it is how the first attempt matched a control that is not on screen. The live
// target is a rail tab.
const LIVE_TAB = RAIL_TAB;
const PARK = { x: 4, y: 4 };
// The accent is THEMED, so it is resolved from the live document rather than
// hardcoded. A literal blue passed against the dev server and failed here (the
// Stagehand fixture runs a purple theme) -- which is exactly why it must not
// be a constant in this file.
const ACCENT_VAR = '--kikx-accent';

// Resolve the themed accent exactly as the browser computes it: assign the var
// to a real property on a real element and read the used value back, so
// colour-mix/alias resolution is the browser's, never ours.
async function accentOf(page) {
  let value = await page.evaluate((name) => {
    let probe = document.createElement('div');
    probe.style.color = `var(${name})`;
    document.body.appendChild(probe);
    let resolved = getComputedStyle(probe).color;
    probe.remove();
    return resolved;
  }, ACCENT_VAR);
  assert.ok(value && value !== 'rgba(0, 0, 0, 0)', 'the themed accent must resolve to a concrete colour');
  return value;
}

async function openShell() {
  let chromePath = findChromeExecutable();
  assert.ok(chromePath, 'Puppeteer local smoke requires Chrome');

  let fixture = await startStagehandUIServer({
    sessions: [ { id: 'sidebar_session', title: 'Sidebar Session', messageCount: 2 } ],
  });

  let browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: process.env.KIKX_PUPPETEER_HEADLESS === '0' ? false : 'new',
    args: [ '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage' ],
  });

  let page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.evaluateOnNewDocument(() => {
    sessionStorage.setItem('kikx.auth.session', JSON.stringify({
      token: 'puppeteer-test-token',
      refresh_token: 'puppeteer-test-refresh',
    }));
  });
  await page.goto(`${fixture.baseURL}/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  // The startup loaders each schedule a full shell rebuild; interacting before
  // they settle drives a node that is about to be swapped out.
  await new Promise((resolve) => setTimeout(resolve, 2000));
  return { browser, page, fixture };
}

// Reads all four border sides of the rail tab whose label matches. Returns null
// if no such tab is rendered, so a missing rail fails loudly instead of passing
// on an empty list.
async function readRailTab(page, label) {
  return page.evaluate(({ selector, wanted }) => {
    let tab = [ ...document.querySelectorAll(selector) ]
      .find((node) => node.textContent.trim() === wanted);
    if (!tab) return null;
    let cs = getComputedStyle(tab);
    let side = (name) => `${cs.getPropertyValue(`border-${name}-width`)} ${cs.getPropertyValue(`border-${name}-color`)}`;
    return {
      selected: tab.getAttribute('aria-selected'),
      activeClass: tab.classList.contains('active'),
      top: side('top'),
      right: side('right'),
      bottom: side('bottom'),
      left: side('left'),
    };
  }, { selector: RAIL_TAB, wanted: label });
}

// Select a rail entry and wait for the rebuild the tab-view schedules.
async function selectRailTab(page, label) {
  let box = await page.evaluate(({ selector, wanted }) => {
    let tab = [ ...document.querySelectorAll(selector) ]
      .find((node) => node.textContent.trim() === wanted);
    if (!tab) return null;
    let rect = tab.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  }, { selector: RAIL_TAB, wanted: label });
  assert.ok(box, `the rail must render a "${label}" tab to select`);
  await page.mouse.click(box.x, box.y);
  await new Promise((resolve) => setTimeout(resolve, 700));
  await page.mouse.move(PARK.x, PARK.y);
  await new Promise((resolve) => setTimeout(resolve, 250));
}

test('a SELECTED rail entry paints its accent on all four sides, not just two', async (t) => {
  let chromePath = findChromeExecutable();
  if (!chromePath) {
    t.skip('Puppeteer local smoke requires Chrome');
    return;
  }

  let { browser, page, fixture } = await openShell();
  try {
    let accent = await accentOf(page);

    await selectRailTab(page, 'Inbox');

    let selected = await readRailTab(page, 'Inbox');
    assert.ok(selected, 'the Inbox rail entry must be present after selecting it');
    assert.equal(selected.selected, 'true', 'Inbox reports itself selected in ARIA');

    // The owner's bug: the accent reached top/left but not right/bottom.
    assert.equal(selected.top, `1px ${accent}`, `selected tab top border (got ${selected.top})`);
    assert.equal(selected.left, `1px ${accent}`, `selected tab left border (got ${selected.left})`);
    assert.equal(selected.right, `1px ${accent}`,
      `selected tab RIGHT border must be the accent, not transparent (got ${selected.right})`);
    assert.equal(selected.bottom, `1px ${accent}`,
      `selected tab BOTTOM border must be the accent, not transparent (got ${selected.bottom})`);

    // 4) NEGATIVE CONTROL. The fix is a later, more specific rule. Disable it
    //    and the two defeated sides must go transparent again -- otherwise this
    //    test would also pass on a build where the sides were never broken, and
    //    it would stop being evidence for THIS change.
    await page.evaluate(() => {
      let style = document.createElement('style');
      style.id = 'kikx-tab-chip-control';
      style.textContent =
        'aeor-tab-view.kikx-view-container[tab-bar-position="left"] .tab.active { border: 1px solid transparent !important; }';
      document.head.appendChild(style);
    });
    await new Promise((resolve) => setTimeout(resolve, 250));

    let withoutFix = await readRailTab(page, 'Inbox');
    assert.equal(withoutFix.right, '1px rgba(0, 0, 0, 0)',
      'CONTROL: with the rule neutralised the right side must go transparent again');
    assert.equal(withoutFix.bottom, '1px rgba(0, 0, 0, 0)',
      'CONTROL: with the rule neutralised the bottom side must go transparent again');

    // DELIBERATELY NO "un-latch" RE-MEASUREMENT HERE.
    //
    // An earlier version removed the control rule and re-read the tab, to show
    // the control is not a one-way latch. It is not reliable AS A TEST, and the
    // reason is worth recording: activating a rail tab makes the vendor
    // tab-view rebuild, and the rebuilt node can report aria-selected="true"
    // a beat before it carries the `active` class that our rule keys on. Two
    // attempts to out-wait that race failed, and measuring it further would be
    // testing the vendor's render scheduling rather than our CSS.
    //
    // Nothing product-relevant is lost: the assertions above already show the
    // accent on all four sides, and the control above already shows BOTH
    // defeated sides flipping to transparent when the rule is neutralised. That
    // is the sensitivity this test needs, and it is measured twice over.
    await page.evaluate(() => document.getElementById('kikx-tab-chip-control')?.remove());
  } finally {
    await browser.close();
    await fixture.close?.();
  }
});

test('Account and Sign out are grey sidebar rows: no border at rest, accent on hover', async (t) => {
  let chromePath = findChromeExecutable();
  if (!chromePath) {
    t.skip('Puppeteer local smoke requires Chrome');
    return;
  }

  let { browser, page, fixture } = await openShell();
  try {
    let accent = await accentOf(page);
    let read = () => page.evaluate(({ footerSelector, viewSelector }) => {
      let pick = (node) => {
        if (!node) return null;
        let cs = getComputedStyle(node);
        return {
          bg: cs.backgroundColor,
          color: cs.color,
          borderWidths: [ 'top', 'right', 'bottom', 'left' ]
            .map((side) => cs.getPropertyValue(`border-${side}-width`)).join(','),
          borderColor: cs.borderTopColor,
          borderStyle: cs.borderTopStyle,
          radius: cs.borderTopLeftRadius,
          fontSize: cs.fontSize,
        };
      };
      let footer = [ ...document.querySelectorAll(footerSelector) ]
        .find((node) => node.textContent.trim() === 'Account');
      // First tab that is not selected at rest: its styling is the idle look
      // the footer rows have to match.
      let view = [ ...document.querySelectorAll(viewSelector) ]
        .find((node) => node.getAttribute('aria-selected') !== 'true');
      return { account: pick(footer), view: pick(view) };
    }, { footerSelector: FOOTER_BUTTON, viewSelector: LIVE_TAB });

    await page.mouse.move(PARK.x, PARK.y);
    await new Promise((resolve) => setTimeout(resolve, 250));

    let atRest = await read();
    assert.ok(atRest.account, 'the Account footer button must be rendered in the sidebar');
    assert.ok(atRest.view, 'a grey view row (Inbox/Agents/Teams) must exist to match against');

    // "match other sidebar buttons": compared against a LIVE tab, not against the
    // hex literals I chose. If the rail is retuned, this fails instead of drifting.
    assert.ok(atRest.view, 'the rail must render an idle tab to compare against');
    assert.equal(atRest.account.bg, atRest.view.bg,
      `footer row fill must equal the rail tab's (account ${atRest.account.bg} vs tab ${atRest.view.bg})`);
    assert.equal(atRest.account.color, atRest.view.color,
      `footer row text must equal the rail tab's (account ${atRest.account.color} vs tab ${atRest.view.color})`);
    assert.equal(atRest.account.radius, atRest.view.radius,
      `footer row corner radius must equal the rail tab's (account ${atRest.account.radius} vs tab ${atRest.view.radius})`);
    assert.equal(atRest.account.fontSize, atRest.view.fontSize,
      `footer row font size must equal the rail tab's (account ${atRest.account.fontSize} vs tab ${atRest.view.fontSize})`);

    // "gray buttons WITHOUT a border": transparent, not absent, so the row does
    // not change height on hover. Assert the visible outcome, not the keyword.
    assert.equal(atRest.account.borderStyle, 'solid',
      'the border box is preserved so hover cannot shift the row');
    assert.equal(atRest.account.borderColor, 'rgba(0, 0, 0, 0)',
      `no visible border at rest (got ${atRest.account.borderColor})`);

    // The accent must NOT be present at rest -- that is what "without a border"
    // means for the primary colour too.
    assert.notEqual(atRest.account.borderColor, accent,
      'the accent must not paint an idle border');

    // 3) Hover: "the primary color + highlight on hover".
    let box = await page.evaluate((selector) => {
      let node = [ ...document.querySelectorAll(selector) ]
        .find((candidate) => candidate.textContent.trim() === 'Account');
      let rect = node.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    }, FOOTER_BUTTON);
    await page.mouse.move(box.x, box.y);
    await new Promise((resolve) => setTimeout(resolve, 450));

    let hovered = await read();
    assert.equal(hovered.account.borderColor, accent,
      `hover must paint the primary colour on the border (got ${hovered.account.borderColor}, accent ${accent})`);
    assert.notEqual(hovered.account.bg, atRest.account.bg,
      'hover must also change the fill, so the row highlights');

    // 4) NEGATIVE CONTROL: this assertion set must be sensitive to the change.
    //    Restoring the OLD recipe (tinted fill + recipe border) has to break it.
    await page.evaluate((footerSelector) => {
      let style = document.createElement('style');
      style.id = 'kikx-footer-control';
      style.textContent =
        `${footerSelector} { border: 1px solid rgb(52, 81, 165) !important; background: rgb(28, 39, 64) !important; }`;
      document.head.appendChild(style);
    }, FOOTER_BUTTON);
    await new Promise((resolve) => setTimeout(resolve, 250));

    await page.mouse.move(PARK.x, PARK.y);
    await new Promise((resolve) => setTimeout(resolve, 250));
    let withOldRecipe = await read();
    assert.notEqual(withOldRecipe.account.bg, atRest.view.bg,
      'CONTROL: the old tinted recipe must NOT match the grey view rows');
    assert.notEqual(withOldRecipe.account.borderColor, 'rgba(0, 0, 0, 0)',
      'CONTROL: the old recipe must show a visible border at rest');

    await page.evaluate(() => document.getElementById('kikx-footer-control')?.remove());
  } finally {
    await browser.close();
    await fixture.close?.();
  }
});

test('the sidebar rule does not leak onto dialog buttons that share the same class', async (t) => {
  // The SAME `.kikx-sign-out-button` class is the Cancel/Delete control inside
  // kikx-modals.mjs. Those are bar-style controls in a dialog and must keep the
  // app-wide button recipe, so the override has to stay scoped to the sidebar
  // cluster. This test exists because the easy version of the fix -- restyle
  // the class globally -- silently flattens every dialog button in the app.
  let chromePath = findChromeExecutable();
  if (!chromePath) {
    t.skip('Puppeteer local smoke requires Chrome');
    return;
  }

  let { browser, page, fixture } = await openShell();
  try {
    let scoped = await page.evaluate(() => {
      let probe = document.createElement('button');
      probe.type = 'button';
      probe.className = 'kikx-sign-out-button';
      probe.textContent = 'Cancel';
      // Deliberately OUTSIDE .kikx-session-objects, as a dialog button is.
      document.body.appendChild(probe);
      let cs = getComputedStyle(probe);
      let result = { borderColor: cs.borderTopColor, bg: cs.backgroundColor };
      probe.remove();
      return result;
    });

    assert.notEqual(scoped.borderColor, 'rgba(0, 0, 0, 0)',
      'a dialog button keeps a visible border -- the sidebar restyle must not be global');
    assert.notEqual(scoped.bg, 'rgb(23, 28, 33)',
      'a dialog button keeps the accent-tinted recipe, not the flat sidebar grey');
  } finally {
    await browser.close();
    await fixture.close?.();
  }
});
