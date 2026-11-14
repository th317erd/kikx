'use strict';

// Raw Markdown mode (owner correction, 2026-11-05): "When I go into RAW mode,
// I can not select or copy the markdown styling characters... which is
// specifically what RAW mode is for."
//
// The old implementation painted the delimiters with ::before/::after —
// generated content, which selection and copy ignore. The contract now:
//
//   1. raw mode renders the message SOURCE as real text (every `**`, `_`,
//      backtick and newline selectable and copyable — proven with a real
//      Selection round-trip);
//   2. toggling stays IN PLACE: no shell rebuild (render-stats), the frame
//      item and chat-view nodes stay mounted, and the visible frame keeps its
//      viewport offset across the height change (anchor restore);
//   3. streaming updates arriving while raw is ON keep rendering as source;
//   4. toggling OFF restores the rendered tree with the delimiters consumed.
//
// Where the toggle LIVES moved (owner change, 2026-11-14): "I want the RAW and
// DEBUG items to be under the Filter popup menu with the Eye icon ... put these
// two items down at the bottom with Hidden." The top bar's `.kikx-raw-toggle`
// chip is gone, so this spec drives the control a person actually uses: open the
// eyeball panel, then click the Raw row beneath the Hidden gate. The contract
// above is unchanged, which is the point — the owner asked for a relocation, not
// new behaviour, so the same four properties are asserted through the new route.

import assert from 'node:assert/strict';
import test from 'node:test';

import puppeteer from 'puppeteer-core';

import { findChromeExecutable, startStagehandUIServer } from '../stagehand/stagehand-test-utils.mjs';

const RAW_SOURCE = '**bold** and _italics_ are ~~cool~~ AWESOME!!!\n# Heading';

// The bar's copy of the eye is the one with a real popover panel; the overflow
// menu renders its own inline copy for compact widths, so an unscoped
// querySelector could find the wrong one. Direct-child scoping matches the
// markup (and kikx-topbar.mjs), with a fallback for older shells.
const EYE = '.kikx-topbar__search-group > kikx-frame-filter-popup';
const EYE_ANY = 'kikx-frame-filter-popup';

function frame(id, order, text, type = 'UserMessage') {
  let timestamp = 1793328600000000 + order * 1000000;
  return {
    id,
    type,
    sessionID: 'session_raw',
    interactionID: `interaction_${order}`,
    authorType: type === 'UserMessage' ? 'user' : 'agent',
    authorID: type === 'UserMessage' ? 'owner' : 'agent',
    authorDisplayName: type === 'UserMessage' ? 'Wyatt' : 'Agent',
    hidden: false,
    deleted: false,
    order,
    timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
    content: { text },
  };
}

// Clicking a view row is a two-step gesture for a user (open the eye, then click
// the row), so the spec performs both rather than reaching past the UI into
// app._toggleRawMarkdown. Opening is conditional so the helper stays correct in
// the OFF→ON→OFF round trip: the panel survives the raw toggle, but a debug
// toggle re-renders the app, so re-checking is cheaper than assuming.
async function clickViewRow(page, key) {
  await page.evaluate((viewKey) => {
    let popup = document.querySelector('.kikx-topbar__search-group > kikx-frame-filter-popup')
      || document.querySelector('kikx-frame-filter-popup');
    let panel = popup && popup.querySelector('.kikx-frame-filter__panel');
    if (!panel || panel.hidden)
      popup?.querySelector('.kikx-frame-filter__button')?.click();

    popup?.querySelector(`.kikx-frame-filter__view [data-view-key="${viewKey}"]`)?.click();
  }, key);
}

async function viewRowState(page, key) {
  return page.evaluate((viewKey) => {
    let popup = document.querySelector('.kikx-topbar__search-group > kikx-frame-filter-popup')
      || document.querySelector('kikx-frame-filter-popup');
    let row = popup?.querySelector(`.kikx-frame-filter__view [data-view-key="${viewKey}"]`);
    return row ? { found: true, checked: row.querySelector('input')?.checked === true } : { found: false };
  }, key);
}

