'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';
import puppeteer from 'puppeteer-core';
import { findChromeExecutable, startStagehandUIServer } from '../stagehand/stagehand-test-utils.mjs';

function frame(id, order, type, content, authorType = 'agent') {
  let timestamp = 1793328600000000 + order * 1000000;
  return {
    id,
    type,
    sessionID: 'session_typing_load',
    interactionID: `interaction_${order}`,
    parentID: null,
    authorType,
    authorID: authorType === 'agent' ? 'agent_1' : 'owner',
    authorDisplayName: authorType === 'agent' ? 'Bot' : 'Wyatt',
    hidden: false,
    deleted: false,
    order,
    timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
    content,
  };
}

test('Puppeteer typing stays targeted while a busy agent streams runtime events', async (t) => {
  let chromePath = findChromeExecutable();
  if (!chromePath) { t.skip('Puppeteer typing-under-load coverage requires Chrome'); return; }

  let frames = [];
  for (let order = 1; order <= 300; order++)
    frames.push(frame(`f${order}`, order, 'UserMessage', { text: `Message ${order}` }, 'user'));
  frames.push(frame('progress', 301, 'AgentProgress', { text: 'working', status: 'streaming' }));

  let fixture = await startStagehandUIServer({
    sessions: [ { id: 'session_typing_load', title: 'Typing under load', messageCount: frames.length } ],
  });
  fixture.frameRuntime.framesBySessionID.set('session_typing_load', frames);

  let browser = await puppeteer.launch({ executablePath: chromePath, headless: 'new', args: [ '--no-sandbox', '--disable-setuid-sandbox' ] });
  try {
    let page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.evaluateOnNewDocument(() => sessionStorage.setItem('kikx.auth.session', JSON.stringify({ token: 'typing-token', refresh_token: 'typing-refresh' })));
    await page.goto(`${fixture.baseURL}/?session=session_typing_load`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForFunction(() => document.querySelector('kikx-app')?._startupSettled === true, { timeout: 15000 });

    // Startup loaders and lazy page placement keep rebuilding for a little
    // while after the first paint. Measure a QUIET shell, not that warm-up.
    let lastStats = null;
    let stable = 0;
    for (let attempt = 0; attempt < 100 && stable < 10; attempt++) {
      let stats = await page.evaluate(() => JSON.stringify(document.querySelector('kikx-app')._renderStats));
      if (stats === lastStats)
        stable += 1;
      else {
        stable = 0;
        lastStats = stats;
      }
      if (stable < 10)
        await new Promise((resolve) => setTimeout(resolve, 80));
    }
    assert.ok(stable >= 10, 'the shell counters never settled');

    let before = await page.evaluate(() => ({ ...document.querySelector('kikx-app')._renderStats }));
    await page.evaluate(() => {
      window.__typingMutations = { breadcrumb: 0, statusLabel: 0, total: 0 };
      let observer = new MutationObserver((records) => {
        for (let record of records) {
          window.__typingMutations.total += 1;
          let target = record.target;
          if (target?.matches?.('.kikx-breadcrumb__crumb, .kikx-breadcrumb__title, .kikx-window__header h2'))
            window.__typingMutations.breadcrumb += 1;
          if (target?.closest?.('.kikx-frame__meta-status'))
            window.__typingMutations.statusLabel += 1;
        }
      });
      observer.observe(document.querySelector('kikx-app'), { subtree: true, childList: true, characterData: true });
      window.__typingObserver = observer;
    });

    await page.click('textarea[name="message"]');
    let composerHandle = await page.evaluateHandle(() => document.querySelector('textarea[name="message"]'));
    const typed = 'typing while busy 0123456789';

    let typing = page.keyboard.type(typed, { delay: 12 });
    let events = (async () => {
      for (let index = 0; index < 60; index++) {
        fixture.frameRuntime.emitEvent('frame.updated', {
          sessionID: 'session_typing_load',
          frame: frame('progress', 301, 'AgentProgress', { text: `working ${index}`, status: 'streaming' }),
        });
        fixture.frameRuntime.emitEvent('session.saved', {
          session: { id: 'session_typing_load', title: 'Typing under load', updatedAt: index },
        });
        await new Promise((resolve) => setTimeout(resolve, 18));
      }
    })();

    await Promise.all([ typing, events ]);
    await new Promise((resolve) => setTimeout(resolve, 700));

    let after = await page.evaluate(() => ({
      stats: { ...document.querySelector('kikx-app')._renderStats },
      value: document.querySelector('textarea[name="message"]').value,
      caret: document.querySelector('textarea[name="message"]').selectionStart,
      mutations: window.__typingMutations,
    }));
    let sameComposer = await page.evaluate((handle) => document.querySelector('textarea[name="message"]') === handle, composerHandle);

    for (let kind of [ 'shell', 'thread', 'grid', 'chatView', 'frameItem' ])
      assert.equal(after.stats[kind] - before[kind], 0, `${kind} must not rebuild while typing under load`);

    assert.equal(sameComposer, true, 'the composer node must not be replaced');
    assert.equal(after.value, typed, 'typed text must survive the event burst');
    assert.equal(after.caret, typed.length, 'the caret must stay at the end of the typed text');
    assert.equal(after.mutations.breadcrumb, 0, 'an unchanged session title must not rewrite the breadcrumb');
    assert.equal(after.mutations.statusLabel, 0, 'an unchanged header status label must not be rewritten');
    assert.ok(after.mutations.total <= 40, `only the progressing message content should mutate (saw ${after.mutations.total})`);
  } finally {
    await browser?.close();
    await fixture.close();
  }
});
