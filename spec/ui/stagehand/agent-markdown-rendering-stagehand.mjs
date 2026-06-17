'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { Stagehand } from '@browserbasehq/stagehand';

import {
  findChromeExecutable,
  loadStagehandOpenAIAPIKey,
  startStagehandUIServer,
} from './stagehand-test-utils.mjs';

test('Stagehand renders agent markdown without paragraph-heavy markup', async (t) => {
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
      { id: 'session_1', title: 'Markdown Render Smoke', messageCount: 1 },
    ],
    agents: [
      { id: 'agent_markdown', name: 'Markdown Bot', pluginID: 'test-agent', enabled: true },
    ],
  });
  fixture.frameRuntime.framesBySessionID.set('session_1', [
    {
      id: 'agent_msg_markdown',
      type: 'AgentMessage',
      sessionID: 'session_1',
      interactionID: 'interaction_1',
      authorType: 'agent',
      authorID: 'agent_markdown',
      authorDisplayName: 'Markdown Bot',
      hidden: false,
      deleted: false,
      order: 1,
      createdAt: 1000,
      updatedAt: 1000,
      content: {
        text: [
          '## Build Notes',
          'Hello **engineer**',
          '- inspect',
          '- patch',
          '',
          '```js',
          'const ok = true;',
          '```',
          '',
          '[docs](https://example.test/docs)',
          'Bare URL: https://example.test/bare?from=agent.',
          '<strong onclick="window.__kikxXSS=1">Safe HTML</strong>',
          '<a href="https://example.test/**not-bold**">Attribute Markdown</a>',
          '<p>Paragraph **markdown** should not create p tags.</p>',
          '<a href="javascript:alert(1)">unsafe link</a>',
        ].join('\n'),
      },
    },
  ]);

  let stagehand = new Stagehand({
    env: 'LOCAL',
    model: process.env.KIKX_STAGEHAND_MODEL || 'openai/gpt-4.1-mini',
    verbose: 0,
    domSettleTimeout: 750,
    localBrowserLaunchOptions: {
      headless: process.env.KIKX_STAGEHAND_HEADLESS === '0' ? false : true,
      executablePath: chromePath,
      chromiumSandbox: false,
      viewport: { width: 1280, height: 900 },
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
    await page.goto(`${fixture.baseURL}/?code=stagehand-test`, {
      waitUntil: 'domcontentloaded',
      timeout: 10000,
    });
    await page.waitForSelector('.kikx-frame--AgentMessage .kikx-markdown', { timeout: 10000 });

    let rendered = await page.evaluate(() => {
      let body = document.querySelector('.kikx-frame--AgentMessage .kikx-markdown');
      return {
        pCount: body.querySelectorAll('p').length,
        heading: body.querySelector('h2')?.textContent || '',
        strong: body.querySelector('strong')?.textContent || '',
        items: Array.from(body.querySelectorAll('li')).map((node) => node.textContent),
        code: body.querySelector('pre code')?.textContent || '',
        href: body.querySelector('a')?.getAttribute('href') || '',
        rel: body.querySelector('a')?.getAttribute('rel') || '',
        bareURL: Array.from(body.querySelectorAll('a')).find((node) => node.textContent === 'https://example.test/bare?from=agent')?.getAttribute('href') || '',
        bareURLText: Array.from(body.querySelectorAll('a')).find((node) => node.textContent === 'https://example.test/bare?from=agent')?.textContent || '',
        attributeMarkdownHref: Array.from(body.querySelectorAll('a')).find((node) => node.textContent === 'Attribute Markdown')?.getAttribute('href') || '',
        attributeMarkdownHTML: Array.from(body.querySelectorAll('a')).find((node) => node.textContent === 'Attribute Markdown')?.innerHTML || '',
        unsafeHrefs: Array.from(body.querySelectorAll('a')).map((node) => node.getAttribute('href')).filter((href) => href?.startsWith('javascript:')),
        eventAttrs: Array.from(body.querySelectorAll('*')).flatMap((node) => Array.from(node.attributes).filter((attr) => attr.name.startsWith('on')).map((attr) => attr.name)),
        safeHTML: Array.from(body.querySelectorAll('strong')).map((node) => node.textContent),
      };
    });

    assert.equal(rendered.pCount, 0);
    assert.equal(rendered.heading, 'Build Notes');
    assert.equal(rendered.strong, 'engineer');
    assert.deepEqual(rendered.items, [ 'inspect', 'patch' ]);
    assert.equal(rendered.code, 'const ok = true;');
    assert.equal(rendered.href, 'https://example.test/docs');
    assert.equal(rendered.rel, 'noopener noreferrer');
    assert.equal(rendered.bareURL, 'https://example.test/bare?from=agent');
    assert.equal(rendered.bareURLText, 'https://example.test/bare?from=agent');
    assert.equal(rendered.attributeMarkdownHref, 'https://example.test/**not-bold**');
    assert.equal(rendered.attributeMarkdownHTML, 'Attribute Markdown');
    assert.deepEqual(rendered.unsafeHrefs, []);
    assert.deepEqual(rendered.eventAttrs, []);
    assert.ok(rendered.safeHTML.includes('Safe HTML'));
    assert.ok(rendered.safeHTML.includes('markdown'));
  } finally {
    await stagehand.close().catch(() => {});
    await fixture.close().catch(() => {});
    if (previousOpenAIAPIKey == null)
      delete process.env.OPENAI_API_KEY;
    else
      process.env.OPENAI_API_KEY = previousOpenAIAPIKey;
  }
});
