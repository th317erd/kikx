'use strict';

// AgentProgress is a normal message card, not a compact status row: it must show
// the complete update text.
//
// Colour is mood-driven. `frameMoodBand()` (src/client/components/
// tool-frame-summary.mjs) bands every AgentProgress frame - 'meh' when no mood
// score was recorded, as legacy data has - and the `.kikx-frame[data-mood-band=…]`
// rules in frame-colors.css override `--kikx-frame-type-color` for all three
// bands. Consequence: the lilac type colour declared on
// `.kikx-frame--AgentProgress` never applies to an AgentProgress frame; a
// good-mood update paints green, not lilac.
//
// This spec used to assert the lilac treatment as fixed hex strings
// ('rgb(27, 22, 38)' / 'rgb(95, 75, 134)'). That has been false since mood
// colouring landed (d855809d, 2026-10-21), and could not have passed even
// before then: Chrome serialises these values as `color(srgb …)` or `oklch(…)`,
// never as those literals. It now asserts the band contract that actually ships,
// comparing browser-normalised 8-bit channels instead of colour strings.

import assert from 'node:assert/strict';
import test from 'node:test';

import puppeteer from 'puppeteer-core';

import {
  findChromeExecutable,
  startStagehandUIServer,
} from '../stagehand/stagehand-test-utils.mjs';

const PROGRESS_TEXT = [
  'Investigation plan: (1) read the submit path in kikx-question-card.mjs / kikx-inbox-view.mjs',
  'to see what state, if any, is set on click; (2) check whether any pending/disabled/success',
  'affordance exists in CSS or markup; (3) confirm the POST path and where the card list is',
  'reconciled. Expectation: the list should update only after the server round-trip without',
  'losing the typed draft or the card the user is working on.',
].join(' ');

function spread(color) {
  return Math.max(color.r, color.g, color.b) - Math.min(color.r, color.g, color.b);
}

function describe(color) {
  return `r=${color.r} g=${color.g} b=${color.b} spread=${spread(color)}`;
}

// The three bands differ by hue, so assert dominant channels rather than exact
// values: the palette is derived through oklch() and must stay free to shift.
function isNeutral(color) {
  return spread(color) <= 32;
}

function isGreen(color) {
  return color.g > color.r + 16 && color.g > color.b + 16;
}

function isRed(color) {
  return color.r > color.g + 16 && color.r > color.b + 16;
}

async function readProgressCard(page, frameID) {
  return page.evaluate((id) => {
    // A 1x1 canvas normalises any valid CSS colour - rgb(), color(srgb …),
    // oklch(), named - into comparable 8-bit channels.
    function normalise(value) {
      let canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      let ctx = canvas.getContext('2d');
      ctx.fillStyle = '#000000';
      ctx.fillStyle = value;
      ctx.fillRect(0, 0, 1, 1);
      let [ r, g, b ] = ctx.getImageData(0, 0, 1, 1).data;
      return { r, g, b };
    }

    let item = document.querySelector(`kikx-frame-item[data-frame-id="${id}"]`);
    let content = item.querySelector('.kikx-frame__content');
    let style = getComputedStyle(item);
    return {
      text: content?.textContent || '',
      compact: item.classList.contains('kikx-frame--compact'),
      backgroundRaw: style.backgroundColor,
      borderRaw: style.borderColor,
      background: normalise(style.backgroundColor),
      border: normalise(style.borderColor),
      typeColor: style.getPropertyValue('--kikx-frame-type-color').trim(),
      moodBand: item.dataset.moodBand || '',
      height: content?.getBoundingClientRect().height || 0,
    };
  }, frameID);
}

async function renderProgressCard(t, frameContent) {
  let chromePath = findChromeExecutable();
  if (!chromePath) {
    t.skip('Puppeteer local smoke requires Chrome');
    return null;
  }

  let fixture = await startStagehandUIServer({
    sessions: [ { id: 'session_1', title: 'Progress Text', messageCount: 1 } ],
  });
  fixture.frameRuntime.framesBySessionID.set('session_1', [{
    id: 'progress_1',
    type: 'AgentProgress',
    sessionID: 'session_1',
    authorType: 'agent',
    authorID: 'agent_1',
    authorDisplayName: 'Zav',
    timestamp: 1781035260000000,
    createdAt: 1781035260000000,
    updatedAt: 1781035260000000,
    order: 1,
    hidden: false,
    deleted: false,
    content: frameContent,
  }]);

  let browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: process.env.KIKX_PUPPETEER_HEADLESS === '0' ? false : 'new',
    args: [ '--no-sandbox', '--disable-setuid-sandbox' ],
  });

  try {
    let page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.evaluateOnNewDocument(() => {
      sessionStorage.setItem('kikx.auth.session', JSON.stringify({ token: 'puppeteer-test-token', refresh_token: 'puppeteer-test-refresh' }));
    });
    await page.goto(`${fixture.baseURL}/?view=thread`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForSelector('kikx-frame-item[data-frame-id="progress_1"]', { timeout: 15000 });
    return await readProgressCard(page, 'progress_1');
  } finally {
    await browser.close().catch(() => {});
    await fixture.close().catch(() => {});
  }
}

test('Puppeteer shows a complete AgentProgress message card', async (t) => {
  let result = await renderProgressCard(t, { text: PROGRESS_TEXT, status: 'progress' });
  if (!result) return;

  assert.equal(result.text, PROGRESS_TEXT, 'the complete update text is present');
  assert.equal(result.compact, false, 'progress is a normal message card');
  assert.ok(result.height > 24, 'the update occupies multiple lines');
});

test('a progress update with no mood score is banded meh and paints neutral', async (t) => {
  let result = await renderProgressCard(t, { text: PROGRESS_TEXT, status: 'progress' });
  if (!result) return;

  assert.equal(result.moodBand, 'meh',
    'an update with no recorded mood is banded meh');
  assert.ok(isNeutral(result.background),
    `a meh progress frame paints a neutral surface (${result.backgroundRaw} => ${describe(result.background)})`);
  assert.ok(isNeutral(result.border),
    `a meh progress frame paints a neutral border (${result.borderRaw} => ${describe(result.border)})`);
});

test('a good-mood update paints green and a bad-mood update paints red', async (t) => {
  let good = await renderProgressCard(t, {
    text: PROGRESS_TEXT,
    status: 'progress',
    mood: 2,
    moodWord: 'Elated',
  });
  if (!good) return;

  assert.equal(good.moodBand, 'good', 'a recorded mood of 2 is banded good');
  assert.ok(isGreen(good.background),
    `a good-mood frame paints the green surface (${good.backgroundRaw} => ${describe(good.background)})`);

  let bad = await renderProgressCard(t, {
    text: PROGRESS_TEXT,
    status: 'progress',
    mood: -2,
    moodWord: 'Stressed',
  });
  if (!bad) return;

  assert.equal(bad.moodBand, 'bad', 'a recorded mood of -2 is banded bad');
  assert.ok(isRed(bad.background),
    `a bad-mood frame paints the red surface (${bad.backgroundRaw} => ${describe(bad.background)})`);
});
