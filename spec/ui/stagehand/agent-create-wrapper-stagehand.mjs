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
const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com';
const LOCAL_BASE_URL = 'http://127.0.0.1:59998';

// Acceptance test for the owner's exact bug: open Agents -> + Add Agent ->
// select Codex -> type a local Base URL -> name -> leave API key blank ->
// Create. It must POST the TYPED base URL (not the default OpenAI URL) with no
// apiKey. It also verifies the client-side validation path: default OpenAI URL
// + blank key shows a client error and does NOT POST.
test('Stagehand wrapper reads Codex guts values and blocks invalid default-endpoint create', async (t) => {
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

  // Load the real Codex plugin so its registered guts element and served asset
  // are exercised end to end.
  let fixture = await startStagehandUIServer({
    pluginPaths: CODEX_PLUGIN_PATH,
    sessions: [ { id: 'session_1', title: 'Agent Create Wrapper Smoke', messageCount: 0 } ],
    agents: [],
    providers: [
      {
        pluginID: 'codex-agent',
        agentType: 'codex',
        serviceType: 'openai',
        displayName: 'Codex',
        description: 'Codex API development agent provider',
        configFields: [
          // Offline-safe default so the initial form does not call a real
          // endpoint; the tests set the base URL explicitly either way.
          { name: 'baseUrl', label: 'Base URL', type: 'text', required: false, defaultValue: LOCAL_BASE_URL },
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

    // Open the Agents modal.
    await waitForPagePredicate(page, () => {
      if (document.querySelector('.kikx-agent-manager'))
        return true;

      Array.from(document.querySelectorAll('.kikx-topbar__actions button'))
        .find((candidate) => candidate.textContent.trim() === 'Agents')?.click();
      return false;
    });

    // Providers and the plugin's client module load asynchronously. Wait for
    // both before opening the editor: the wrapper picks the guts tag at render
    // time based on whether the plugin custom element is registered.
    await waitForPagePredicate(page, () => (document.querySelector('kikx-app')?._state?.agentProviders?.length || 0) > 0);
    await waitForPagePredicate(page, () => Boolean(customElements.get('kog-agent-config-form')));

    // Open the Create-agent editor and select the Codex provider.
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
        Array.from(document.querySelectorAll('aeor-modal button'))
          .find((candidate) => candidate.textContent.trim() === '+ Add Agent')?.click();
      }

      return false;
    });

    // The registered guts element must be present (module fetched from the
    // plugin asset route) and expose the new contract.
    let contract = await page.evaluate(() => {
      let guts = document.querySelector('.kikx-agent-form kog-agent-config-form');
      return {
        registered: Boolean(customElements.get('kog-agent-config-form')),
        hasSetContext: typeof guts?.setContext === 'function',
        hasValidate: typeof guts?.validate === 'function',
        hasReadValues: typeof guts?.readValues === 'function',
      };
    });
    assert.equal(contract.registered, true);
    assert.equal(contract.hasSetContext, true);
    assert.equal(contract.hasValidate, true);
    assert.equal(contract.hasReadValues, true);

    // Record agent POSTs and stub model discovery so the test stays offline and
    // deterministic regardless of the typed base URL.
    await page.evaluate(() => {
      window.__agentPosts = [];
      let originalFetch = window.fetch.bind(window);
      window.fetch = (url, options) => {
        let target = String(url);
        if (target.includes('/v1/models')) {
          return Promise.resolve(new Response(JSON.stringify({ data: [] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }));
        }

        if (target.includes('/api/v1/agents') && String(options?.method || 'GET').toUpperCase() === 'POST') {
          window.__agentPosts.push({ url: target, body: options?.body || '' });
        }

        return originalFetch(url, options);
      };
    });

    // --- Client-side validation: default OpenAI URL + blank API key ---
    await setFormFields(page, { name: 'Gemma', baseUrl: DEFAULT_OPENAI_BASE_URL });
    await clickCreate(page);

    await waitForPagePredicate(page, () => Boolean(document.querySelector('.kikx-agent-form__error')));
    let validation = await page.evaluate(() => ({
      errorText: document.querySelector('.kikx-agent-form__error')?.textContent || '',
      posts: window.__agentPosts.length,
      stillOpen: Boolean(document.querySelector('.kikx-agent-form')),
    }));
    assert.match(validation.errorText, /api key is required/i);
    assert.equal(validation.posts, 0, 'invalid default-endpoint create must not POST');
    assert.equal(validation.stillOpen, true);

    // --- Owner flow: local/unreachable base URL, blank API key -> POST ---
    await setFormFields(page, { name: 'Gemma', baseUrl: LOCAL_BASE_URL });
    await clickCreate(page);

    await waitForPagePredicate(page, () => window.__agentPosts.length > 0);
    let created = await page.evaluate(() => {
      let post = window.__agentPosts[0];
      let body = JSON.parse(post.body || '{}');
      return {
        url: post.url,
        name: body.name,
        pluginID: body.pluginID,
        baseUrl: body.config?.baseUrl,
        model: body.config?.model,
        secrets: body.secrets || {},
        managerOpen: Boolean(document.querySelector('.kikx-agent-manager')),
      };
    });

    assert.equal(created.url, '/api/v1/agents');
    assert.equal(created.name, 'Gemma');
    assert.equal(created.pluginID, 'codex-agent');
    assert.equal(created.baseUrl, LOCAL_BASE_URL, 'body must carry the typed base URL');
    assert.notEqual(created.baseUrl, DEFAULT_OPENAI_BASE_URL);
    assert.equal(Object.hasOwn(created.secrets, 'apiKey'), false, 'blank key must not be sent');
    assert.equal(created.managerOpen, true);
  } finally {
    await stagehand.close().catch(() => {});
    await fixture.close();
    if (previousOpenAIAPIKey == null)
      delete process.env.OPENAI_API_KEY;
    else
      process.env.OPENAI_API_KEY = previousOpenAIAPIKey;
  }
});

async function setFormFields(page, { name, baseUrl }) {
  await page.evaluate(({ nextName, nextBaseUrl }) => {
    let nameInput = document.querySelector('.kikx-agent-form aeor-input[name="name"] input');
    if (!nameInput)
      throw new Error('Missing agent name input');

    nameInput.value = nextName;
    nameInput.dispatchEvent(new Event('input', { bubbles: true }));
    nameInput.dispatchEvent(new Event('change', { bubbles: true }));

    let baseUrlInput = document.querySelector('.kikx-agent-form kog-agent-config-form .kog-config__base-url input');
    if (!baseUrlInput)
      throw new Error('Missing Codex base URL input');

    baseUrlInput.value = nextBaseUrl;
    baseUrlInput.dispatchEvent(new Event('change', { bubbles: true }));
    baseUrlInput.dispatchEvent(new Event('input', { bubbles: true }));
  }, { nextName: name, nextBaseUrl: baseUrl });
}

async function clickCreate(page) {
  await page.evaluate(() => {
    let button = Array.from(document.querySelectorAll('aeor-modal button'))
      .find((candidate) => candidate.textContent.trim() === 'Create');
    if (!button)
      throw new Error('Missing Create button');

    button.click();
  });
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
