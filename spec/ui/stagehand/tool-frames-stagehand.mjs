'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { Stagehand } from '@browserbasehq/stagehand';

import {
  findChromeExecutable,
  loadStagehandOpenAIAPIKey,
  startStagehandUIServer,
} from './stagehand-test-utils.mjs';

test('Stagehand collapses tool start and result frames into one plugin-rendered message', async (t) => {
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
  let outputCalls = [];

  let fixture = await startStagehandUIServer({
    sessions: [
      { id: 'session_1', title: 'Tool Frames', messageCount: 0 },
    ],
    toolOutputStore: {
      async storeToolOutput() {
        throw new Error('stagehand tool output fixture should not store output');
      },
      async getToolOutput(input) {
        outputCalls.push(input);
        return {
          id: input.id,
          toolName: 'exec',
          format: 'json',
          sizeBytes: 256,
          start: 0,
          end: 256,
          returnedBytes: 256,
          truncated: false,
          content: JSON.stringify({
            command: 'ls /tmp',
            cwd: '/home/wyatt/Projects/kikx-workspace/kikx',
            status: 'completed',
            exitCode: 0,
            durationMs: 12,
            stdout: 'alpha.txt\nbeta.log\n',
            stderr: '',
          }),
        };
      },
    },
  });
  fixture.frameRuntime.framesBySessionID.set('session_1', createToolFrames());

  let stagehand = new Stagehand({
    env: 'LOCAL',
    model: process.env.KIKX_STAGEHAND_MODEL || 'openai/gpt-4.1-mini',
    verbose: 0,
    domSettleTimeout: 750,
    localBrowserLaunchOptions: {
      headless: process.env.KIKX_STAGEHAND_HEADLESS === '0' ? false : true,
      executablePath: chromePath,
      chromiumSandbox: false,
      viewport: { width: 1280, height: 720 },
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
    await page.waitForSelector('kikx-web-search-use', { timeout: 10000 });
    await page.waitForSelector('kikx-fetch-use', { timeout: 10000 });
    await page.waitForSelector('kikx-session-tool-use', { timeout: 10000 });
    await page.waitForSelector('kikx-shell-tool-use.kikx-tool-card--result', { timeout: 10000 });

    let searchCallText = await page.locator('kikx-web-search-use').first().textContent();
    let fetchCallText = await page.locator('kikx-fetch-use').first().textContent();
    let sessionToolTexts = await page.evaluate(() => Array.from(document.querySelectorAll('kikx-session-tool-use'))
      .map((node) => node.textContent || ''));
    let resultText = await page.locator('kikx-shell-tool-use.kikx-tool-card--result').first().textContent();
    let frameIDs = await page.evaluate(() => Array.from(document.querySelectorAll('kikx-frame-item'))
      .map((node) => node.dataset.frameId));

    assert.deepEqual(frameIDs, [ 'tool_call_1', 'tool_call_2', 'tool_call_3', 'tool_call_4', 'tool_call_5', 'tool_call_6' ]);
    assert.match(searchCallText, /Searching for hottest pokemon\.\.\./);
    assert.match(fetchCallText, /Fetching URL: https:\/\/example\.com\/weather\.\.\./);
    assert.ok(sessionToolTexts.some((text) => /Listing agents\.\.\./.test(text)));
    assert.ok(sessionToolTexts.some((text) => /Listing sessions\.\.\./.test(text)));
    assert.ok(sessionToolTexts.some((text) => /Inviting agents to session: session_child/.test(text)));
    assert.match(resultText, /Result/);
    assert.match(resultText, /Output OUT1/);
    assert.match(resultText, /Command completed: ls \/tmp/);
    assert.doesNotMatch(resultText, /alpha\.txt/);
    assert.equal(outputCalls.length, 0);

    await page.locator('kikx-shell-tool-use.kikx-tool-card--result details summary').first().click();
    await page.waitForSelector('kikx-shell-tool-use.kikx-tool-card--result .kikx-tool-output--exec', { timeout: 10000 });

    let expandedText = await page.locator('kikx-shell-tool-use.kikx-tool-card--result').first().textContent();
    assert.match(expandedText, /stdout/);
    assert.match(expandedText, /alpha\.txt/);
    assert.match(expandedText, /beta\.log/);
    assert.deepEqual(outputCalls, [{
      id: 'OUT1',
      start: null,
      end: null,
      maxBytes: 128 * 1024,
    }]);
  } finally {
    await stagehand.close().catch(() => {});
    await fixture.close().catch(() => {});
    if (previousOpenAIAPIKey == null)
      delete process.env.OPENAI_API_KEY;
    else
      process.env.OPENAI_API_KEY = previousOpenAIAPIKey;
  }
});

test('Stagehand places a completed tool-using agent summary after its tool frames', async (t) => {
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
      { id: 'session_1', title: 'Tool Ordering', messageCount: 0 },
    ],
  });
  fixture.frameRuntime.framesBySessionID.set('session_1', createUpdatedResponseToolFrames());

  let stagehand = new Stagehand({
    env: 'LOCAL',
    model: process.env.KIKX_STAGEHAND_MODEL || 'openai/gpt-4.1-mini',
    verbose: 0,
    domSettleTimeout: 750,
    localBrowserLaunchOptions: {
      headless: process.env.KIKX_STAGEHAND_HEADLESS === '0' ? false : true,
      executablePath: chromePath,
      chromiumSandbox: false,
      viewport: { width: 1280, height: 720 },
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
    await page.waitForSelector('kikx-frame-item[data-frame-id="agent_response_1"]', { timeout: 10000 });
    await page.waitForSelector('kikx-frame-item[data-frame-id="tool_call_1"]', { timeout: 10000 });
    await page.waitForSelector('kikx-shell-tool-use.kikx-tool-card--result', { timeout: 10000 });

    let frameIDs = await page.evaluate(() => Array.from(document.querySelectorAll('kikx-frame-item'))
      .map((node) => node.dataset.frameId));

    assert.deepEqual(frameIDs, [ 'tool_call_1', 'agent_response_1' ]);
  } finally {
    await stagehand.close().catch(() => {});
    await fixture.close().catch(() => {});
    if (previousOpenAIAPIKey == null)
      delete process.env.OPENAI_API_KEY;
    else
      process.env.OPENAI_API_KEY = previousOpenAIAPIKey;
  }
});

function createToolFrames() {
  return [
    {
      id: 'tool_call_1',
      type: 'ShellToolFrame',
      sessionID: 'session_1',
      interactionID: 'interaction_1',
      parentID: 'agent_response_1',
      authorType: 'agent',
      authorID: 'agent_1',
      authorDisplayName: 'Test Agent',
      hidden: false,
      deleted: false,
      order: 1,
      createdAt: 1781035260000000,
      updatedAt: 1781035260000000,
      content: {
        toolName: 'exec',
        phase: 'call',
        status: 'running',
        input: {
          command: 'ls /tmp',
        },
      },
    },
    {
      id: 'tool_call_2',
      type: 'WebSearchToolFrame',
      sessionID: 'session_1',
      interactionID: 'interaction_1',
      parentID: 'agent_response_1',
      authorType: 'agent',
      authorID: 'agent_1',
      authorDisplayName: 'Test Agent',
      hidden: false,
      deleted: false,
      order: 2,
      createdAt: 1781035260500000,
      updatedAt: 1781035260500000,
      content: {
        toolName: 'web-search',
        phase: 'call',
        status: 'running',
        input: {
          query: 'hottest pokemon',
        },
      },
    },
    {
      id: 'tool_call_3',
      type: 'FetchToolFrame',
      sessionID: 'session_1',
      interactionID: 'interaction_1',
      parentID: 'agent_response_1',
      authorType: 'agent',
      authorID: 'agent_1',
      authorDisplayName: 'Test Agent',
      hidden: false,
      deleted: false,
      order: 3,
      createdAt: 1781035260750000,
      updatedAt: 1781035260750000,
      content: {
        toolName: 'web-fetch',
        phase: 'call',
        status: 'running',
        input: {
          url: 'https://example.com/weather',
        },
      },
    },
    {
      id: 'tool_result_1',
      type: 'ShellToolFrame',
      sessionID: 'session_1',
      interactionID: 'interaction_1',
      parentID: 'tool_call_1',
      authorType: 'tool',
      authorID: 'exec',
      authorDisplayName: 'exec',
      hidden: false,
      deleted: false,
      order: 4,
      createdAt: 1781035261000000,
      updatedAt: 1781035261000000,
      content: {
        toolName: 'exec',
        phase: 'result',
        status: 'success',
        input: {
          command: 'ls /tmp',
        },
        toolOutputID: 'OUT1',
        sizeBytes: 256,
        format: 'json',
        preview: '{"stdout":"alpha.txt\\nbeta.log\\n"}',
        retrieval: {
          getRange: {
            tool: 'output-read',
            arguments: {
              id: 'OUT1',
              start: 0,
              end: 256,
            },
          },
        },
      },
    },
    {
      id: 'tool_call_4',
      type: 'AgentListToolFrame',
      sessionID: 'session_1',
      interactionID: 'interaction_1',
      parentID: 'agent_response_1',
      authorType: 'agent',
      authorID: 'agent_1',
      authorDisplayName: 'Test Agent',
      hidden: false,
      deleted: false,
      order: 5,
      createdAt: 1781035261250000,
      updatedAt: 1781035261250000,
      content: {
        toolName: 'agent-list',
        phase: 'call',
        status: 'running',
        input: {
          limit: 20,
        },
      },
    },
    {
      id: 'tool_call_5',
      type: 'SessionListToolFrame',
      sessionID: 'session_1',
      interactionID: 'interaction_1',
      parentID: 'agent_response_1',
      authorType: 'agent',
      authorID: 'agent_1',
      authorDisplayName: 'Test Agent',
      hidden: false,
      deleted: false,
      order: 6,
      createdAt: 1781035261500000,
      updatedAt: 1781035261500000,
      content: {
        toolName: 'session-list',
        phase: 'call',
        status: 'running',
        input: {
          limit: 20,
        },
      },
    },
    {
      id: 'tool_call_6',
      type: 'SessionInviteAgentsToolFrame',
      sessionID: 'session_1',
      interactionID: 'interaction_1',
      parentID: 'agent_response_1',
      authorType: 'agent',
      authorID: 'agent_1',
      authorDisplayName: 'Test Agent',
      hidden: false,
      deleted: false,
      order: 7,
      createdAt: 1781035261750000,
      updatedAt: 1781035261750000,
      content: {
        toolName: 'session-invite-agents',
        phase: 'call',
        status: 'running',
        input: {
          session_id: 'session_child',
          agents: [ 'Worker One', 'Worker Two' ],
        },
      },
    },
  ];
}

function createUpdatedResponseToolFrames() {
  return [
    {
      id: 'tool_call_1',
      type: 'ShellToolFrame',
      sessionID: 'session_1',
      interactionID: 'interaction_1',
      parentID: 'agent_response_1',
      authorType: 'agent',
      authorID: 'agent_1',
      authorDisplayName: 'Test Agent',
      hidden: false,
      deleted: false,
      order: 2,
      commitOrder: 2,
      createdClock: '1781035261000000-000000-stagehand',
      updatedClock: '1781035261000000-000000-stagehand',
      createdAt: 1781035261000000,
      updatedAt: 1781035261000000,
      content: {
        toolName: 'exec',
        phase: 'call',
        status: 'running',
        input: {
          command: 'ls /tmp',
        },
      },
    },
    {
      id: 'tool_result_1',
      type: 'ShellToolFrame',
      sessionID: 'session_1',
      interactionID: 'interaction_1',
      parentID: 'tool_call_1',
      authorType: 'tool',
      authorID: 'exec',
      authorDisplayName: 'exec',
      hidden: false,
      deleted: false,
      order: 3,
      commitOrder: 3,
      createdClock: '1781035262000000-000000-stagehand',
      updatedClock: '1781035262000000-000000-stagehand',
      createdAt: 1781035262000000,
      updatedAt: 1781035262000000,
      content: {
        toolName: 'exec',
        phase: 'result',
        status: 'success',
        preview: 'tmp listing',
      },
    },
    {
      id: 'agent_response_1',
      type: 'AgentMessage',
      sessionID: 'session_1',
      interactionID: 'interaction_1',
      parentID: 'user_1',
      authorType: 'agent',
      authorID: 'agent_1',
      authorDisplayName: 'Test Agent',
      hidden: false,
      deleted: false,
      order: 1,
      commitOrder: 4,
      createdClock: '1781035260000000-000000-stagehand',
      updatedClock: '1781035263000000-000000-stagehand',
      createdAt: 1781035260000000,
      updatedAt: 1781035263000000,
      content: {
        text: 'I will inspect /tmp before summarizing the result.',
        status: 'complete',
      },
    },
  ];
}
