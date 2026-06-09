'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { PluginRegistry } from '../../src/core/plugins/index.mjs';
import {
  PuppeteerBrowserService,
  registerBuiltInTools,
  WebFetchTool,
  WebSearchTool,
} from '../../src/core/tools/index.mjs';

test('registerBuiltInTools registers global web tools with OpenAI-safe names', () => {
  let registry = new PluginRegistry({ logger: { warn() {} } });

  registerBuiltInTools(registry);

  assert.equal(registry.getTool('web-search'), WebSearchTool);
  assert.equal(registry.getTool('web-fetch'), WebFetchTool);
  assert.equal([...registry.getTools().keys()].every((name) => /^[A-Za-z0-9_-]+$/.test(name)), true);
});

test('WebSearchTool queries DuckDuckGo instant answers and normalizes results', async () => {
  let requestedURL = null;
  let tool = new WebSearchTool({
    fetchImpl: async (url, options = {}) => {
      requestedURL = new URL(url);
      assert.equal(options.headers.Accept, 'application/json');
      return {
        ok: true,
        async json() {
          return {
            Heading: 'Kikx',
            AbstractText: 'A modular agent runner.',
            AbstractURL: 'https://example.test/kikx',
            AbstractSource: 'Example',
            Answer: '42',
            Results: [
              {
                Text: 'Kikx result',
                FirstURL: 'https://example.test/result',
              },
            ],
            RelatedTopics: [
              {
                Name: 'Related',
                Topics: [
                  {
                    Text: 'Nested related result',
                    FirstURL: 'https://example.test/related',
                  },
                ],
              },
            ],
          };
        },
      };
    },
  });

  let result = await tool.execute({
    query: 'kikx agent runner',
    maxResults: 3,
  });

  assert.equal(requestedURL.origin, 'https://api.duckduckgo.com');
  assert.equal(requestedURL.searchParams.get('q'), 'kikx agent runner');
  assert.equal(requestedURL.searchParams.get('format'), 'json');
  assert.equal(result.source, 'duckduckgo-instant-answer');
  assert.equal(result.heading, 'Kikx');
  assert.equal(result.results.length, 3);
  assert.deepEqual(result.results.map((item) => item.type), [ 'abstract', 'answer', 'result' ]);
  assert.equal(result.results[0].url, 'https://example.test/kikx');
});

test('WebFetchTool extracts rendered page details through injected browser service', async () => {
  let visitedURL = null;
  let browserService = {
    async withPage(callback) {
      let page = {
        setDefaultNavigationTimeout(timeout) {
          assert.equal(timeout, 5000);
        },
        setDefaultTimeout(timeout) {
          assert.equal(timeout, 5000);
        },
        async setUserAgent(userAgent) {
          assert.match(userAgent, /Kikx/);
        },
        async goto(url, options = {}) {
          visitedURL = url;
          assert.equal(options.waitUntil, 'domcontentloaded');
          return {
            status() {
              return 200;
            },
          };
        },
        async waitForSelector(selector) {
          assert.equal(selector, 'main');
        },
        async evaluate(_fn, args) {
          assert.deepEqual(args, {
            selector: 'main',
            maxTextLength: 2000,
            maxLinks: 2,
          });
          return {
            title: 'Example Page',
            url: 'https://example.test/final',
            text: 'Rendered text',
            textTruncated: false,
            links: [
              { text: 'Docs', url: 'https://example.test/docs' },
            ],
          };
        },
      };

      return await callback(page, { mode: 'cdp' });
    },
  };

  let tool = new WebFetchTool({
    services: { webBrowser: browserService },
  });
  let result = await tool.execute({
    url: 'https://example.test/start',
    selector: 'main',
    timeoutMs: 5000,
    maxTextLength: 2000,
    maxLinks: 2,
  });

  assert.equal(visitedURL, 'https://example.test/start');
  assert.deepEqual(result, {
    requestedURL: 'https://example.test/start',
    finalURL: 'https://example.test/final',
    title: 'Example Page',
    status: 200,
    browserMode: 'cdp',
    selector: 'main',
    text: 'Rendered text',
    textTruncated: false,
    links: [
      { text: 'Docs', url: 'https://example.test/docs' },
    ],
  });
});

test('WebFetchTool rejects non-http URLs', async () => {
  let tool = new WebFetchTool({
    services: {
      webBrowser: {
        async withPage() {
          throw new Error('should not open browser');
        },
      },
    },
  });

  await assert.rejects(
    () => tool.execute({ url: 'file:///etc/passwd' }),
    /url must use http or https/,
  );
});

test('PuppeteerBrowserService falls back to headed stealth launch with a Chrome channel', async () => {
  let launchOptions = null;
  let closed = false;
  let service = new PuppeteerBrowserService({
    puppeteerCore: {
      async connect() {
        throw new Error('cdp offline');
      },
    },
    stealthPuppeteer: {
      async launch(options) {
        launchOptions = options;
        return {
          on() {},
          async close() {
            closed = true;
          },
        };
      },
    },
  });

  await service.browser();
  await service.close();

  assert.equal(launchOptions.headless, false);
  assert.equal(launchOptions.channel, 'chrome');
  assert.deepEqual(launchOptions.args.slice(0, 2), [ '--no-sandbox', '--disable-setuid-sandbox' ]);
  assert.equal(closed, true);
});
