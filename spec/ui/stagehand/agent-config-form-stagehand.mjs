'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { Stagehand } from '@browserbasehq/stagehand';

import {
  findChromeExecutable,
  loadStagehandOpenAIAPIKey,
  startStagehandUIServer,
} from './stagehand-test-utils.mjs';

const CODEX_PLUGIN_PATH = new URL('../../../../kikx-plugin-codex', import.meta.url).pathname;

test('Stagehand renders a plugin-owned agent-config-form served from plugin assets', async (t) => {
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

  // Load the real Codex plugin so its agent-config-form descriptor and served
  // asset route are exercised end to end.
  let fixture = await startStagehandUIServer({
    pluginPaths: CODEX_PLUGIN_PATH,
    sessions: [ { id: 'session_1', title: 'Plugin Config Form Smoke', messageCount: 0 } ],
    agents: [],
    providers: [
      {
        pluginID: 'codex-agent',
        agentType: 'codex',
        serviceType: 'openai',
        displayName: 'Codex',
        description: 'Codex API development agent provider',
        configFields: [
          // Unreachable endpoint keeps the form on the deterministic static
          // fallback path (no external network calls in the UI test).
          { name: 'baseUrl', label: 'Base URL', type: 'text', required: false, defaultValue: 'http://127.0.0.1:59999' },
          { name: 'model', label: 'Model', type: 'text', required: true, defaultValue: 'gpt-5.2' },
          { name: 'apiKey', label: 'API key', type: 'password', required: false, secret: true },
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
      args: [ '--no-sandbox', '--disable-setuid-sandbox' ],
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

    // Self-healing interactions: a click can race the app's initial async load,
    // so retry until the observed state arrives.
    await waitForPagePredicate(page, () => {
      if (document.querySelector('.kikx-agent-manager'))
        return true;

      Array.from(document.querySelectorAll('.kikx-topbar__actions button'))
        .find((candidate) => candidate.textContent.trim() === 'Agents')?.click();
      return false;
    });

    // Providers load asynchronously when the manager opens; the editor builds
    // its config section from the selected provider, so wait for them first.
    await waitForPagePredicate(page, () => (document.querySelector('kikx-app')?._state?.agentProviders?.length || 0) > 0);

    await waitForPagePredicate(page, () => {
      if (document.querySelector('.kikx-agent-form kog-agent-config-form'))
        return true;

      let select = document.querySelector('.kikx-agent-form aeor-select[name="pluginID"]');
      if (select) {
        if (select.value !== 'codex-agent') {
          select.value = 'codex-agent';
          select.dispatchEvent(new Event('change', { bubbles: true }));
        }
      } else {
        Array.from(document.querySelectorAll('aeor-modal[title="Agents"] button'))
          .find((candidate) => candidate.textContent.trim() === '+ Add Agent')?.click();
      }

      return false;
    });

    // The custom element must be registered (its module was fetched from the
    // plugin asset route) and expose the readValues contract.
    let result = await page.evaluate(() => {
      let form = document.querySelector('.kikx-agent-form kog-agent-config-form');
      let modelSelect = form?.querySelector('.kog-config__model-select');
      return {
        registered: Boolean(customElements.get('kog-agent-config-form')),
        hasBaseUrl: Boolean(form?.querySelector('.kog-config__base-url')),
        hasApiKey: Boolean(form?.querySelector('.kog-config__api-key')),
        modelValues: (modelSelect?.options || []).map((option) => option.value),
        readValues: form?.readValues ? form.readValues() : null,
      };
    });

    assert.equal(result.registered, true);
    assert.equal(result.hasBaseUrl, true);
    assert.equal(result.hasApiKey, true);
    assert.ok(result.modelValues.includes('gpt-5.2'), 'static fallback model catalog must be offered');
    assert.deepEqual(result.readValues, {
      config: { baseUrl: 'http://127.0.0.1:59999', model: 'gpt-5.2' },
      secrets: {},
    });

    // Changing the base URL must trigger a refetch against the new endpoint.
    // Record fetch calls so the refetch is observable, then fall back to free
    // text because the endpoint is unreachable.
    await page.evaluate(() => {
      window.__kogModelFetches = [];
      let originalFetch = window.fetch.bind(window);
      window.fetch = (url, options) => {
        window.__kogModelFetches.push(String(url));
        return originalFetch(url, options);
      };
      let input = document.querySelector('.kikx-agent-form kog-agent-config-form .kog-config__base-url');
      input.value = 'http://127.0.0.1:59998';
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });

    await waitForPagePredicate(page, () => window.__kogModelFetches?.some((url) => url.includes('59998/v1/models')));
    await waitForPagePredicate(page, () => Boolean(
      document.querySelector('.kikx-agent-form kog-agent-config-form .kog-config__model-text:not([hidden])'),
    ));

    let afterChange = await page.evaluate(() => document.querySelector('kog-agent-config-form').readValues());
    assert.equal(afterChange.config.baseUrl, 'http://127.0.0.1:59998');
    assert.equal(afterChange.config.model, 'gpt-5.2');
  } finally {
    await stagehand.close().catch(() => {});
    await fixture.close();
    if (previousOpenAIAPIKey == null)
      delete process.env.OPENAI_API_KEY;
    else
      process.env.OPENAI_API_KEY = previousOpenAIAPIKey;
  }
});

async function waitForPagePredicate(page, predicate, timeoutMS = 10000) {
  let start = Date.now();
  while (Date.now() - start < timeoutMS) {
    if (await page.evaluate(predicate))
      return;

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error('Timed out waiting for page predicate');
}
