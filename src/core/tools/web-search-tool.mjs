'use strict';

import { PluginInterface } from '../plugins/index.mjs';

const DUCKDUCKGO_API_URL = 'https://api.duckduckgo.com/';
const DUCKDUCKGO_HTML_URL = 'https://html.duckduckgo.com/html/';
const DEFAULT_MAX_RESULTS = 8;
const MAX_RESULTS_LIMIT = 20;
const DEFAULT_TIMEOUT_MS = 10000;

export class WebSearchTool extends PluginInterface {
  static pluginID = 'internal:web';
  static featureName = 'search';
  static displayName = 'Web search';
  static description = 'Search DuckDuckGo instant answers and related topics.';
  static riskLevel = 'none';
  static inputSchema = {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query.',
      },
      maxResults: {
        type: 'integer',
        minimum: 1,
        maximum: MAX_RESULTS_LIMIT,
        description: 'Maximum number of search results to return.',
      },
      timeoutMs: {
        type: 'integer',
        minimum: 1000,
        maximum: 30000,
        description: 'HTTP timeout in milliseconds.',
      },
    },
    required: [ 'query' ],
    additionalProperties: false,
  };
  static help = 'Use web-search to find current public web information. Follow useful URLs with web-fetch when page details matter.';

  async _execute(params = {}) {
    let query = normalizeRequiredString(params.query, 'query');
    let maxResults = clampInteger(params.maxResults, DEFAULT_MAX_RESULTS, 1, MAX_RESULTS_LIMIT);
    let timeoutMs = clampInteger(params.timeoutMs, DEFAULT_TIMEOUT_MS, 1000, 30000);
    let fetchImpl = resolveFetch(this.context);

    let url = new URL(DUCKDUCKGO_API_URL);
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'json');
    url.searchParams.set('no_html', '1');
    url.searchParams.set('skip_disambig', '1');

    let data = await fetchDuckDuckGoJSON(fetchImpl, url, timeoutMs, { query });
    let normalized = normalizeDuckDuckGoResults(data, {
      query,
      maxResults,
    });

    if (normalized.results.length >= maxResults)
      return normalized;

    let htmlResults;
    try {
      htmlResults = await fetchDuckDuckGoHTMLResults(fetchImpl, {
        query,
        timeoutMs,
        maxResults,
      });
    } catch (error) {
      if (normalized.results.length > 0)
        return { ...normalized, warning: error.message };

      throw error;
    }

    if (htmlResults.length === 0)
      return normalized;

    let results = mergeSearchResults(normalized.results, htmlResults, maxResults);
    return {
      ...normalized,
      source: normalized.results.length > 0
        ? 'duckduckgo-instant-answer+html'
        : 'duckduckgo-html',
      results,
      resultCount: results.length,
    };
  }
}

