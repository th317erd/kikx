'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { chromium } from 'playwright';

import {
  findChromeExecutable,
  startStagehandUIServer,
} from '../stagehand/stagehand-test-utils.mjs';

test('Playwright manages teams through the topbar Teams UI', async (t) => {
  let chromePath = findChromeExecutable();
  if (!chromePath) {
    t.skip('Playwright local mode requires Chrome');
    return;
  }

  let fixture = await startStagehandUIServer({
    sessions: [
      { id: 'session_1', title: 'Teams Playwright', messageCount: 0 },
    ],
    agents: [
      { id: 'agent_iron', name: 'Iron-Hand', pluginID: 'test-agent', enabled: true },
      { id: 'agent_bennett', name: 'Mr. Bennett', pluginID: 'test-agent', enabled: true },
    ],
    teams: [],
  });
  let browser = await chromium.launch({
    headless: process.env.KIKX_PLAYWRIGHT_HEADLESS === '0' ? false : true,
    executablePath: chromePath,
    chromiumSandbox: false,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
    ],
  });

  try {
    let page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`${fixture.baseURL}/?code=playwright-test`, {
      waitUntil: 'domcontentloaded',
      timeout: 10000,
    });

    await page.getByRole('button', { name: 'Teams' }).click();
    await page.locator('aeor-modal[title="Teams"] .kikx-team-manager').waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: '+ Add Team' }).click();
    await page.locator('aeor-modal[title="Create team"] .kikx-team-form').waitFor({ timeout: 10000 });

    let checkboxes = page.locator('aeor-modal[title="Create team"] aeor-checkbox[name="team-member"]');
    assert.ok(await checkboxes.count() >= 2, 'team form should render aeor-checkbox member controls');

    await page.locator('aeor-modal[title="Create team"] aeor-input[name="name"] input').fill('Playwright Team');
    await page.locator('aeor-modal[title="Create team"] aeor-checkbox[value="agent:agent_iron"] input').check();
    await page.locator('aeor-modal[title="Create team"] aeor-checkbox[value="agent:agent_bennett"] input').check();
    await page.locator('aeor-modal[title="Create team"]').getByRole('button', { name: 'Create' }).click();

    await page.waitForFunction(() => document.querySelector('.kikx-team-list')?.textContent?.includes('Playwright Team'));
    await page.waitForFunction(() => document.querySelector('.kikx-team-list')?.textContent?.includes('2 agents'));

    await page.locator('.kikx-team-list__edit').first().click();
    await page.locator('aeor-modal[title="Edit team"] .kikx-team-form').waitFor({ timeout: 10000 });
    await page.locator('aeor-modal[title="Edit team"] aeor-checkbox[value="agent:agent_bennett"] input').uncheck();
    await page.locator('aeor-modal[title="Edit team"]').getByRole('button', { name: 'Save' }).click();
    await page.waitForFunction(() => document.querySelector('.kikx-team-list')?.textContent?.includes('1 agent'));

    await page.locator('.kikx-team-list__edit').first().click();
    await page.locator('aeor-modal[title="Edit team"]').getByRole('button', { name: 'Delete' }).click();
    await page.waitForFunction(() => document.querySelector('.kikx-team-manager')?.textContent?.includes('No teams.'));

    let bodyText = await page.locator('body').textContent();
    assert.ok(!bodyText.includes('Playwright Team'), 'deleted team should no longer be visible');
  } finally {
    await browser.close().catch(() => {});
    await fixture.close();
  }
});
