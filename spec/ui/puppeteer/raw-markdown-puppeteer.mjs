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

import assert from 'node:assert/strict';
import test from 'node:test';

import puppeteer from 'puppeteer-core';

import { findChromeExecutable, startStagehandUIServer } from '../stagehand/stagehand-test-utils.mjs';

const RAW_SOURCE = '**bold** and _italics_ are ~~cool~~ AWESOME!!!\n# Heading';

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

    await new Promise((resolve) => setTimeout(resolve, 250));
    let identities = await page.evaluate(() => {
      window.__itemNode = document.querySelector('kikx-frame-item[data-frame-id="raw_1"]');
      window.__viewNode = document.querySelector('kikx-chat-view');
      window.__anchorBefore = (() => {
        const list = document.querySelector('.kikx-frame-list');
        const lr = list.getBoundingClientRect();
        const items = [ ...document.querySelectorAll('kikx-frame-item[data-frame-id]') ];
        const first = items.find((item) => item.getBoundingClientRect().bottom > lr.top + 1);
        return first ? { id: first.dataset.frameId, top: first.getBoundingClientRect().top } : null;
      })();
      document.querySelector('.kikx-raw-toggle')?.click();
      return true;
    });
    assert.equal(identities, true);
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
        pressed: document.querySelector('.kikx-raw-toggle')?.getAttribute('aria-pressed'),
        anchor: first ? { id: first.dataset.frameId, top: first.getBoundingClientRect().top } : null,
        anchorBefore: window.__anchorBefore,
      };
    });

    assert.equal(raw.rawClass, true);
    assert.equal(raw.pressed, 'true');
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
    await page.evaluate(() => document.querySelector('.kikx-raw-toggle')?.click());
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
        pressed: document.querySelector('.kikx-raw-toggle')?.getAttribute('aria-pressed'),
        anchor: first ? { id: first.dataset.frameId, top: first.getBoundingClientRect().top } : null,
      };
    });
    assert.equal(afterOff.strong, 'bold', 'rendered mode is back');
    assert.equal(afterOff.markers, false, 'delimiters are consumed again');
    assert.equal(afterOff.pressed, 'false');
    assert.equal(afterOff.anchor.id, raw.anchor.id, 'the anchor frame survives the round trip');
    assert.ok(Math.abs(afterOff.anchor.top - raw.anchor.top) <= 2,
      `and keeps its offset (raw=${raw.anchor.top}, off=${afterOff.anchor.top})`);
  } finally {
    await browser?.close();
    await fixture.close();
  }
});
