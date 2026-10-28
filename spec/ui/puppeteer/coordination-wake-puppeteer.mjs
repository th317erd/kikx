'use strict';

// The definition-of-done proof, in a real browser, over the real thread.
//
// The owner's report was not "the component is wrong" — it was "the bot
// appeared and I could not see who told it what". So the assertions here run
// against what a person actually gets on a fresh load:
//
//   real server (startStagehandUIServer) seeded with three frames
//     - an owner message
//     - a hidden coordination wake (the invite instruction)
//     - a hidden bookkeeping frame that must stay invisible
//   real client bundle, real thread rendering, real CSS cascade
//
// and it checks the card is IN THE THREAD, positioned where the wake happened,
// visually distinct from the owner's message, and expandable by a real click.
//
// This is the lane that catches what the mini-dom cannot: it found that the
// custom element defaulted to `display: inline` (so the card shrink-wrapped to
// a narrow column) and that `.kikx-frame`'s `width: fit-content` boxed it in.
// Neither is expressible in the unit lane — it has no layout and no cascade.

import assert from 'node:assert/strict';
import test from 'node:test';

import puppeteer from 'puppeteer-core';

import { findChromeExecutable, startStagehandUIServer } from '../stagehand/stagehand-test-utils.mjs';

const INVITE_TEXT = 'You have been invited to "Bot message visibility" by Zav. '
  + 'Kikx-Node-Eng, review the session context now and wait for the coordinator\'s '
  + 'assignment before changing files.';

function frame(id, type, order, overrides = {}) {
  return {
    id,
    type,
    sessionID: 'session_1',
    interactionID: `int_${id}`,
    order,
    timestamp: 1781035260000000 + order,
    createdAt: 1781035260000000 + order,
    updatedAt: 1781035260000000 + order,
    hidden: false,
    deleted: false,
    ...overrides,
  };
}

