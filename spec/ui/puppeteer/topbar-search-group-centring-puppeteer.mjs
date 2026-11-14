'use strict';

// Real-browser coverage for the owner annotation in screenshot
// session-2026-11-14-01-42-32.122:
//
//   "Move the Search field and two buttons over to the center of the top bar
//    (as a whole group)."
//
// This exists because the CSS-text spec in spec/client/
// (topbar-search-eye-grouping-spec.mjs) CANNOT prove this. It matched the rule
// text while the group sat 126-218px right of the bar centre, and it matched
// again -- green, 15/15 -- for a layout that overlapped the breadcrumb by
// 116.7px. A regex over a stylesheet says what the CSS asks for; only
// getBoundingClientRect says where the pixels land.
//
// Three claims, each measured on a real render:
//
//   1. The group's CENTRE lands on the BAR's centre above 1201px.
//   2. The breadcrumb does not end up underneath the group (the group is out of
//      flow, so this is not free -- it needed an explicit cap on the lead).
//   3. Nothing overflows horizontally, and the three controls still travel
//      together as one group at every width.
//
// The NEGATIVE CONTROL is what makes this evidence rather than decoration: the
// same probe re-runs with the centring rule neutralised and MUST report an
// off-centre group. A measurement that passes with and without the fix is not
// a test, it is a coincidence.

import assert from 'node:assert/strict';
import test from 'node:test';

import puppeteer from 'puppeteer-core';

import { findChromeExecutable, startStagehandUIServer } from '../stagehand/stagehand-test-utils.mjs';

const BAR = '.kikx-topbar';
const LEAD = '.kikx-window__lead';
const GROUP = '.kikx-topbar__search-group';
const FIELD = '.kikx-session-search';
const EYE = '.kikx-frame-filter__button';
const PARTICIPANTS = '.kikx-participants__button';

// Above this the group is pinned to the bar centre; below it the media query
// does not apply and the compact/mobile sheets take over.
const CENTRED_FROM = 1201;

const WIDE = [ 1920, 1440, 1280 ];
const NARROW = [ 1100, 960 ];

function probe(page) {
  return page.evaluate((sels) => {
    const box = (selector) => {
      let node = document.querySelector(selector);
      if (!node) return null;
      let rect = node.getBoundingClientRect();
      return {
        x: rect.x,
        right: rect.right,
        width: rect.width,
        centre: rect.x + rect.width / 2,
      };
    };
    let bar = box(sels.BAR);
    let group = box(sels.GROUP);
    let lead = box(sels.LEAD);
    return {
      bar,
      group,
      lead,
      field: box(sels.FIELD),
      eye: box(sels.EYE),
      participants: box(sels.PARTICIPANTS),
      // The claim, as one number.
      groupCentreMinusBarCentre: group && bar ? group.centre - bar.centre : null,
      // Positive === the crumb runs UNDER the group's left edge.
      leadOverlap: group && lead ? lead.right - group.x : null,
      documentOverflowX: document.documentElement.scrollWidth > window.innerWidth,
    };
  }, { BAR, LEAD, GROUP, FIELD, EYE, PARTICIPANTS });
}

async function openView(page, baseURL, url, width) {
  await page.setViewport({ width, height: 900, deviceScaleFactor: 1 });
  await page.goto(`${baseURL}${url}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForSelector(GROUP, { timeout: 20000 });
  await new Promise((resolve) => setTimeout(resolve, 400));
}

async function withFixture(run) {
  let fixture = await startStagehandUIServer({
    sessions: [ { id: 'session_ctr', title: 'A Fairly Long Session Title Here', messageCount: 8 } ],
    agents: [ { id: 'ctr_agent', name: 'Centre Agent', pluginID: 'test-agent', enabled: true } ],
  });
  let chromePath = findChromeExecutable();
  if (!chromePath) {
    await fixture.close();
    return 'skipped';
  }

  let browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: 'new',
    args: [ '--no-sandbox', '--disable-setuid-sandbox' ],
  });

  try {
    let page = await browser.newPage();
    await page.evaluateOnNewDocument(() => {
      sessionStorage.setItem('kikx.auth.session', JSON.stringify({
        token: 'ctr-token',
        refresh_token: 'ctr-refresh',
      }));
    });
    await run(page, fixture.baseURL);
  } finally {
    await browser.close();
    await fixture.close();
  }
  return 'ran';
}

test('the search group sits at the BAR centre above 1201px, in both views', async () => {
  let outcome = await withFixture(async (page, baseURL) => {
    for (let view of [ { name: 'project', url: '/' }, { name: 'session', url: '/?session=session_ctr' } ]) {
      for (let width of WIDE) {
        await openView(page, baseURL, view.url, width);
        let measured = await probe(page);

        assert.ok(measured.group, `${view.name}@${width}: the search group must render`);
        assert.ok(measured.bar, `${view.name}@${width}: the bar must render`);

        // 1px of tolerance absorbs sub-pixel rounding from `translate(-50%)`;
        // anything larger is a real offset, not float noise.
        assert.ok(
          Math.abs(measured.groupCentreMinusBarCentre) <= 1,
          `${view.name}@${width}: the group's centre must land on the bar's centre; `
          + `group centre ${measured.group.centre.toFixed(1)} vs bar centre ${measured.bar.centre.toFixed(1)} `
          + `(off by ${measured.groupCentreMinusBarCentre.toFixed(1)}px)`,
        );
      }
    }
  });
  if (outcome === 'skipped') console.log('SKIP: no Chrome available');
});

test('the breadcrumb does not run underneath the centred group', async () => {
  // This is the claim that falsified an earlier version of this change: the
  // group is out of flow, so it cannot push the crumb aside, and without the
  // cap on `.kikx-window__lead` the crumb ended 116.7px inside the group at
  // both 1280 and 1440 -- the session title hidden under the search field.
  let outcome = await withFixture(async (page, baseURL) => {
    for (let view of [ { name: 'project', url: '/' }, { name: 'session', url: '/?session=session_ctr' } ]) {
      for (let width of WIDE) {
        await openView(page, baseURL, view.url, width);
        let measured = await probe(page);

        assert.ok(measured.lead, `${view.name}@${width}: the breadcrumb lead must render`);
        assert.ok(
          measured.leadOverlap <= 0,
          `${view.name}@${width}: the lead must end at or before the group's left edge; `
          + `lead right ${measured.lead.right.toFixed(1)} vs group left ${measured.group.x.toFixed(1)} `
          + `(overlap ${measured.leadOverlap.toFixed(1)}px)`,
        );
        assert.equal(
          measured.documentOverflowX,
          false,
          `${view.name}@${width}: centring must not introduce horizontal document overflow`,
        );
      }
    }
  });
  if (outcome === 'skipped') console.log('SKIP: no Chrome available');
});

