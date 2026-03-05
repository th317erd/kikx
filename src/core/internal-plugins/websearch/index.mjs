'use strict';

import { htmlToMarkdown } from './html-to-markdown.mjs';

// =============================================================================
// Websearch Plugin
// =============================================================================
// Uses Puppeteer (headless Chrome) to render a web page, then converts
// the rendered HTML to markdown via Turndown for agent consumption.
// =============================================================================

export function setup({ registerTool, PluginInterface }) {
  class WebsearchTool extends PluginInterface {
    static pluginId    = 'websearch';
    static featureName = 'fetch';
    static displayName = 'Web Search';
    static description = 'Fetch and render web pages as markdown';
    static inputSchema = {
      type:       'object',
      properties: {
        url: { type: 'string', description: 'The URL to fetch and render' },
      },
      required: ['url'],
    };

    async _execute({ url }) {
      if (!url || typeof url !== 'string')
        throw new Error('url is required');

      let puppeteer;

      try {
        puppeteer = await import('puppeteer');
      } catch (error) {
        throw new Error(`Puppeteer not available: ${error.message}`);
      }

      let browser = null;

      try {
        browser = await puppeteer.default.launch({
          headless: 'new',
          args:     ['--no-sandbox', '--disable-setuid-sandbox'],
        });

        let page = await browser.newPage();

        // Set reasonable viewport and timeout
        await page.setViewport({ width: 1280, height: 800 });
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });

        // Extract page title and body HTML
        let title = await page.title();
        let html  = await page.evaluate(() => document.body.innerHTML);

        // Convert to markdown
        let markdown = htmlToMarkdown(html);

        return { markdown, title, url };
      } finally {
        if (browser)
          await browser.close();
      }
    }

    getHelp() {
      return {
        ...super.getHelp(),
        inputSchema: WebsearchTool.inputSchema,
        usage:       'websearch:fetch { url: "https://example.com" }',
        examples:    [
          { url: 'https://example.com',         description: 'Fetch and render a web page as markdown' },
          { url: 'https://docs.example.com/api', description: 'Fetch API documentation for reference' },
        ],
      };
    }
  }

  registerTool('websearch:fetch', WebsearchTool);

  return () => {};
}
