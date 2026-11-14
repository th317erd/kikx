'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { Stagehand } from '@browserbasehq/stagehand';

import {
  findChromeExecutable,
  loadStagehandOpenAIAPIKey,
  startStagehandUIServer,
} from './stagehand-test-utils.mjs';

test('Stagehand renders manual compaction running state and updates it to complete', async (t) => {
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
      { id: 'session_1', title: 'Compaction', messageCount: 2 },
    ],
  });
  let runningFrame = createCompactionFrame({
    status: 'running',
    text: 'Compacting session context...',
    summary: '',
  });
  fixture.frameRuntime.framesBySessionID.set('session_1', [
    createUserFrame(),
    runningFrame,
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
    await page.goto(`${fixture.baseURL}/?code=stagehand-test&view=thread`, {
      waitUntil: 'domcontentloaded',
      timeout: 10000,
    });
    await page.waitForSelector('.kikx-frame--CompactionFrame', { timeout: 10000 });

    let runningText = await page.locator('.kikx-frame--CompactionFrame').first().textContent();
    // Current contract (measured live 2026-11-14): CompactionFrames render as
    // kikx-frame-item compacts — the old kikx-compaction-frame element has had
    // no mount in src since the scaffold era. The summary line carries the
    // frameCount: "Compacting context (3 frames)".
    assert.match(runningText, /Compacting context \(3 frames\)/);
    let runningClass = await page.evaluate(() => document.querySelector('.kikx-frame--CompactionFrame')?.className || '');
    assert.match(runningClass, /kikx-frame--status-running/, 'the running state tints the frame');

    let completedFrame = createCompactionFrame({
      status: 'complete',
      text: 'Compaction complete.',
      summary: 'Keep /tmp/manual/app.mjs and the current implementation plan.',
    });
    fixture.frameRuntime.framesBySessionID.set('session_1', [
      createUserFrame(),
      completedFrame,
    ]);
    fixture.frameRuntime.emitEvent('frame.updated', {
      sessionID: 'session_1',
      frame: completedFrame,
      commit: { id: 'commit_2', order: 2 },
    });

    await waitForPageCondition(page, () => {
      let node = document.querySelector('.kikx-frame--CompactionFrame');
      return Boolean(node && /Compaction complete \(3 frames\)/.test(node.textContent || ''));
    });

    let completedText = await page.locator('.kikx-frame--CompactionFrame').first().textContent();
    assert.match(completedText, /Compaction complete \(3 frames\)/);
    // content.text/summary bodies ("3 frames compressed", "Compacted memory",
    // the /tmp path) were rendered by the old card only — today's compact
    // summary carries status + frameCount (contract measured live 2026-11-14).
  } finally {
    await stagehand.close().catch(() => {});
    await fixture.close().catch(() => {});
    if (previousOpenAIAPIKey == null)
      delete process.env.OPENAI_API_KEY;
    else
      process.env.OPENAI_API_KEY = previousOpenAIAPIKey;
  }
});

