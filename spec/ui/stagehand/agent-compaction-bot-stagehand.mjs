'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { Stagehand } from '@browserbasehq/stagehand';

import {
  findChromeExecutable,
  loadStagehandOpenAIAPIKey,
  startStagehandUIServer,
} from './stagehand-test-utils.mjs';

test('Stagehand designates compaction bots from the Agents modal with a distinct glyph', async (t) => {
  let chromePath = findChromeExecutable();
  if (!chromePath) {
    t.skip('Stagehand local mode requires Chrome');
    return;
  }

  let openAIAPIKey = await loadStagehandOpenAIAPIKey();
  if (!openAIAPIKey) {
    t.skip('Set OPENAI_API_KEY or create a Test 1 Kikx agent with an apiKey secret');
    return;
  }

  let previousOpenAIAPIKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = openAIAPIKey;

  let fixture = await startStagehandUIServer({
    sessions: [ { id: 'session_1', title: 'Compaction Smoke', messageCount: 0 } ],
    agents: [
      { id: 'agent_a', name: 'Alpha', pluginID: 'test-agent', enabled: true },
      { id: 'agent_b', name: 'Bravo', pluginID: 'test-agent', enabled: true },
      { id: 'agent_c', name: 'Charlie', pluginID: 'test-agent', enabled: true },
    ],
    providers: [
      {
        pluginID: 'test-agent',
        displayName: 'Test Agent',
        configFields: [
          { name: 'model', type: 'text', required: false },
          { name: 'apiKey', type: 'password', secret: true, required: false },
        ],
      },
    ],
  });

  let stagehand = new Stagehand({
    env: 'LOCAL',
    model: process.env.KIKX_STAGEHAND_MODEL || 'openai/gpt-4.1-mini',
    verbose: 0,
    domSettleTimeout: 750,
    localBrowserLaunchOptions: {
      headless: process.env.KIKX_STAGEHAND_HEADLESS === '0' ? false : true,
      executablePath: chromePath,
      chromiumSandbox: false,
      viewport: { width: 1100, height: 800 },
      args: [ '--no-sandbox', '--disable-setuid-sandbox' ],
      connectTimeoutMs: 30000,
    },
  });

  try {
    await stagehand.init();
    let page = stagehand.context.pages()[0];
    await page.goto(`${fixture.baseURL}/?code=stagehand-test`, { waitUntil: 'domcontentloaded', timeout: 10000 });
    await page.waitForSelector('.kikx-topbar__actions button', { timeout: 10000 });

    await page.evaluate(() => {
      let button = Array.from(document.querySelectorAll('.kikx-topbar__actions button'))
        .find((candidate) => candidate.textContent.trim() === 'Agents');
      button.click();
    });
    await page.waitForSelector('.kikx-agent-list__compaction-bot', { timeout: 10000 });

    // The second button exists next to the crown and carries the compact glyph,
    // not a crown.
    let initial = await page.evaluate(() => ({
      crowns: document.querySelectorAll('.kikx-agent-list__crown').length,
      bots: document.querySelectorAll('.kikx-agent-list__compaction-bot').length,
      glyphs: Array.from(document.querySelectorAll('.kikx-agent-list__compaction-bot')).map((button) => button.textContent),
      designated: document.querySelectorAll('.kikx-agent-list__compaction-bot.is-compaction-bot').length,
    }));
    assert.equal(initial.crowns, 3);
    assert.equal(initial.bots, 3);
    assert.deepEqual(initial.glyphs, [ '⊟', '⊟', '⊟' ]);
    assert.equal(initial.designated, 0);

    // Designate the first agent, then the second. Newest designation is #1.
    for (let index = 0; index < 2; index++) {
      await page.evaluate((rowIndex) => {
        document.querySelectorAll('.kikx-agent-list__compaction-bot')[rowIndex].click();
      }, index);
      await waitForBotCount(page, index + 1);
    }

    let ranks = await page.evaluate(() => Array.from(document.querySelectorAll('.kikx-agent-list li'))
      .map((row) => ({
        name: row.querySelector('strong')?.textContent || '',
        rank: (/rank-(\d)/.exec(row.querySelector('.kikx-agent-list__compaction-bot')?.className || '') || [])[1] || '',
        pressed: row.querySelector('.kikx-agent-list__compaction-bot')?.getAttribute('aria-pressed'),
      }))
      .filter((row) => row.rank));

    assert.deepEqual(
      Object.fromEntries(ranks.map((row) => [ row.name, row.rank ])),
      { Alpha: '2', Bravo: '1' },
    );
    assert.equal(ranks.every((row) => row.pressed === 'true'), true);

    // Client state must match the authoritative server compaction-bot list.
    let synced = await page.evaluate(async () => {
      let response = await fetch('/api/v1/agents/compaction-bots');
      let body = await response.json();
      let serverCount = (body.data.compactionBots || []).length;
      let stateIDs = document.querySelector('kikx-app')?._state?.agentIDs || [];
      let details = document.querySelector('kikx-app')?._state?.agentDetailsByID || {};
      let clientCount = stateIDs.filter((id) => details[id]?.compactionCrownedClock).length;
      return { serverCount, clientCount, rankedCount: document.querySelectorAll('.kikx-agent-list__compaction-bot.is-compaction-bot').length };
    });
    assert.equal(synced.serverCount, 2);
    assert.equal(synced.clientCount, 2);
    assert.equal(synced.rankedCount, 2);
  } finally {
    await stagehand.close().catch(() => {});
    await fixture.close().catch(() => {});
    if (previousOpenAIAPIKey == null)
      delete process.env.OPENAI_API_KEY;
    else
      process.env.OPENAI_API_KEY = previousOpenAIAPIKey;
  }
});

async function waitForBotCount(page, expectedCount, timeoutMS = 10000) {
  let startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMS) {
    let count = await page.evaluate(() => document.querySelectorAll('.kikx-agent-list__compaction-bot.is-compaction-bot').length);
    if (count === expectedCount)
      return;

    await delay(50);
  }

  throw new Error(`Timed out waiting for ${expectedCount} compaction bots`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
