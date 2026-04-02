'use strict';

import { htmlToMarkdown }        from './html-to-markdown.mjs';
import { WebsearchPermissions } from './websearch-permissions.mjs';

// =============================================================================
// Websearch Plugin
// =============================================================================
// Two tools:
//   websearch:fetch  — Fetch a URL and return content as markdown
//   websearch:search — Search the web via DuckDuckGo and return results
//
// Rendering strategy for websearch:fetch (in priority order):
//   1. Content negotiation — HEAD with Accept: text/markdown; if supported,
//      GET returns markdown directly (Cloudflare "Markdown for Agents", etc.)
//   2. Browser rendering — delegates to kikx-plugin-puppeteer via the
//      websearch:renderPage hook (headless Chrome + Turndown)
//   3. Plain HTTP — fetch() + Turndown conversion (no JS rendering)
//
// websearch:search requires the kikx-plugin-puppeteer plugin to scrape
// DuckDuckGo search results via the websearch:executeInBrowser hook.
// =============================================================================

const FETCH_TIMEOUT = 15000;

/**
 * @param {(cb: (ctx: { registry: any }) => void) => void} provide
 */
export function setup(provide) {
  provide(({ registry }) => {
    let PluginInterface = registry.getClass('PluginInterface');

    // ---------------------------------------------------------------------------
    // Helper: get hook handlers from registry via context
    // ---------------------------------------------------------------------------

    /**
     * @param {import('../../types').CascadingContext | null} context
     * @param {string} hookName
     * @returns {Function[]}
     */
    function getHookHandlers(context, hookName) {
      let reg = context && context.getProperty
        ? context.getProperty('pluginRegistry')
        : null;

      if (!reg)
        return [];

      return reg.getHookHandlers(hookName);
    }

    // ---------------------------------------------------------------------------
    // Helper: try Accept: text/markdown content negotiation
    // ---------------------------------------------------------------------------
    // Sends a HEAD request with Accept: text/markdown. If the server responds
    // with content-type text/markdown, follows up with a GET to retrieve the
    // pre-converted markdown directly — no browser or Turndown needed.

    /**
     * @param {string} url
     * @returns {Promise<{ markdown: string, title: string, url: string } | null>}
     */
    async function tryMarkdownNegotiation(url) {
      try {
        let headResponse = await fetch(url, {
          method:  'HEAD',
          headers: { 'Accept': 'text/markdown' },
          signal:  AbortSignal.timeout(FETCH_TIMEOUT),
        });

        let contentType = headResponse.headers.get('content-type') || '';

        if (!contentType.includes('text/markdown'))
          return null;

        // Server supports markdown — do the full GET
        let getResponse = await fetch(url, {
          headers: { 'Accept': 'text/markdown' },
          signal:  AbortSignal.timeout(FETCH_TIMEOUT),
        });

        if (!getResponse.ok)
          return null;

        let markdown = await getResponse.text();
        let title    = ''; // No title from plain HTTP — markdown content is self-describing

        return { markdown, title, url };
      } catch (_error) {
        // Network error, timeout, etc. — fall through to next strategy
        return null;
      }
    }

    // ---------------------------------------------------------------------------
    // Helper: plain HTTP fetch + Turndown (last resort, no JS rendering)
    // ---------------------------------------------------------------------------

    /**
     * @param {string} url
     * @returns {Promise<{ markdown: string, title: string, url: string }>}
     */
    async function plainFetch(url) {
      let response = await fetch(url, {
        headers: { 'Accept': 'text/html, text/markdown' },
        signal:  AbortSignal.timeout(FETCH_TIMEOUT),
      });

      if (!response.ok)
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);

      let contentType = response.headers.get('content-type') || '';
      let body        = await response.text();

      // If the server returned markdown directly, use it as-is
      if (contentType.includes('text/markdown'))
        return { markdown: body, title: '', url };

      // Otherwise convert HTML -> markdown
      let markdown = htmlToMarkdown(body);

      return { markdown, title: '', url };
    }

    // ---------------------------------------------------------------------------
    // websearch:fetch — Fetch and render a web page as markdown
    // ---------------------------------------------------------------------------

    class WebsearchFetchTool extends PluginInterface {
      static pluginID    = 'websearch';
      static featureName = 'fetch';
      static displayName = 'Fetch Page';
      static description = 'Fetch and render a web page as markdown';
      static inputSchema = {
        type:       'object',
        properties: {
          url: { type: 'string', description: 'The URL to fetch and render' },
        },
        required: ['url'],
      };

      getPermissionsClass() { return WebsearchPermissions; }

      /**
       * @param {{ url: string, _commitActivity?: (html: string) => Promise<void> }} params
       * @returns {Promise<{ markdown: string, title: string, url: string }>}
       */
      async _execute({ url, _commitActivity }) {
        if (!url || typeof url !== 'string')
          throw new Error('url is required');

        if (typeof _commitActivity === 'function')
          _commitActivity(`<span style="font-size:0.85rem;opacity:0.7">Fetching ${url.length > 60 ? url.slice(0, 60) + '...' : url}</span>`).catch(() => {});

        // Strategy 1: Content negotiation (Accept: text/markdown)
        let result = await tryMarkdownNegotiation(url);
        if (result)
          return result;

        // Strategy 2: Browser rendering via Puppeteer plugin hook
        let renderHandlers = getHookHandlers(this._context, 'websearch:renderPage');
        if (renderHandlers.length > 0) {
          let rendered = await renderHandlers[0]({ url, timeout: FETCH_TIMEOUT });

          if (rendered && rendered.html) {
            let markdown = htmlToMarkdown(rendered.html);
            return { markdown, title: rendered.title || '', url };
          }
        }

        // Strategy 3: Plain HTTP fetch + Turndown (no JS rendering)
        return await plainFetch(url);
      }

      getHelp() {
        return {
          ...super.getHelp(),
          inputSchema: WebsearchFetchTool.inputSchema,
          usage:       'websearch:fetch { url: "https://example.com" }',
          examples:    [
            { url: 'https://example.com',          description: 'Fetch and render a web page as markdown' },
            { url: 'https://docs.example.com/api', description: 'Fetch API documentation for reference' },
          ],
        };
      }
    }

    // ---------------------------------------------------------------------------
    // websearch:search — Search the web via DuckDuckGo
    // ---------------------------------------------------------------------------

    class WebsearchSearchTool extends PluginInterface {
      static pluginID    = 'websearch';
      static featureName = 'search';
      static displayName = 'Web Search';
      static description = 'Search the web using DuckDuckGo and return results';
      static inputSchema = {
        type:       'object',
        properties: {
          query: { type: 'string', description: 'The search query' },
          limit: { type: 'number', description: 'Maximum number of results to return (default: 5)' },
        },
        required: ['query'],
      };

      getPermissionsClass() { return WebsearchPermissions; }

      /**
       * @param {{ query: string, limit?: number, _commitActivity?: (html: string) => Promise<void> }} params
       * @returns {Promise<{ query: string, resultCount: number, results: Array<{ title: string, url: string, snippet: string }>, content: string }>}
       */
      async _execute({ query, limit, _commitActivity }) {
        if (!query || typeof query !== 'string')
          throw new Error('query is required');

        if (typeof _commitActivity === 'function')
          _commitActivity(`<span style="font-size:0.85rem;opacity:0.7">Searching: "${query.length > 50 ? query.slice(0, 50) + '...' : query}"</span>`).catch(() => {});

        let browserHandlers = getHookHandlers(this._context, 'websearch:executeInBrowser');

        if (browserHandlers.length === 0)
          throw new Error('websearch:search requires the kikx-plugin-puppeteer plugin. Install it to enable web search.');

        let resultLimit  = (typeof limit === 'number' && limit > 0) ? Math.min(limit, 20) : 5;
        let encodedQuery = encodeURIComponent(query);
        let searchUrl    = `https://html.duckduckgo.com/html/?q=${encodedQuery}`;

        let results = await browserHandlers[0](async (page) => {
          await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: FETCH_TIMEOUT });

          return await page.evaluate((maxResults) => {
            let items    = [];
            let links    = document.querySelectorAll('.result__a');
            let snippets = document.querySelectorAll('.result__snippet');

            for (let i = 0; i < Math.min(links.length, maxResults); i++) {
              let link    = links[i];
              let snippet = snippets[i];

              if (!link)
                continue;

              // Extract actual URL from DuckDuckGo's tracking wrapper
              let rawUrl   = link.href || '';
              let cleanUrl = rawUrl;

              if (rawUrl.includes('duckduckgo.com/l/?uddg=')) {
                try {
                  let urlObject    = new URL(rawUrl);
                  let unwrappedUrl = urlObject.searchParams.get('uddg');

                  if (unwrappedUrl)
                    cleanUrl = decodeURIComponent(unwrappedUrl);
                } catch (_error) {
                  // Keep original if parsing fails
                }
              }

              items.push({
                title:   (link.innerText || '').trim(),
                url:     cleanUrl,
                snippet: (snippet && snippet.innerText || '').trim(),
              });
            }

            return items;
          }, resultLimit);
        });

        let formattedResults = results.map((result, index) =>
          `${index + 1}. ${result.title}\n   URL: ${result.url}\n   ${result.snippet}`,
        ).join('\n\n');

        return {
          query,
          resultCount: results.length,
          results,
          content:     formattedResults,
        };
      }

      getHelp() {
        return {
          ...super.getHelp(),
          inputSchema: WebsearchSearchTool.inputSchema,
          usage:       'websearch:search { query: "how to bake bread" }',
          examples:    [
            { query: 'how to bake bread',      description: 'Search for baking instructions' },
            { query: 'node.js best practices', description: 'Search for Node.js best practices' },
            { query: 'weather San Francisco', limit: 3, description: 'Search with limited results' },
          ],
        };
      }
    }

    // Register both tools
    registry.registerTool('websearch:fetch',  WebsearchFetchTool);
    registry.registerTool('websearch:search', WebsearchSearchTool);
  });

  // No teardown needed — core websearch has no resources to clean up
  return () => {};
}
