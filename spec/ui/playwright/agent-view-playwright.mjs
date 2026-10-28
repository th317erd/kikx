'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { chromium } from 'playwright';

import {
  findChromeExecutable,
  startStagehandUIServer,
} from '../stagehand/stagehand-test-utils.mjs';

test('Agents is a main view scoped to the current session', async (t) => {
  let chromePath = findChromeExecutable();
  if (!chromePath) {
    t.skip('Playwright local mode requires Chrome');
    return;
  }

  let fixture = await startStagehandUIServer({
    sessions: [{
      id: 'session_1',
      title: 'Agents Playwright',
      messageCount: 0,
      participantAgentIDs: [ 'agent_iron' ],
    }],
    agents: [
      { id: 'agent_iron', name: 'Iron-Hand', pluginID: 'test-agent', enabled: true },
      { id: 'agent_bennett', name: 'Mr. Bennett', pluginID: 'test-agent', enabled: true },
    ],
    teams: [],
  });
  let browser = await chromium.launch({
    headless: true,
    executablePath: chromePath,
    chromiumSandbox: false,
    args: [ '--no-sandbox', '--disable-setuid-sandbox' ],
  });

  try {
    let page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`${fixture.baseURL}/?code=agents-view-test&session=session_1`, {
      waitUntil: 'domcontentloaded',
      timeout: 10000,
    });

    await page.getByRole('button', { name: 'Agents', exact: true }).click();
    await page.locator('.kikx-agent-view .kikx-agent-manager').waitFor({ timeout: 10000 });

    let rows = await page.locator('.kikx-agent-view .kikx-agent-list li').allTextContents();
    assert.equal(rows.length, 1);
    assert.match(rows[0], /Iron-Hand/);
    assert.doesNotMatch(rows.join(' '), /Mr\. Bennett/);
    assert.match(await page.locator('.kikx-view-available').textContent(), /Mr\. Bennett/);
    assert.equal(await page.locator('aeor-modal').count(), 0, 'Agents must not open a dialog');

    await page.getByRole('button', { name: '+ Add Agent' }).click();
    await page.locator('.kikx-view-editor .kikx-agent-form').waitFor({ timeout: 10000 });
    assert.equal(await page.locator('aeor-modal').count(), 0, 'the agent editor must stay in the main view');
  } finally {
    await browser.close().catch(() => {});
    await fixture.close();
  }
});