async function fetchDuckDuckGoJSON(fetchImpl, url, timeoutMs, { query }) {
  let controller = new AbortController();
  let timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();

  try {
    let response = await fetchImpl(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Kikx/0.1 (+https://aeor.dev)',
      },
      signal: controller.signal,
    });

    if (!response?.ok)
      throw new Error(`DuckDuckGo HTTP ${response?.status || 'error'}`);

    let text = await response.text();
    if (!text.trim())
      throw new Error(`DuckDuckGo returned an empty response for query: ${query}`);

    try {
      return JSON.parse(text);
    } catch (error) {
      throw new Error(`DuckDuckGo returned malformed JSON for query "${query}": ${error.message}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchDuckDuckGoHTMLResults(fetchImpl, { query, timeoutMs, maxResults }) {
  let url = new URL(DUCKDUCKGO_HTML_URL);
  url.searchParams.set('q', query);

  let controller = new AbortController();
  let timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();

  try {
    let response = await fetchImpl(url, {
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari/537.36 Kikx/0.1',
      },
      signal: controller.signal,
    });

    if (!response?.ok)
      throw new Error(`DuckDuckGo HTML HTTP ${response?.status || 'error'}`);

    let html = await response.text();
    if (!html.trim())
      throw new Error(`DuckDuckGo HTML returned an empty response for query: ${query}`);

    return parseDuckDuckGoHTMLResults(html, { maxResults });
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeDuckDuckGoResults(data, { query, maxResults }) {
  let results = [];

  pushResult(results, {
    type: 'abstract',
    title: data?.Heading,
    text: data?.AbstractText || data?.Abstract,
    url: data?.AbstractURL,
    source: data?.AbstractSource,
  });

  pushResult(results, {
    type: 'answer',
    title: data?.Heading || 'Answer',
    text: data?.Answer,
  });

  pushResult(results, {
    type: 'definition',
    title: data?.Heading || 'Definition',
    text: data?.Definition,
    url: data?.DefinitionURL,
    source: data?.DefinitionSource,
  });

  for (let item of flattenDuckDuckGoTopics(data?.Results))
    pushDuckDuckGoTopic(results, item, 'result');

  for (let item of flattenDuckDuckGoTopics(data?.RelatedTopics))
    pushDuckDuckGoTopic(results, item, 'related-topic');

  return {
    query,
    source: 'duckduckgo-instant-answer',
    heading: stringOrEmpty(data?.Heading),
    answerType: stringOrEmpty(data?.AnswerType),
    results: results.slice(0, maxResults),
    resultCount: Math.min(results.length, maxResults),
  };
}

function parseDuckDuckGoHTMLResults(html, { maxResults }) {
  let results = [];
  let anchorPattern = /<a\b[^>]*class=(["'])[^"']*\bresult__a\b[^"']*\1[^>]*href=(["'])(.*?)\2[^>]*>([\s\S]*?)<\/a>/gi;
  let matches = [...String(html || '').matchAll(anchorPattern)];

  for (let index = 0; index < matches.length && results.length < maxResults; index++) {
    let match = matches[index];
    let blockEnd = matches[index + 1]?.index ?? html.length;
    let block = html.slice(match.index, blockEnd);
    let snippetMatch = /<a\b[^>]*class=(["'])[^"']*\bresult__snippet\b[^"']*\1[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    let url = normalizeDuckDuckGoHTMLURL(match[3]);
    let title = decodeHTMLText(stripTags(match[4]));
    let text = decodeHTMLText(stripTags(snippetMatch?.[2] || ''));

    pushResult(results, {
      type: 'result',
      title,
      text,
      url,
      source: hostnameFromURL(url),
    });
  }

  return results;
}

function mergeSearchResults(primary, secondary, maxResults) {
  let results = [];
  for (let item of [ ...primary, ...secondary ])
    pushResult(results, item);

  return results.slice(0, maxResults);
}

function pushDuckDuckGoTopic(results, item, type) {
  pushResult(results, {
    type,
    title: item.Name || item.Result,
    text: item.Text,
    url: item.FirstURL,
    iconURL: item.Icon?.URL,
  });
}

function pushResult(results, item) {
  let text = stripTags(item.text || '');
  let url = stringOrEmpty(item.url);
  if (!text && !url)
    return;

  let title = stripTags(item.title || '') || text.split(/\s+/g).slice(0, 8).join(' ');
  let result = {
    type: item.type || 'result',
    title,
    text,
  };

  if (url)
    result.url = url;

  if (item.source)
    result.source = stringOrEmpty(item.source);

  if (item.iconURL)
    result.iconURL = absolutizeDuckDuckGoAsset(item.iconURL);

  if (!results.some((existing) => existing.url && existing.url === result.url))
    results.push(result);
}

function flattenDuckDuckGoTopics(items) {
  let flattened = [];
  for (let item of Array.isArray(items) ? items : []) {
    if (Array.isArray(item?.Topics)) {
      flattened.push(...flattenDuckDuckGoTopics(item.Topics).map((topic) => ({
        ...topic,
        Name: topic.Name || item.Name,
      })));
      continue;
    }

    flattened.push(item);
  }

  return flattened;
}

function resolveFetch(context = {}) {
  let fetchImpl = context.fetchImpl || context.services?.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function')
    throw new Error('web-search requires fetch');

  return fetchImpl;
}

function normalizeRequiredString(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '')
    throw new TypeError(`${fieldName} must be a non-empty string`);

  return value.trim();
}

function clampInteger(value, defaultValue, min, max) {
  let number = Number(value);
  if (!Number.isFinite(number))
    number = defaultValue;

  number = Math.trunc(number);
  return Math.min(max, Math.max(min, number));
}

function stripTags(value) {
  return stringOrEmpty(value).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

function stringOrEmpty(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function decodeHTMLText(value) {
  return stringOrEmpty(value).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (_match, entity) => {
    let lower = entity.toLowerCase();
    if (lower === 'amp')
      return '&';
    if (lower === 'lt')
      return '<';
    if (lower === 'gt')
      return '>';
    if (lower === 'quot')
      return '"';
    if (lower === 'apos' || lower === '#39')
      return "'";
    if (lower.startsWith('#x')) {
      let codePoint = Number.parseInt(lower.slice(2), 16);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : '';
    }
    if (lower.startsWith('#')) {
      let codePoint = Number.parseInt(lower.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : '';
    }

    return `&${entity};`;
  });
}

function normalizeDuckDuckGoHTMLURL(value) {
  let text = decodeHTMLText(value);
  if (!text)
    return '';

  let parsed;
  try {
    if (text.startsWith('//'))
      parsed = new URL(`https:${text}`);
    else
      parsed = new URL(text, 'https://duckduckgo.com');
  } catch (_error) {
    return text;
  }

  if (/duckduckgo\.com$/i.test(parsed.hostname) && parsed.pathname === '/l/') {
    let target = parsed.searchParams.get('uddg');
    if (target)
      return target;
  }

  return parsed.href;
}

function hostnameFromURL(value) {
  try {
    return new URL(value).hostname.replace(/^www\./i, '');
  } catch (_error) {
    return '';
  }
}

function absolutizeDuckDuckGoAsset(value) {
  let text = stringOrEmpty(value);
  if (!text)
    return '';

  if (/^https?:\/\//i.test(text))
    return text;

  if (text.startsWith('/'))
    return `https://duckduckgo.com${text}`;

  return text;
}
