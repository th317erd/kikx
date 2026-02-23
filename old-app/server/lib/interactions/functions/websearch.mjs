'use strict';

// ============================================================================
// Web Search Function
// ============================================================================
// Fetches web pages using a headless browser and returns the text content.
// Uses Puppeteer for headless Chrome/Chromium browsing.
//
// OPTIMIZATION: Uses a shared browser instance to avoid cold-start delays.

import { InteractionFunction, PERMISSION } from '../function.mjs';
import { htmlToMarkdown, getNoiseSelectors } from '../../html-to-markdown.mjs';

// ============================================================================
// Shared Browser Pool
// ============================================================================

let sharedBrowser = null;
let browserLaunchPromise = null;
let pageCount = 0;
const MAX_PAGES_BEFORE_RESTART = 50; // Restart browser after N pages to prevent memory leaks

/**
 * Get or create the shared browser instance.
 * Uses a launch promise to prevent multiple simultaneous launches.
 */
async function getSharedBrowser() {
  // If we have a healthy browser, return it
  if (sharedBrowser && sharedBrowser.isConnected()) {
    return sharedBrowser;
  }

  // If a launch is in progress, wait for it
  if (browserLaunchPromise) {
    return browserLaunchPromise;
  }

  // Launch a new browser
  browserLaunchPromise = (async () => {
    try {
      let puppeteer = await import('puppeteer');

      sharedBrowser = await puppeteer.default.launch({
        headless: 'new',
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-extensions',
          '--disable-background-networking',
          '--disable-default-apps',
          '--disable-sync',
          '--no-first-run',
        ],
      });

      pageCount = 0;
      console.log('Shared Puppeteer browser launched');

      // Handle browser disconnect
      sharedBrowser.on('disconnected', () => {
        console.log('Shared browser disconnected');
        sharedBrowser = null;
        browserLaunchPromise = null;
      });

      return sharedBrowser;
    } finally {
      browserLaunchPromise = null;
    }
  })();

  return browserLaunchPromise;
}

/**
 * Close the shared browser (call on shutdown).
 */
export async function closeSharedBrowser() {
  if (sharedBrowser) {
    try {
      await sharedBrowser.close();
    } catch (e) {
      // Ignore errors on close
    }
    sharedBrowser = null;
    browserLaunchPromise = null;
    console.log('Shared Puppeteer browser closed');
  }
}

// Clean up on process exit
process.on('exit', () => {
  if (sharedBrowser) {
    sharedBrowser.close().catch(() => {});
  }
});

process.on('SIGINT', async () => {
  await closeSharedBrowser();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await closeSharedBrowser();
  process.exit(0);
});

// ============================================================================
// WebSearchFunction Class
// ============================================================================

/**
 * WebSearch Function class.
 * Fetches a URL using a headless browser and returns the page content.
 */
export class WebSearchFunction extends InteractionFunction {
  /**
   * Register the websearch function with the interaction system.
   */
  static register() {
    return {
      name:        'websearch',
      description: 'Fetch web pages or search the web using a headless browser',
      target:      '@system',
      permission:  PERMISSION.ALWAYS,
      schema: {
        type:       'object',
        properties: {
          url: {
            type:        'string',
            description: 'URL to fetch directly',
          },
          query: {
            type:        'string',
            description: 'Search query (uses DuckDuckGo)',
          },
          limit: {
            type:        'number',
            description: 'Maximum number of search results to return (default: 5)',
            default:     5,
          },
          selector: {
            type:        'string',
            description: 'CSS selector for content extraction',
            default:     'body',
          },
          timeout: {
            type:        'number',
            description: 'Page load timeout in milliseconds',
            default:     10000,
          },
          waitForSelector: {
            type:        'boolean',
            description: 'Wait for selector before extracting content',
            default:     false,
          },
        },
        oneOf: [
          { required: ['url'] },
          { required: ['query'] },
        ],
      },
      examples: [
        {
          description: 'Fetch a specific URL',
          payload:     { url: 'https://example.com' },
        },
        {
          description: 'Search the web with limit',
          payload:     { query: 'best running shoes 2024', limit: 5 },
        },
      ],
      // Banner display config - only functions with this config show banners
      banner: {
        icon:       '🔍',
        label:      'Web Search',
        contentKey: 'query',  // payload key to display as content
      },
    };
  }

