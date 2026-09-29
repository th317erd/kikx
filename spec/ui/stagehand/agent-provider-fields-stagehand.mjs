'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { Stagehand } from '@browserbasehq/stagehand';

import {
  findChromeExecutable,
  loadStagehandOpenAIAPIKey,
  startStagehandUIServer,
} from './stagehand-test-utils.mjs';

test('Stagehand renders plugin-declared agent provider fields including a dynamic model select', async (t) => {
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
      { id: 'session_1', title: 'Provider Fields Smoke', messageCount: 0 },
    ],
    agents: [],
    providers: [
      {
        pluginID: 'ollama-agent',
        agentType: 'ollama',
        serviceType: 'ollama',
        displayName: 'Ollama',
        description: 'Ollama agent provider',
        configFields: [
          {
            name: 'baseUrl',
            label: 'Base URL',
            type: 'text',
            required: true,
            defaultValue: 'http://127.0.0.1:11434',
            help: 'Ollama server base URL.',
          },
          {
            name: 'model',
            label: 'Model',
            type: 'select',
            required: true,
            defaultValue: 'deepseek-v4.1-flash:cloud',
            options: [
              { value: 'deepseek-v4.1-flash:cloud', label: 'deepseek-v4.1-flash:cloud' },
              { value: 'llama3.2:latest', label: 'llama3.2:latest' },
            ],
            help: 'Model served by the configured Ollama server.',
          },
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
    await clickButtonByText(page, 'Agents', '.kikx-topbar__actions');
    await waitForPagePredicate(page, () => Boolean(document.querySelector('.kikx-agent-manager')));

    await clickButtonByText(page, '+ Add Agent', 'aeor-modal[title="Agents"]');
    await waitForPagePredicate(page, () => Boolean(document.querySelector('.kikx-agent-form')));

    await selectProvider(page, 'ollama-agent');
    await waitForPagePredicate(page, () => Boolean(document.querySelector('.kikx-agent-form aeor-select[name="model"]')));

    let result = await page.evaluate(() => {
      let modelSelect = document.querySelector('.kikx-agent-form aeor-select[name="model"]');
      let baseUrlInput = document.querySelector('.kikx-agent-form aeor-input[name="baseUrl"] input');
      return {
        hasBaseUrl: Boolean(baseUrlInput),
        baseUrlValue: baseUrlInput?.value || '',
        modelOptions: (modelSelect?.options || []).map((option) => ({ value: option.value, label: option.label })),
      };
    });

    assert.equal(result.hasBaseUrl, true);
    assert.equal(result.baseUrlValue, 'http://127.0.0.1:11434');
    assert.deepEqual(result.modelOptions, [
      { value: 'deepseek-v4.1-flash:cloud', label: 'deepseek-v4.1-flash:cloud' },
      { value: 'llama3.2:latest', label: 'llama3.2:latest' },
    ]);

    await selectModel(page, 'llama3.2:latest');
    let selected = await page.evaluate(() => document.querySelector('.kikx-agent-form aeor-select[name="model"]')?.value || '');
    assert.equal(selected, 'llama3.2:latest');
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

async function selectProvider(page, pluginID) {
  await page.evaluate((value) => {
    let select = document.querySelector('.kikx-agent-form aeor-select[name="pluginID"]');
    if (!select)
      throw new Error('Missing provider select');

    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }, pluginID);
}

async function selectModel(page, value) {
  await page.evaluate((nextValue) => {
    let select = document.querySelector('.kikx-agent-form aeor-select[name="model"]');
    if (!select)
      throw new Error('Missing model select');

    select.value = nextValue;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
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