test('Puppeteer shows the coordination wake in the thread as a distinct, expandable handoff', async (t) => {
  let chromePath = findChromeExecutable();
  if (!chromePath) {
    t.skip('Puppeteer wake coverage requires Chrome');
    return;
  }

  let fixture = await startStagehandUIServer({
    sessions: [ { id: 'session_1', title: 'Bot message visibility', messageCount: 3 } ],
  });

  fixture.frameRuntime.framesBySessionID.set('session_1', [
    frame('owner_msg', 'UserMessage', 1, {
      authorType: 'user',
      authorID: 'user_owner',
      content: { text: 'Where did this bot come from?' },
    }),
    frame('invite_wake', 'UserMessage', 2, {
      // Exactly the shape wakeAgentInSession persists.
      authorType: 'system',
      authorID: 'internal:session-invite',
      authorDisplayName: 'Kikx session invite',
      targetAgentID: 'agent_worker',
      hidden: true,
      scheduledAt: 1781035260000002,
      scheduledStatus: 'fired',
      content: {
        text: INVITE_TEXT,
        status: 'scheduled',
        agentID: 'agent_worker',
        agentName: 'Kikx-Node-Eng',
        invite: true,
      },
    }),
    frame('recovery_wake', 'UserMessage', 3, {
      authorType: 'system',
      authorID: 'internal:runtime-recovery',
      targetAgentID: 'agent_worker',
      hidden: true,
      content: { text: 'Resume the interrupted turn.' },
    }),
  ]);

  let browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: process.env.KIKX_PUPPETEER_HEADLESS === '0' ? false : 'new',
    args: [ '--no-sandbox', '--disable-setuid-sandbox' ],
  });

  try {
    let page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.evaluateOnNewDocument(() => {
      sessionStorage.setItem('kikx.auth.session', JSON.stringify({
        token: 'puppeteer-test-token',
        refresh_token: 'puppeteer-test-refresh',
      }));
    });

    await page.goto(`${fixture.baseURL}/?view=thread`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForSelector('kikx-frame-item[data-frame-id="invite_wake"]', { timeout: 15000 });
    await new Promise((resolve) => setTimeout(resolve, 400));

    // 1. The wake is in the thread at all — this is the owner's whole complaint.
    let ids = await page.evaluate(() =>
      [ ...document.querySelectorAll('.kikx-frame-list kikx-frame-item[data-frame-id]') ]
        .map((item) => item.dataset.frameId));
    assert.ok(ids.includes('invite_wake'), `the invite wake must render in the thread; got ${ids.join(', ')}`);
    assert.ok(ids.includes('owner_msg'), 'the owner message still renders');

    // 2. Hidden bookkeeping did not come along for the ride.
    assert.equal(ids.includes('recovery_wake'), false, 'a hidden non-wake frame must stay out of the thread');

    // 3. Order is preserved: the wake sits between the owner message and the end,
    //    i.e. where it happened, not appended somewhere else.
    assert.ok(
      ids.indexOf('invite_wake') > ids.indexOf('owner_msg'),
      `the wake must appear after the earlier message; got ${ids.join(', ')}`,
    );

    let measured = await page.evaluate(() => {
      let item = document.querySelector('kikx-frame-item[data-frame-id="invite_wake"]');
      let card = item.querySelector('kikx-coordination-frame');
      let ownerItem = document.querySelector('kikx-frame-item[data-frame-id="owner_msg"]');
      let inner = card.querySelector('.kikx-coordination');
      let cardStyle = getComputedStyle(inner);
      let ownerStyle = getComputedStyle(ownerItem.querySelector('.kikx-frame__content') || ownerItem);
      let list = document.querySelector('.kikx-frame-list');
      return {
        hasCard: Boolean(card),
        ownerHasCard: Boolean(ownerItem.querySelector('kikx-coordination-frame')),
        headline: card.querySelector('.kikx-coordination__headline')?.textContent,
        meta: card.querySelector('.kikx-coordination__meta')?.textContent,
        eyebrow: card.querySelector('.kikx-coordination__eyebrow')?.textContent,
        summary: card.querySelector('.kikx-coordination__summary')?.textContent,
        borderStyle: cardStyle.borderTopStyle,
        borderLeftWidth: cardStyle.borderLeftWidth,
        cardWidth: inner.getBoundingClientRect().width,
        listWidth: list.getBoundingClientRect().width,
        detailsOpen: card.querySelector('details')?.open,
        ownerIsCard: ownerItem.querySelectorAll('kikx-coordination-frame').length > 0,
        instructionText: card.querySelector('.kikx-coordination__instruction')?.textContent,
        instructionHeight: card.querySelector('.kikx-coordination__instruction')?.getBoundingClientRect().height,
        ownerBorderStyle: ownerStyle.borderTopStyle,
      };
    });

    // 4. It is rendered by the new component, and the owner's own message was not
    //    hijacked into it.
    assert.equal(measured.hasCard, true, 'the wake must render through kikx-coordination-frame');
    assert.equal(measured.ownerIsCard, false, 'an owner message must still render as a user message');

    // 5. It says who woke whom, and names itself as system coordination.
    assert.equal(measured.headline, 'Kikx session invite woke Kikx-Node-Eng');
    assert.equal(measured.meta, 'from Zav · session “Bot message visibility”');
    assert.equal(measured.eyebrow, 'System handoff');

    // 6. Visually distinct from owner chat: dashed system banner vs the solid
    //    bubble the owner's message gets.
    assert.equal(measured.borderStyle, 'dashed', `wake border-top-style=${measured.borderStyle}`);
    assert.notEqual(measured.ownerBorderStyle, 'dashed', 'the owner message must not look like a system handoff');

    // 7. It spans the thread rather than shrink-wrapping to a column.
    assert.ok(
      measured.cardWidth > measured.listWidth * 0.7,
      `the card must span the thread (card=${measured.cardWidth}, list=${measured.listWidth})`,
    );

    // 8. Density: collapsed by default, so the instruction is not pasted inline.
    assert.equal(measured.detailsOpen, false, 'the instruction must be collapsed by default');
    assert.equal(measured.summary, 'Show instruction');

    // 9. A real click expands it and the stored instruction becomes readable.
    await page.click('kikx-frame-item[data-frame-id="invite_wake"] .kikx-coordination__summary');
    await new Promise((resolve) => setTimeout(resolve, 200));

    let expanded = await page.evaluate(() => {
      let card = document.querySelector('kikx-frame-item[data-frame-id="invite_wake"] kikx-coordination-frame');
      let instruction = card.querySelector('.kikx-coordination__instruction');
      return {
        open: card.querySelector('details').open,
        label: card.querySelector('.kikx-coordination__summary').textContent,
        height: instruction.getBoundingClientRect().height,
        text: instruction.textContent,
      };
    });

    assert.equal(expanded.open, true, 'clicking the summary must expand the instruction');
    assert.equal(expanded.label, 'Hide instruction', 'the summary label must reflect the open state');
    assert.ok(expanded.height > 0, 'the expanded instruction must take up space');
    assert.match(expanded.text, /review the session context now/, 'the stored instruction text must be shown');
    // The greeting the header already carries is not repeated in the body.
    assert.doesNotMatch(expanded.text, /You have been invited/);
  } finally {
    await browser.close().catch(() => {});
    await fixture.close().catch(() => {});
  }
});
