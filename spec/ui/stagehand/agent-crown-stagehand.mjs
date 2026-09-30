'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { Stagehand } from '@browserbasehq/stagehand';

import {
  findChromeExecutable,
  loadStagehandOpenAIAPIKey,
  startStagehandUIServer,
} from './stagehand-test-utils.mjs';

test('Stagehand crowns master agents from the Agents modal with ranked styling', async (t) => {
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
    sessions: [ { id: 'session_1', title: 'Crown Smoke', messageCount: 0 } ],
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

    // Open the Agents modal via a real click.
    await page.evaluate(() => {
      let button = Array.from(document.querySelectorAll('.kikx-topbar__actions button'))
        .find((candidate) => candidate.textContent.trim() === 'Agents');
      button.click();
    });
    await page.waitForSelector('.kikx-agent-list__crown', { timeout: 10000 });

    let initial = await page.evaluate(() => ({
      rows: document.querySelectorAll('.kikx-agent-list li').length,
      crowns: document.querySelectorAll('.kikx-agent-list__crown').length,
      masters: document.querySelectorAll('.kikx-agent-list__crown.is-master').length,
    }));
    assert.equal(initial.rows, 3);
    assert.equal(initial.crowns, 3);
    assert.equal(initial.masters, 0);

    // Crown the first agent, then the second, then the third.
    for (let index = 0; index < 3; index++) {
      await page.evaluate((rowIndex) => {
        document.querySelectorAll('.kikx-agent-list__crown')[rowIndex].click();
      }, index);
      await waitForMasterCount(page, index + 1);
    }

    // Newest crown is master #1: first crowned -> #3, second -> #2, third -> #1.
    let ranks = await page.evaluate(() => Array.from(document.querySelectorAll('.kikx-agent-list li'))
      .map((row) => ({
        name: row.querySelector('strong')?.textContent || '',
        rank: (/rank-(\d)/.exec(row.querySelector('.kikx-agent-list__crown')?.className || '') || [])[1] || '',
        pressed: row.querySelector('.kikx-agent-list__crown')?.getAttribute('aria-pressed'),
      }))
      .filter((row) => row.rank));

    assert.deepEqual(
      Object.fromEntries(ranks.map((row) => [ row.name, row.rank ])),
      { Alpha: '3', Bravo: '2', Charlie: '1' },
    );
    assert.equal(ranks.every((row) => row.pressed === 'true'), true);

    // The master set is a rolling top-3: crowning a fourth evicts the oldest.
    // Only three agents exist here, so first uncrown one, then re-crown it with
    // a fresh timestamp so it becomes #1 and the oldest drops out.
    await page.evaluate(() => {
      let row = Array.from(document.querySelectorAll('.kikx-agent-list li'))
        .find((candidate) => candidate.querySelector('strong')?.textContent === 'Alpha');
      row.querySelector('.kikx-agent-list__crown').click();
    });
    await waitForMasterCount(page, 2);

    await page.evaluate(() => {
      let row = Array.from(document.querySelectorAll('.kikx-agent-list li'))
        .find((candidate) => candidate.querySelector('strong')?.textContent === 'Alpha');
      row.querySelector('.kikx-agent-list__crown').click();
    });
    await waitForMasterCount(page, 3);

    // Client crowned-count must equal the server's authoritative master count.
    let synced = await page.evaluate(async () => {
      let response = await fetch('/api/v1/agents/masters');
      let body = await response.json();
      let serverCount = (body.data.masters || []).length;
      let stateIDs = document.querySelector('kikx-app')?._state?.agentIDs || [];
      let details = document.querySelector('kikx-app')?._state?.agentDetailsByID || {};
      let clientCount = stateIDs.filter((id) => details[id]?.crownedClock).length;
      return { serverCount, clientCount, rankedCount: document.querySelectorAll('.kikx-agent-list__crown.is-master').length };
    });
    assert.equal(synced.serverCount, 3);
    assert.equal(synced.clientCount, 3);
    assert.equal(synced.rankedCount, 3);
  } finally {
    await stagehand.close().catch(() => {});
    await fixture.close().catch(() => {});
    if (previousOpenAIAPIKey == null)
      delete process.env.OPENAI_API_KEY;
    else
      process.env.OPENAI_API_KEY = previousOpenAIAPIKey;
  }
});

async function waitForMasterCount(page, expectedCount, timeoutMS = 10000) {
  let startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMS) {
    let count = await page.evaluate(() => document.querySelectorAll('.kikx-agent-list__crown.is-master').length);
    if (count === expectedCount)
      return;

    await delay(50);
  }

  throw new Error(`Timed out waiting for ${expectedCount} master agents`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