test('Puppeteer Raw mode shows selectable markdown source in place', async (t) => {
  let chromePath = findChromeExecutable();
  if (!chromePath) {
    t.skip('Puppeteer Raw Markdown coverage requires Chrome');
    return;
  }

  let fixture = await startStagehandUIServer({
    sessions: [ { id: 'session_raw', title: 'Raw Markdown', messageCount: 40 } ],
  });
  let frames = [
    frame('raw_1', 1, RAW_SOURCE),
    frame('agent_1', 2, 'Agent **source** and _prose_', 'AgentMessage'),
  ];
  for (let index = 3; index <= 40; index++)
    frames.push(frame(`filler_${index}`, index, `Filler **row** ${index}.`));
  fixture.frameRuntime.framesBySessionID.set('session_raw', frames);

  let browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: 'new',
    args: [ '--no-sandbox', '--disable-setuid-sandbox' ],
  });
  try {
    let page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.evaluateOnNewDocument(() => {
      sessionStorage.setItem('kikx.auth.session', JSON.stringify({ token: 'raw-test-token', refresh_token: 'raw-test-refresh' }));
    });
    await page.goto(`${fixture.baseURL}/?session=session_raw`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForSelector('kikx-frame-item[data-frame-id="raw_1"] .kikx-markdown', { timeout: 15000 });
    await page.waitForSelector('kikx-frame-item[data-frame-id="agent_1"] .kikx-markdown', { timeout: 15000 });

    // The toggle must be reachable at all: a control nobody can find is not a
    // relocation. This fails loudly if the eye is missing from the bar.
    await page.waitForSelector(`${EYE} .kikx-frame-filter__button`, { timeout: 15000 });

    // Rendered baseline + reference anchor.
    let baseline = await page.evaluate(() => {
      let content = document.querySelector('kikx-frame-item[data-frame-id="raw_1"] .kikx-markdown');
      let list = document.querySelector('.kikx-frame-list');
      list.scrollTop = 180;
      let lr = list.getBoundingClientRect();
      const anchorRef = () => {
        const items = [ ...document.querySelectorAll('kikx-frame-item[data-frame-id]') ];
        const first = items.find((item) => item.getBoundingClientRect().bottom > lr.top + 1);
        return first ? { id: first.dataset.frameId, top: first.getBoundingClientRect().top } : null;
      };
      return {
        strong: content.querySelector('strong')?.textContent || '',
        em: content.querySelector('em')?.textContent || '',
        del: content.querySelector('del')?.textContent || '',
        renderedHasMarkers: content.textContent.includes('**'),
        shellRenders: document.querySelector('kikx-app')._renderStats.shell,
        itemNode: true,
        anchor: anchorRef(),
      };
    });
    assert.deepEqual({ strong: baseline.strong, em: baseline.em, del: baseline.del }, {
      strong: 'bold',
      em: 'italics',
      del: 'cool',
    });
    assert.equal(baseline.renderedHasMarkers, false, 'rendered mode consumes the delimiters');

    let beforeToggle = await viewRowState(page, 'raw');
    assert.equal(beforeToggle.found, true, 'the Raw view row exists in the eye popup');
    assert.equal(beforeToggle.checked, false, 'Raw starts off');

    await new Promise((resolve) => setTimeout(resolve, 250));
    await page.evaluate(() => {
      window.__itemNode = document.querySelector('kikx-frame-item[data-frame-id="raw_1"]');
      window.__viewNode = document.querySelector('kikx-chat-view');
      window.__anchorBefore = (() => {
        const list = document.querySelector('.kikx-frame-list');
        const lr = list.getBoundingClientRect();
        const items = [ ...document.querySelectorAll('kikx-frame-item[data-frame-id]') ];
        const first = items.find((item) => item.getBoundingClientRect().bottom > lr.top + 1);
        return first ? { id: first.dataset.frameId, top: first.getBoundingClientRect().top } : null;
      })();
    });
    await clickViewRow(page, 'raw');
    await page.waitForFunction(() => document.querySelector('kikx-app')?.classList.contains('kikx-raw-mode') === true, { timeout: 15000 });
    await new Promise((resolve) => setTimeout(resolve, 200));

    let raw = await page.evaluate(() => {
      let app = document.querySelector('kikx-app');
      let content = document.querySelector('kikx-frame-item[data-frame-id="raw_1"] .kikx-markdown');
      let list = document.querySelector('.kikx-frame-list');
      const lr = list.getBoundingClientRect();
      const items = [ ...document.querySelectorAll('kikx-frame-item[data-frame-id]') ];
      const first = items.find((item) => item.getBoundingClientRect().bottom > lr.top + 1);
      // Real Selection round-trip over the content: this is the whole point of
      // the mode — generated ::before content cannot be selected or copied.
      let copied = '';
      if (content.firstChild) {
        let range = document.createRange();
        range.selectNodeContents(content);
        let selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        copied = selection.toString();
        selection.removeAllRanges();
      }
      return {
        rawClass: app.classList.contains('kikx-raw-mode'),
        shellRenders: app._renderStats.shell,
        sameItem: window.__itemNode === document.querySelector('kikx-frame-item[data-frame-id="raw_1"]'),
        sameView: window.__viewNode === document.querySelector('kikx-chat-view'),
        text: content.textContent,
        sourceClass: content.className.includes('kikx-markdown--source'),
        hasRenderedTree: Boolean(content.querySelector('strong, em, del, h1')),
        copied,
        anchor: first ? { id: first.dataset.frameId, top: first.getBoundingClientRect().top } : null,
        anchorBefore: window.__anchorBefore,
      };
    });

    let rawRow = await viewRowState(page, 'raw');
    assert.equal(rawRow.checked, true, 'the Raw row reports itself ON after the click');

    assert.equal(raw.rawClass, true);
    assert.equal(raw.text, RAW_SOURCE, 'every source character is REAL, exact text');
    assert.equal(raw.sourceClass, true, 'the source wrapper class is applied');
    assert.equal(raw.hasRenderedTree, false, 'raw mode renders the source, not the parsed tree');
    assert.ok(raw.copied.includes('**bold**'), `selection must capture the markdown markers, got "${raw.copied.slice(0, 80)}"`);
    assert.ok(raw.copied.includes('_italics_') && raw.copied.includes('# Heading'), 'the whole selection copies as markdown source');
    assert.equal(raw.shellRenders, baseline.shellRenders, 'the toggle must not rebuild the shell');
    assert.equal(raw.sameItem, true, 'the frame item stays mounted');
    assert.equal(raw.sameView, true, 'the chat view stays mounted');
    assert.equal(raw.anchor.id, raw.anchorBefore.id, 'the same frame stays under the viewport top');
    assert.ok(Math.abs(raw.anchor.top - raw.anchorBefore.top) <= 2,
      `the visible frame keeps its offset (before=${raw.anchorBefore.top}, after=${raw.anchor.top})`);

    // Streaming updates follow the renderer flag while raw is ON.
    fixture.frameRuntime.emitEvent('frame.updated', {
      sessionID: 'session_raw',
      frame: frame('agent_1', 2, 'Live **update** with _source_', 'AgentMessage'),
    });
    await page.waitForFunction(() => {
      let content = document.querySelector('kikx-frame-item[data-frame-id="agent_1"] .kikx-markdown');
      return content && content.textContent.includes('Live **update** with _source_');
    }, { timeout: 10000 });
    let live = await page.evaluate(() => {
      let content = document.querySelector('kikx-frame-item[data-frame-id="agent_1"] .kikx-markdown');
      return { text: content.textContent, rendered: Boolean(content.querySelector('strong')) };
    });
    assert.equal(live.text, 'Live **update** with _source_', 'a live update renders as source while raw is on');
    assert.equal(live.rendered, false);

    // Toggle OFF: rendered tree returns, delimiters consumed.
    await clickViewRow(page, 'raw');
    await page.waitForFunction(() => document.querySelector('kikx-app')?.classList.contains('kikx-raw-mode') === false, { timeout: 15000 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    let afterOff = await page.evaluate(() => {
      let content = document.querySelector('kikx-frame-item[data-frame-id="raw_1"] .kikx-markdown');
      let list = document.querySelector('.kikx-frame-list');
      const lr = list.getBoundingClientRect();
      const items = [ ...document.querySelectorAll('kikx-frame-item[data-frame-id]') ];
      const first = items.find((item) => item.getBoundingClientRect().bottom > lr.top + 1);
      return {
        strong: content.querySelector('strong')?.textContent || '',
        markers: content.textContent.includes('**'),
        anchor: first ? { id: first.dataset.frameId, top: first.getBoundingClientRect().top } : null,
      };
    });
    let offRow = await viewRowState(page, 'raw');
    assert.equal(afterOff.strong, 'bold', 'rendered mode is back');
    assert.equal(afterOff.markers, false, 'delimiters are consumed again');
    assert.equal(offRow.checked, false, 'the Raw row reports itself OFF again');
    assert.equal(afterOff.anchor.id, raw.anchor.id, 'the anchor frame survives the round trip');
    assert.ok(Math.abs(afterOff.anchor.top - raw.anchor.top) <= 2,
      `and keeps its offset (raw=${raw.anchor.top}, off=${afterOff.anchor.top})`);
  } finally {
    await browser?.close();
    await fixture.close();
  }
});
