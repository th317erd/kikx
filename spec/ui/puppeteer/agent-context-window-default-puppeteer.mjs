'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';
import puppeteer from 'puppeteer-core';
import { findChromeExecutable, startStagehandUIServer } from '../stagehand/stagehand-test-utils.mjs';

const PROVIDER = {
  pluginID: 'ollama-agent',
  agentType: 'ollama',
  displayName: 'Ollama',
  description: 'Ollama test provider',
  configFields: [
    { name: 'baseUrl', label: 'Base URL', type: 'text', required: true, defaultValue: 'http://127.0.0.1:11434', help: '' },
    {
      name: 'model',
      label: 'Model',
      type: 'select',
      required: true,
      defaultValue: 'mimo-v2.6-flash:cloud',
      options: [
        { value: 'mimo-v2.6-flash:cloud', label: 'mimo-v2.6-flash:cloud', contextWindow: 1_048_576 },
        { value: 'qwen2.5vl:3b', label: 'qwen2.5vl:3b', contextWindow: 128_000 },
      ],
      help: '',
    },
    { name: 'contextWindowTokens', label: 'Context window (tokens)', type: 'number', required: false, secret: false, help: '' },
  ],
};

test('Puppeteer create-agent form defaults the context window from the selected model', async (t) => {
  let chromePath = findChromeExecutable();
  if (!chromePath) { t.skip('Puppeteer agent-form coverage requires Chrome'); return; }

  let fixture = await startStagehandUIServer({
    sessions: [ { id: 'session_context', title: 'Context window', messageCount: 1 } ],
    providers: [ PROVIDER ],
  });
  let browser = await puppeteer.launch({ executablePath: chromePath, headless: 'new', args: [ '--no-sandbox', '--disable-setuid-sandbox' ] });
  try {
    let page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.evaluateOnNewDocument(() => sessionStorage.setItem('kikx.auth.session', JSON.stringify({ token: 'ctx-token', refresh_token: 'ctx-refresh' })));
    await page.goto(`${fixture.baseURL}/?session=session_context&view=agents`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForFunction(() => document.querySelector('kikx-app')?._startupSettled === true, { timeout: 15000 });

    await page.evaluate(() => document.querySelector('kikx-app')._createAgent());
    await page.evaluate(() => document.querySelector('kikx-app')._selectAgentProvider('ollama-agent'));
    await page.waitForSelector('input[name="contextWindowTokens"]', { timeout: 10000 });

    let result = await page.evaluate(() => ({
      contextWindow: document.querySelector('input[name="contextWindowTokens"]')?.value ?? null,
      model: document.querySelector('[name="model"]')?.value ?? null,
      config: { ...document.querySelector('kikx-app')._state.agentFormConfig },
    }));

    assert.equal(result.contextWindow, '1048576', 'the selected model must prefill the context window');
    assert.equal(result.model, 'mimo-v2.6-flash:cloud', 'the default model must still be selected');
    assert.equal(result.config.contextWindowTokens, 1_048_576, 'the prefilled value must be in form state');
  } finally {
    await browser?.close();
    await fixture.close();
  }
});