test('the field, the eye and Participants travel as ONE group at every width', async () => {
  let outcome = await withFixture(async (page, baseURL) => {
    for (let width of WIDE) {
      await openView(page, baseURL, '/?session=session_ctr', width);
      let measured = await probe(page);

      assert.ok(measured.field, `@${width}: the search field must render`);
      assert.ok(measured.participants, `@${width}: Participants must render in session view`);
      assert.ok(measured.eye, `@${width}: the eye must render`);

      // Reading order and adjacency: field, then eye, then Participants, each
      // flush against the previous one. The owner's ask is about the GROUP, so
      // a gap opening up between members would break the very thing asked for.
      assert.ok(
        measured.field.right <= measured.eye.x + 1,
        `@${width}: the eye must sit right of the field`,
      );
      assert.ok(
        measured.eye.right <= measured.participants.x + 1,
        `@${width}: Participants must sit right of the eye`,
      );
      assert.ok(
        measured.eye.x - measured.field.right <= 8,
        `@${width}: field-to-eye gap must stay a hairline; got `
        + `${(measured.eye.x - measured.field.right).toFixed(1)}px`,
      );
      assert.ok(
        measured.participants.x - measured.eye.right <= 8,
        `@${width}: eye-to-Participants gap must stay a hairline; got `
        + `${(measured.participants.x - measured.eye.right).toFixed(1)}px`,
      );
      // All three must live inside the group's own box.
      assert.ok(
        measured.participants.right <= measured.group.right + 1,
        `@${width}: Participants must not spill out of the group`,
      );
    }
  });
  if (outcome === 'skipped') console.log('SKIP: no Chrome available');
});

test('NEGATIVE CONTROL: neutralising the centring rule moves the group off centre', async () => {
  // Without this, a group that happens to be centred by accident would pass the
  // spec above and prove nothing. Stripping the pin must reproduce the original
  // complaint: the group lands left of centre, hugging the breadcrumb.
  let outcome = await withFixture(async (page, baseURL) => {
    await openView(page, baseURL, '/?session=session_ctr', 1440);
    let shipped = await probe(page);
    assert.ok(
      Math.abs(shipped.groupCentreMinusBarCentre) <= 1,
      'precondition: the shipped layout must be centred before the control means anything',
    );

    await page.addStyleTag({
      content: `
        @media (min-width: 1201px) {
          .kikx-topbar.kikx-window__header .kikx-topbar__search-group {
            position: static !important;
            transform: none !important;
            width: min(600px, calc(100% - 930px)) !important;
            max-width: 600px !important;
          }
          .kikx-topbar.kikx-window__header .kikx-window__lead {
            max-width: none !important;
          }
        }
      `,
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    let control = await probe(page);

    assert.ok(
      Math.abs(control.groupCentreMinusBarCentre) > 20,
      'the negative control must reproduce an off-centre group; measured '
      + `${control.groupCentreMinusBarCentre.toFixed(1)}px from the bar centre. `
      + 'If this is near zero, the probe is not measuring what the fix changed.',
    );
  });
  if (outcome === 'skipped') console.log('SKIP: no Chrome available');
});

test('below 1201px the group is in flow and never overflows', async () => {
  // The pin is deliberately scoped above 1201px: at narrow widths a centred
  // 600px group cannot clear the breadcrumb at all, so the compact sheets keep
  // the group in flow. This asserts only that nothing breaks there -- it does
  // NOT assert the group is centred, because at these widths it is not and is
  // not meant to be.
  let outcome = await withFixture(async (page, baseURL) => {
    for (let width of NARROW) {
      await openView(page, baseURL, '/?session=session_ctr', width);
      let measured = await probe(page);

      assert.ok(measured.group, `@${width}: the search group must render`);
      assert.equal(
        measured.documentOverflowX,
        false,
        `@${width}: the bar must not overflow horizontally`,
      );
      assert.ok(
        measured.leadOverlap <= 0,
        `@${width}: the breadcrumb must not run underneath the group; `
        + `overlap ${measured.leadOverlap.toFixed(1)}px`,
      );
      assert.ok(
        measured.group.right <= measured.bar.right + 1,
        `@${width}: the group must stay inside the bar`,
      );
    }
  });
  if (outcome === 'skipped') console.log('SKIP: no Chrome available');
});