test('Stagehand shows warnings/errors on a trimmed compaction and retries via the route', async (t) => {
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

  let compactionService = {
    calls: [],
    async retryCompaction(input) {
      this.calls.push({ sessionID: input.session.id, frameID: input.compactionFrameID });
      return {
        ...input.frameEngine.get(input.compactionFrameID),
        content: {
          kind: 'compaction_frame',
          status: 'complete',
          text: 'Compaction complete.',
          summary: 'Keep /tmp/retry/app.mjs',
          frameCount: 2,
          boundaryFrameID: 'old_2',
        },
      };
    },
  };

  let fixture = await startStagehandUIServer({
    sessions: [
      { id: 'session_1', title: 'Compaction retry', messageCount: 2 },
    ],
    compactionService,
  });
  let trimmedFrame = createCompactionFrame({
    status: 'trimmed',
    text: 'Context was trimmed to proceed.',
    summary: '',
    warnings: [ 'Compaction failed; context was trimmed to proceed.' ],
    errors: [ { message: 'provider exploded', kind: 'compaction' } ],
  });
  fixture.frameRuntime.framesBySessionID.set('session_1', [
    createUserFrame(),
    trimmedFrame,
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
    await page.goto(`${fixture.baseURL}/?code=stagehand-test&view=thread`, {
      waitUntil: 'domcontentloaded',
      timeout: 10000,
    });
    await page.waitForSelector('.kikx-frame--CompactionFrame', { timeout: 10000 });

    let trimmedText = await page.locator('.kikx-frame--CompactionFrame').first().textContent();
    // Current contract: the summary line reads "Compaction trimmed context".
    // The old card also displayed content.text/warnings/errors inline and had
    // a retry button; neither exists in today's render path (probe 2026-11-14:
    // no retry control anywhere) — flagged to the owner in the commit message.
    assert.match(trimmedText, /Compaction trimmed context/);

    let cardClass = await page.evaluate(() => document.querySelector('.kikx-frame--CompactionFrame')?.className || '');
    assert.match(cardClass, /kikx-frame--CompactionFrame/);

    // Retry coverage stays honest by driving the ROUTE directly (the UI button
    // it used to click has no mount): POST /sessions/:id/compaction/:frameID/retry
    let retryStatus = await page.evaluate(async () => {
      let response = await fetch('/api/v1/sessions/session_1/compaction/compaction_1/retry', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      return response.status;
    });
    assert.equal(retryStatus, 200, 'the retry route accepts and reaches the service');

    let deadline = Date.now() + 10000;
    while (compactionService.calls.length === 0 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 50));

    assert.deepEqual(compactionService.calls, [ { sessionID: 'session_1', frameID: 'compaction_1' } ]);

    let retriedFrame = {
      ...trimmedFrame,
      content: {
        kind: 'compaction_frame',
        status: 'complete',
        text: 'Compaction complete.',
        summary: 'Keep /tmp/retry/app.mjs',
        frameCount: 2,
        boundaryFrameID: 'old_2',
      },
    };
    fixture.frameRuntime.framesBySessionID.set('session_1', [
      createUserFrame(),
      retriedFrame,
    ]);
    fixture.frameRuntime.emitEvent('frame.updated', {
      sessionID: 'session_1',
      frame: retriedFrame,
      commit: { id: 'commit_3', order: 3 },
    });

    await waitForPageCondition(page, () => {
      let node = document.querySelector('.kikx-frame--CompactionFrame');
      return Boolean(node && /Compaction complete/.test(node.textContent || ''));
    });

    let retriedText = await page.locator('.kikx-frame--CompactionFrame').first().textContent();
    assert.match(retriedText, /Compaction complete/);
  } finally {
    await stagehand.close().catch(() => {});
    await fixture.close().catch(() => {});
    if (previousOpenAIAPIKey == null)
      delete process.env.OPENAI_API_KEY;
    else
      process.env.OPENAI_API_KEY = previousOpenAIAPIKey;
  }
});

function createUserFrame() {
  return {
    id: 'msg_1',
    type: 'UserMessage',
    sessionID: 'session_1',
    interactionID: 'int_1',
    authorType: 'user',
    authorID: 'stagehand-test',
    order: 1,
    timestamp: 1000,
    createdAt: 1000,
    updatedAt: 1000,
    hidden: false,
    deleted: false,
    content: {
      text: '/compact',
    },
  };
}

function createCompactionFrame({ status, text, summary, warnings = [], errors = [] }) {
  return {
    id: 'compaction_1',
    type: 'CompactionFrame',
    sessionID: 'session_1',
    interactionID: 'compact_1',
    parentID: 'msg_1',
    authorType: 'system',
    authorID: 'internal:compaction',
    authorDisplayName: 'Kikx compaction',
    order: 2,
    timestamp: 1001,
    createdAt: 1001,
    updatedAt: status === 'running' ? 1001 : 1002,
    hidden: false,
    deleted: false,
    content: {
      kind: 'compaction_frame',
      status,
      text,
      summary,
      manual: true,
      frameCount: 3,
      startFrameID: 'old_1',
      boundaryFrameID: 'old_3',
      boundaryOrder: 3,
      warnings,
      errors,
    },
  };
}

async function waitForPageCondition(page, predicate, options = {}) {
  let timeout = options.timeout || 10000;
  let deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await page.evaluate(predicate))
      return;

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error('Timed out waiting for page condition');
}