  constructor(context = {}) {
    super('websearch', context);
    this.page = null;
  }

  /**
   * Check if the websearch is allowed.
   */
  async allowed(payload, context = {}) {
    if (!payload) {
      return { allowed: false, reason: 'Payload is required' };
    }

    if (!payload.url && !payload.query) {
      return { allowed: false, reason: 'Either url or query is required' };
    }

    if (payload.url) {
      try {
        let url = new URL(payload.url.startsWith('http') ? payload.url : `https://${payload.url}`);

        if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
          return { allowed: false, reason: 'Cannot fetch localhost URLs' };
        }

        if (/^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.)/.test(url.hostname)) {
          return { allowed: false, reason: 'Cannot fetch private network URLs' };
        }
      } catch (e) {
        return { allowed: false, reason: `Invalid URL: ${e.message}` };
      }
    }

    return { allowed: true };
  }

  /**
   * Execute the web search.
   */
  async execute(params) {
    if (params.query) {
      return await this._search(params.query, params);
    }
    return await this._fetch(params.url, params);
  }

  /**
   * Fetch a URL and return its content.
   */
  async _fetch(url, options = {}) {
    let { selector = 'body', timeout = 10000, waitForSelector = false, maxLength = 8000 } = options;

    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'https://' + url;
    }

    let page;
    let startTime = Date.now();

    try {
      let browser = await getSharedBrowser();
      let browserTime = Date.now() - startTime;
      console.log(`[WebSearch] Browser ready in ${browserTime}ms`);

      page = await browser.newPage();
      this.page = page;
      pageCount++;

      // Set shorter timeouts
      page.setDefaultTimeout(timeout);
      page.setDefaultNavigationTimeout(timeout);

      await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      );

      await page.setViewport({ width: 1280, height: 800 });

      // Use domcontentloaded instead of networkidle2 (much faster)
      let navStartTime = Date.now();
      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout:   timeout,
      });
      let navTime = Date.now() - navStartTime;
      console.log(`[WebSearch] Page loaded in ${navTime}ms: ${url}`);

      if (waitForSelector && selector !== 'body') {
        await page.waitForSelector(selector, { timeout: timeout / 2 });
      }

      let extractStartTime = Date.now();

      // Get HTML and convert to markdown for better structure
      let noiseSelectors = getNoiseSelectors();
      let htmlContent = await page.evaluate((sel, noiseSelectors) => {
        // Remove noise elements first
        for (let noiseSel of noiseSelectors) {
          try {
            document.querySelectorAll(noiseSel).forEach((el) => el.remove());
          } catch (e) {
            // Ignore invalid selectors
          }
        }

        let element = document.querySelector(sel);
        if (!element) return null;
        return element.innerHTML;
      }, selector, noiseSelectors);

      // Convert HTML to clean markdown
      let content = htmlContent ? htmlToMarkdown(htmlContent, { maxLength }) : '';

      let title    = await page.title();
      let finalUrl = page.url();
      let extractTime = Date.now() - extractStartTime;
      console.log(`[WebSearch] Content extracted in ${extractTime}ms (${(content?.length || 0)} chars)`);

      let truncated = false;
      if (content && content.length > maxLength) {
        content   = content.slice(0, maxLength) + '\n\n[Content truncated...]';
        truncated = true;
      }

      let totalTime = Date.now() - startTime;
      console.log(`[WebSearch] Total fetch time: ${totalTime}ms`);

      return {
        success:   true,
        url:       finalUrl,
        title:     title,
        content:   content || '',
        selector:  selector,
        truncated: truncated,
        timing:    { totalMs: totalTime },
      };

    } catch (error) {
      let totalTime = Date.now() - startTime;
      console.log(`[WebSearch] Fetch failed after ${totalTime}ms: ${error.message}`);
      return {
        success: false,
        url:     url,
        error:   error.message,
      };

    } finally {
      if (page) {
        await page.close().catch(() => {});
        this.page = null;
      }

      // Restart browser if we've used too many pages (memory management)
      if (pageCount >= MAX_PAGES_BEFORE_RESTART) {
        closeSharedBrowser().catch(() => {});
      }
    }
  }

  /**
   * Perform a web search using DuckDuckGo.
   */
  async _search(query, options = {}) {
    let { limit = 5, timeout = 10000 } = options;

    let encodedQuery = encodeURIComponent(query);
    let searchUrl    = `https://html.duckduckgo.com/html/?q=${encodedQuery}`;

    let page;
    let startTime = Date.now();

    try {
      let browser = await getSharedBrowser();
      let browserTime = Date.now() - startTime;
      console.log(`[WebSearch] Browser ready for search in ${browserTime}ms`);

      page = await browser.newPage();
      this.page = page;
      pageCount++;

      page.setDefaultTimeout(timeout);
      page.setDefaultNavigationTimeout(timeout);

      await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      );

      // Use domcontentloaded for faster loading
      let navStartTime = Date.now();
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout });
      let navTime = Date.now() - navStartTime;
      console.log(`[WebSearch] Search page loaded in ${navTime}ms`);

      let extractStartTime = Date.now();
      let results = await page.evaluate((maxResults) => {
        let items    = [];
        let links    = document.querySelectorAll('.result__a');
        let snippets = document.querySelectorAll('.result__snippet');

        for (let i = 0; i < Math.min(links.length, maxResults); i++) {
          let link    = links[i];
          let snippet = snippets[i];

          if (link) {
            // Extract actual URL from DuckDuckGo's tracking URL
            let rawUrl = link.href || '';
            let cleanUrl = rawUrl;

            // DuckDuckGo wraps URLs like: https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com...
            if (rawUrl.includes('duckduckgo.com/l/?uddg=')) {
              try {
                let urlObj = new URL(rawUrl);
                let uddg = urlObj.searchParams.get('uddg');
                if (uddg) {
                  cleanUrl = decodeURIComponent(uddg);
                }
              } catch (e) {
                // Keep original if parsing fails
              }
            }

            items.push({
              title:   link.innerText?.trim() || '',
              url:     cleanUrl,
              snippet: snippet?.innerText?.trim() || '',
            });
          }
        }

        return items;
      }, limit);

      let extractTime = Date.now() - extractStartTime;
      console.log(`[WebSearch] Results extracted in ${extractTime}ms (${results.length} results)`);

      let formattedResults = results.map((r, i) =>
        `${i + 1}. ${r.title}\n   URL: ${r.url}\n   ${r.snippet}`
      ).join('\n\n');

      let totalTime = Date.now() - startTime;
      console.log(`[WebSearch] Total search time: ${totalTime}ms`);

      return {
        success:      true,
        query:        query,
        resultCount:  results.length,
        results:      results,
        content:      formattedResults,
        timing:       { totalMs: totalTime },
      };

    } catch (error) {
      let totalTime = Date.now() - startTime;
      console.log(`[WebSearch] Search failed after ${totalTime}ms: ${error.message}`);
      return {
        success: false,
        query:   query,
        error:   error.message,
      };

    } finally {
      if (page) {
        await page.close().catch(() => {});
        this.page = null;
      }

      if (pageCount >= MAX_PAGES_BEFORE_RESTART) {
        closeSharedBrowser().catch(() => {});
      }
    }
  }

  /**
   * Cancel the web search.
   */
  cancel(reason) {
    if (this.page) {
      this.page.close().catch(() => {});
      this.page = null;
    }
    return super.cancel(reason);
  }
}

/**
 * Fetch a web page and return its text content.
 */
export async function fetchWebPage(url, options = {}) {
  let func = new WebSearchFunction(options.context || {});
  return await func.start({ url, ...options });
}

/**
 * Search the web using a search engine.
 */
export async function searchWeb(query, options = {}) {
  let func = new WebSearchFunction(options.context || {});
  return await func.start({ query, ...options });
}

export default WebSearchFunction;
