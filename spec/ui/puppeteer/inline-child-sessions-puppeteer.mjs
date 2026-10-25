'use strict';

// Real-browser coverage for the inline child-session row.
//
// The defect this guards against cannot be seen by DOM-shape unit tests: a
// session with children used to be *replaced* by a child grid, and the grid
// carried no control that restored the thread. The unit specs would have been
// green whether the thread was reachable or not, because they asserted the
// presence of individual controls rather than the co-presence of the thread
// and its children.
//
// So every assertion below is about what a person sees on one screen at one
// time:
//
//   * the thread body is painted AND the child rows are painted, together, in
//     the same session window;
//   * pressing the old entry point (`?collapsed=1`, the URL a trapped tab had
//     bookmarked) still lands in the thread, not in a replacement grid;
//   * the only create control is a real button in the header, and the grid's
//     Add card is present even on a session whose children are all closed.

import assert from 'node:assert/strict';
import test from 'node:test';

import puppeteer from 'puppeteer-core';

import { findChromeExecutable, startStagehandUIServer } from '../stagehand/stagehand-test-utils.mjs';

const PARENT_ID = 'session_parent';
const CHILD_A_ID = 'session_child_a';
const CHILD_B_ID = 'session_child_b';

test('Puppeteer shows the thread and its child sessions in one view, with no replacement grid', async (t) => {
  let chromePath = findChromeExecutable();
  if (!chromePath) {
    t.skip('Puppeteer inline child-session coverage requires Chrome');
    return;
  }

  let fixture = await startStagehandUIServer({
    sessions: [
      { id: PARENT_ID, title: 'Parent Session', messageCount: 3 },
      { id: CHILD_A_ID, title: 'Child Alpha', parentSessionID: PARENT_ID, messageCount: 1 },
      { id: CHILD_B_ID, title: 'Child Beta', parentSessionID: PARENT_ID, messageCount: 1 },
    ],
  });

  // The parent needs frames of its own, otherwise the thread body renders its
  // empty-state copy and "the thread is visible" would be asserted against a
  // placeholder rather than against a real conversation.
  fixture.frameRuntime.framesBySessionID.set(PARENT_ID, [
    frame('f_parent_user', 'UserMessage', 1, PARENT_ID, 'hello from the parent'),
    frame('f_parent_agent', 'AgentMessage', 2, PARENT_ID, 'reply from the parent'),
    frame('f_parent_user_2', 'UserMessage', 3, PARENT_ID, 'second parent message'),
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
      sessionStorage.setItem('kikx.auth.session', JSON.stringify({ token: 'inline-test-token', refresh_token: 'inline-test-refresh' }));
    });

    // The URL a trapped tab carried. `collapsed=1` must be parsed and ignored.
    await page.goto(`${fixture.baseURL}/?session=${PARENT_ID}&collapsed=1`, {
      waitUntil: 'domcontentloaded',
      timeout: 15000,
    });
    await page.waitForSelector('.kikx-thread', { timeout: 15000 });
    await waitForRenderSettled(page);

    // 1) The thread body is really there, with real frames in it.
    let thread = await page.evaluate(() => {
      let body = document.querySelector('.kikx-thread__body');
      return {
        hasBody: Boolean(body),
        frameCount: document.querySelectorAll('.kikx-thread__body .kikx-frame').length,
        text: document.querySelector('.kikx-thread')?.textContent || '',
      };
    });
    assert.equal(thread.hasBody, true, 'the session window renders a thread body');
    assert.ok(thread.frameCount > 0, `the thread body renders the parent's frames (saw ${thread.frameCount})`);
    assert.ok(
      thread.text.includes('hello from the parent'),
      'the parent conversation itself is on screen, not a replacement grid',
    );

    // 2) The children are there at the same time, in the same window.
    let kids = await page.evaluate((parentID) => {
      let region = document.querySelector('.kikx-thread__children');
      if (!region)
        return { present: false };

      let cards = Array.from(region.querySelectorAll('kikx-session-card'))
        .filter((card) => !card.classList.contains('kikx-session-card--add'));
      let add = region.querySelector('.kikx-session-card--add');
      let threadBody = document.querySelector('.kikx-thread__body');
      let header = document.querySelector('.kikx-window__header');

      // Document order is the structural claim: header, then children, then
      // thread. `compareDocumentPosition` is the only honest way to ask
      // "is this row between them" without depending on a sibling index.
      let follows = (a, b) => Boolean(a && b && (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING));
      // Measure LAYOUT, not just the host's display value. The card is a custom
      // element whose visual box is an inner div the component renders itself, so
      // a host-only check passes even when the inner div is block-level and each
      // card silently occupies a whole line. That is precisely how the stacking
      // defect survived a green test once already. Two cards sharing a row means
      // their tops agree AND their left edges differ.
      let boxes = cards.map((card) => {
        let r = card.getBoundingClientRect();
        let inner = card.querySelector('.kikx-session-card');
        let ir = inner?.getBoundingClientRect();
        return {
          top: Math.round(r.top),
          left: Math.round(r.left),
          width: Math.round(r.width),
          hostDisplay: getComputedStyle(card).display,
          innerDisplay: inner ? getComputedStyle(inner).display : null,
          innerWidth: ir ? Math.round(ir.width) : null,
          innerMatchesHostWidth: ir ? Math.abs(ir.width - r.width) <= 2 : null,
        };
      });

      return {
        present: true,
        childIDs: cards.map((card) => card.sessionID).filter(Boolean),
        titles: cards.map((card) => card.textContent.trim().slice(0, 40)),
        hasAdd: Boolean(add),
        addText: add?.textContent?.trim() || '',
        afterHeader: follows(header, region),
        beforeThread: follows(region, threadBody),
        boxes,
        parentID,
      };
    }, PARENT_ID);

    assert.equal(kids.present, true, 'the session window mounts a kikx-thread__children row');
    assert.deepEqual(
      kids.childIDs.slice().sort(),
      [ CHILD_A_ID, CHILD_B_ID ].sort(),
      'the row is narrowed to this session\'s children, not every session',
    );
    assert.equal(kids.afterHeader, true, 'the child row sits below the window header');
    assert.equal(kids.beforeThread, true, 'the child row sits above the thread body');
    assert.equal(kids.hasAdd, true, 'the inline row keeps an Add card, so creation never disappears');
    assert.match(kids.addText, /Add\s+\S+/, 'the Add card carries a create label');

    // 3) Cards flow rather than stack. This is measured, not inferred: the two
    //    child cards must sit at the same top offset with different left edges,
    //    i.e. beside each other on one row. Before this was measured, a host-only
    //    `display` check passed while the real cards were stacking.
    assert.equal(kids.boxes.length, 2, 'both child cards are measurably laid out');
    for (let box of kids.boxes) {
      assert.match(
        box.hostDisplay,
        /^inline/,
        `the card host is an inline-level box (saw ${box.hostDisplay})`,
      );
      assert.ok(
        box.width > 0 && box.width < 400,
        `the card host is a fixed-width grid item, not a full-width row (saw ${box.width}px)`,
      );
      assert.equal(
        box.innerMatchesHostWidth,
        true,
        `the inner card fills its host, so the visual card is the measured box (host ${box.width}px vs inner ${box.innerWidth}px)`,
      );
    }
    assert.equal(
      kids.boxes[0].top,
      kids.boxes[1].top,
      `the child cards share a row -- equal tops (saw ${kids.boxes.map((b) => b.top).join(' vs ')})`,
    );
    assert.notEqual(
      kids.boxes[0].left,
      kids.boxes[1].left,
      `the child cards sit beside each other, not stacked (saw left ${kids.boxes.map((b) => b.left).join(' vs ')})`,
    );

    // 4) There is no second view to be trapped in: no toggle, no popup footer.
    let absent = await page.evaluate(() => ({
      viewToggle: document.querySelectorAll('.kikx-window__view-toggle').length,
      childSessionsAction: document.querySelectorAll('[data-filter-action="child-sessions-grid"]').length,
      // The replacement grid had its own heading. If a child grid replaced the
      // thread there would be two `.kikx-thread` regions (or none).
      threadRegions: document.querySelectorAll('.kikx-thread').length,
    }));
    assert.equal(absent.viewToggle, 0, 'there is no view-toggle control to escape from');
    assert.equal(absent.childSessionsAction, 0, 'the popup footer child-sessions action is gone');
    assert.equal(absent.threadRegions, 1, 'exactly one session view renders');

    // 5) The create control in the header is a real, clickable button placed
    //    after the eyeball, at this level.
    let header = await page.evaluate(() => {
      let add = document.querySelector('.kikx-window__add');
      let eye = document.querySelector('.kikx-frame-filter__button');
      if (!add || !eye)
        return { add: Boolean(add), eye: Boolean(eye) };

      let order = eye.compareDocumentPosition(add) & Node.DOCUMENT_POSITION_FOLLOWING;
      return {
        add: true,
        eye: true,
        label: add.textContent.trim(),
        tag: add.tagName,
        type: add.getAttribute('type'),
        afterEye: Boolean(order),
        insideActions: Boolean(add.closest('.kikx-window__actions')),
      };
    });
    assert.equal(header.add, true, 'the header carries a create button inside a session');
    assert.equal(header.eye, true, 'the eyeball filter is still there');
    assert.equal(header.afterEye, true, 'the create button sits to the right of the eyeball');
    assert.equal(header.insideActions, true, 'the create button lives in the header actions cluster');
    assert.equal(header.tag, 'BUTTON', 'the create control is a real button, not a styled span');
    assert.equal(header.type, 'button', 'the create button is not a submit button');
    assert.match(header.label, /\+?\s*Add\s+\S+/, 'the create button carries an honest Add label');

    // 6) The root Projects grid keeps its own create button too — the brief's
    //    point 3 is "always reachable", which includes the top level.
    await page.goto(`${fixture.baseURL}/`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForSelector('.kikx-window__header', { timeout: 15000 });
    await waitForRenderSettled(page);
    let root = await page.evaluate(() => {
      let add = document.querySelector('.kikx-window__add');
      let eye = document.querySelector('.kikx-frame-filter__button');
      return {
        label: add?.textContent?.trim() || null,
        afterEye: Boolean(add && eye && (eye.compareDocumentPosition(add) & Node.DOCUMENT_POSITION_FOLLOWING)),
        childrenRegion: document.querySelectorAll('.kikx-thread__children').length,
      };
    });
    assert.ok(root.label, 'the root Projects grid also carries a create button');
    assert.match(root.label, /Add\s+Project/i, `the root button names the root level (saw "${root.label}")`);
    assert.equal(root.afterEye, true, 'the root create button is also right of the eyeball');
    assert.equal(root.childrenRegion, 0, 'the root grid does not render the inline child row');
  } finally {
    await browser.close();
    await fixture.close();
  }
});

function frame(id, type, order, sessionID, text) {
  return {
    id,
    type,
    sessionID,
    interactionID: `interaction_${order}`,
    parentID: null,
    authorType: type === 'UserMessage' ? 'user' : 'agent',
    authorID: type === 'UserMessage' ? 'user' : 'agent',
    authorDisplayName: type === 'UserMessage' ? 'user' : 'agent',
    hidden: false,
    deleted: false,
    order,
    createdAt: 1781035260000000 + order,
    updatedAt: 1781035260000000 + order,
    content: { text },
  };
}

async function waitForRenderSettled(page, quietMS = 250, timeoutMS = 15000) {
  let startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMS) {
    let settled = await page.evaluate(() => document.querySelector('kikx-app')?._startupSettled === true);
    if (settled)
      break;
    await delay(25);
  }

  let lastShell = Symbol('unset');
  let stableSince = Date.now();
  while (Date.now() - startedAt < timeoutMS) {
    let shell = await page.evaluate(() => document.querySelector('kikx-app')?._renderStats?.shell ?? null);
    if (shell === null)
      return;
    if (shell !== lastShell) {
      lastShell = shell;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= quietMS) {
      return;
    }
    await delay(25);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
