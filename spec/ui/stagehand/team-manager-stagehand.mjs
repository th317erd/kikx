'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { Stagehand } from '@browserbasehq/stagehand';

import {
  findChromeExecutable,
  loadStagehandOpenAIAPIKey,
  startStagehandUIServer,
} from './stagehand-test-utils.mjs';

test('Stagehand creates, edits, and deletes teams from the topbar Teams modal', async (t) => {
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
    sessions: [
      { id: 'session_1', title: 'Teams Smoke', messageCount: 0 },
    ],
    agents: [
      { id: 'agent_iron', name: 'Iron-Hand', pluginID: 'test-agent', enabled: true },
      { id: 'agent_bennett', name: 'Mr. Bennett', pluginID: 'test-agent', enabled: true },
    ],
    teams: [],
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
      viewport: { width: 1280, height: 800 },
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
      ],
      connectTimeoutMs: 30000,
    },
  });

  try {
    await stagehand.init();
    let page = stagehand.context.pages()[0];
    await page.goto(`${fixture.baseURL}/?code=stagehand-test&view=thread`, {
      waitUntil: 'domcontentloaded',
      timeout: 10000,
    });

    await page.waitForSelector('.kikx-topbar__actions button', { timeout: 10000 });
    await clickButtonByText(page, 'Teams', '.kikx-topbar__actions');
    await waitForPagePredicate(page, () => document.querySelector('aeor-modal[title="Teams"]')?.textContent?.includes('+ Add Team'));
    await clickButtonByText(page, '+ Add Team', 'aeor-modal[title="Teams"]');
    await waitForPagePredicate(page, () => Boolean(document.querySelector('.kikx-team-form')));

    await fillTeamForm(page, {
      name: 'Build Team',
      checked: [ 'agent:agent_iron', 'agent:agent_bennett' ],
    });
    await clickButtonByText(page, 'Create', 'aeor-modal[title="Create team"]');
    await waitForPagePredicate(page, () => document.querySelector('.kikx-team-list')?.textContent?.includes('Build Team'));
    await waitForPagePredicate(page, () => document.querySelector('.kikx-team-list')?.textContent?.includes('2 agents'));

    await page.locator('.kikx-team-list__edit').first().click();
    await page.waitForSelector('.kikx-team-form', { timeout: 10000 });
    await fillTeamForm(page, {
      name: 'Build Team',
      checked: [ 'agent:agent_iron' ],
    });
    await clickButtonByText(page, 'Save', 'aeor-modal[title="Edit team"]');
    await waitForPagePredicate(page, () => document.querySelector('.kikx-team-list')?.textContent?.includes('1 agent'));

    await page.locator('.kikx-team-list__edit').first().click();
    await waitForPagePredicate(page, () => Boolean(document.querySelector('.kikx-team-form')));
    await clickButtonByText(page, 'Delete', 'aeor-modal[title="Edit team"]');
    await waitForPagePredicate(page, () => document.querySelector('.kikx-team-manager')?.textContent?.includes('No teams.'));

    let result = await page.evaluate(() => ({
      hasBuildTeam: document.body.textContent.includes('Build Team'),
      managerText: document.querySelector('.kikx-team-manager')?.textContent || '',
    }));

    assert.equal(result.hasBuildTeam, false);
    assert.match(result.managerText, /No teams\./);
  } finally {
    await stagehand.close().catch(() => {});
    await fixture.close();
    if (previousOpenAIAPIKey == null)
      delete process.env.OPENAI_API_KEY;
    else
      process.env.OPENAI_API_KEY = previousOpenAIAPIKey;
  }
});

async function clickButtonByText(page, text, rootSelector = 'body') {
  await page.evaluate(({ text, rootSelector }) => {
    let root = document.querySelector(rootSelector);
    if (!root)
      throw new Error(`Missing root: ${rootSelector}`);

    let button = Array.from(root.querySelectorAll('button')).find((candidate) => candidate.textContent.trim() === text);
    if (!button)
      throw new Error(`Missing button: ${text}`);

    button.click();
  }, { text, rootSelector });
}

async function fillTeamForm(page, { name, checked }) {
  await page.evaluate(({ name, checked }) => {
    let nameInput = document.querySelector('.kikx-team-form aeor-input[name="name"] input');
    if (!nameInput)
      throw new Error('Missing team name input');

    nameInput.value = name;
    nameInput.dispatchEvent(new Event('input', { bubbles: true }));
    nameInput.dispatchEvent(new Event('change', { bubbles: true }));

    let checkedSet = new Set(checked);
    for (let checkbox of document.querySelectorAll('.kikx-team-form aeor-checkbox[name="team-member"]')) {
      checkbox.checked = checkedSet.has(checkbox.value);
      checkbox.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }, { name, checked });
}

async function waitForPagePredicate(page, predicate, timeoutMS = 10000) {
  let start = Date.now();
  while (Date.now() - start < timeoutMS) {
    if (await page.evaluate(predicate))
      return;

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error('Timed out waiting for page predicate');
}
