'use strict';

import { PluginInterface } from '../plugins/index.mjs';

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_LINKS = 25;

export class WebFetchTool extends PluginInterface {
  static pluginID = 'internal:web';
  static featureName = 'fetch';
  static displayName = 'Web fetch';
  static description = 'Fetch and render a public web page with Puppeteer.';
  static riskLevel = 'none';
  static inputSchema = {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'HTTP or HTTPS URL to open.',
      },
      selector: {
        type: 'string',
        description: 'Optional CSS selector to extract instead of the full page body.',
      },
      timeoutMs: {
        type: 'integer',
        minimum: 1000,
        maximum: 60000,
        description: 'Navigation timeout in milliseconds.',
      },
      maxTextLength: {
        type: 'integer',
        minimum: 1000,
        description: 'Optional maximum visible text characters to return. Omit this to return all rendered text.',
      },
      maxLinks: {
        type: 'integer',
        minimum: 0,
        maximum: 100,
        description: 'Maximum page links to return.',
      },
    },
    required: [ 'url' ],
    additionalProperties: false,
  };
  static help = 'Use web-fetch after web-search when you need rendered page text, page title, final URL, or links from a specific URL.';

  async _execute(params = {}) {
    let url = normalizeHTTPURL(params.url);
    let selector = normalizeOptionalString(params.selector);
    let timeoutMs = clampInteger(params.timeoutMs, DEFAULT_TIMEOUT_MS, 1000, 60000);
    let maxTextLength = normalizeOptionalPositiveInteger(params.maxTextLength);
    let maxLinks = clampInteger(params.maxLinks, DEFAULT_MAX_LINKS, 0, 100);
    let browserService = resolveBrowserService(this.context);

    return await browserService.withPage(async (page, browserInfo = {}) => {
      await configurePage(page, timeoutMs);
      let response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: timeoutMs,
      });

      if (selector)
        await page.waitForSelector?.(selector, { timeout: Math.min(timeoutMs, 10000) });

      let extracted = await page.evaluate(extractPageSnapshot, {
        selector,
        maxTextLength,
        maxLinks,
      });

      return {
        requestedURL: url,
        finalURL: extracted.url,
        title: extracted.title,
        status: typeof response?.status === 'function' ? response.status() : null,
        browserMode: browserInfo.mode || '',
        selector,
        text: extracted.text,
        textTruncated: extracted.textTruncated,
        links: extracted.links,
      };
    });
  }
}

async function configurePage(page, timeoutMs) {
  page.setDefaultNavigationTimeout?.(timeoutMs);
  page.setDefaultTimeout?.(timeoutMs);
  await page.setUserAgent?.('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari/537.36 Kikx/0.1');
}

function extractPageSnapshot({ selector, maxTextLength, maxLinks }) {
  function normalizeText(value) {
    return String(value || '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
  }

  let root = selector ? document.querySelector(selector) : document.body;
  let target = root || document.body || document.documentElement;
  let fullText = normalizeText(target?.innerText || target?.textContent || '');
  let links = Array.from(document.querySelectorAll('a[href]'))
    .map((link) => ({
      text: normalizeText(link.innerText || link.textContent || '').slice(0, 200),
      url: link.href,
    }))
    .filter((link) => link.url)
    .slice(0, maxLinks);

  return {
    title: document.title || '',
    url: location.href,
    text: maxTextLength == null ? fullText : fullText.slice(0, maxTextLength),
    textTruncated: maxTextLength == null ? false : fullText.length > maxTextLength,
    links,
  };
}

function normalizeRenderedText(value) {
  return String(value || '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function resolveBrowserService(context = {}) {
  let service = context.webBrowser || context.services?.webBrowser || resolveContextService(context, 'webBrowser');
  if (!service?.withPage)
    throw new Error('web-fetch requires a webBrowser service');

  return service;
}

function resolveContextService(context, name) {
  let appContext = context.services?.context || context.context;
  if (appContext?.has?.(name) && typeof appContext.require === 'function')
    return appContext.require(name);

  if (typeof appContext?.require === 'function') {
    try {
      return appContext.require(name);
    } catch (_error) {
      return null;
    }
  }

  return null;
}

function normalizeHTTPURL(value) {
  if (typeof value !== 'string' || value.trim() === '')
    throw new TypeError('url must be a non-empty string');

  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch (error) {
    throw new TypeError(`url must be an absolute HTTP or HTTPS URL: ${error.message}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    throw new TypeError('url must use http or https');

  return parsed.href;
}

function normalizeOptionalString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function clampInteger(value, defaultValue, min, max) {
  let number = Number(value);
  if (!Number.isFinite(number))
    number = defaultValue;

  number = Math.trunc(number);
  return Math.min(max, Math.max(min, number));
}

function normalizeOptionalPositiveInteger(value) {
  if (value == null || value === '')
    return null;

  let number = Number(value);
  if (!Number.isFinite(number) || number < 1)
    throw new TypeError('maxTextLength must be a positive integer');

  return Math.trunc(number);
}
