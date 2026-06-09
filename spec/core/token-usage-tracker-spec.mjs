'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_TOKEN_USAGE_PATH,
  TokenUsageTracker,
  normalizeProviderUsage,
} from '../../src/core/tokens/index.mjs';

test('TokenUsageTracker loads existing usage and merge-patches token deltas', async () => {
  let aeordb = createClient();
  aeordb.files.set(DEFAULT_TOKEN_USAGE_PATH, {
    'openai/chatgpt/codex-agent': {
      tokensUsed: 10,
      createdAt: 'first',
      updatedAt: 'old',
    },
  });
  let tracker = new TokenUsageTracker({
    aeordb,
    clock: () => 'now',
  });
  let events = [];
  tracker.on('updated', (event) => events.push(event));

  assert.deepEqual(await tracker.load(), {
    'openai/chatgpt/codex-agent': {
      tokensUsed: 10,
      createdAt: 'first',
      updatedAt: 'old',
    },
  });

  let entry = await tracker.addTokens('openai/chatgpt/codex-agent', {
    inputTokens: 3,
    outputTokens: 4,
  });

  assert.deepEqual(entry, {
    tokensUsed: 17,
    createdAt: 'first',
    updatedAt: 'now',
  });
  assert.equal(tracker.totalTokensUsed(), 17);
  assert.deepEqual(aeordb.calls.at(-1), {
    method: 'patchFile',
    path: DEFAULT_TOKEN_USAGE_PATH,
    body: {
      'openai/chatgpt/codex-agent': {
        tokensUsed: 17,
        createdAt: 'first',
        updatedAt: 'now',
      },
    },
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].totalTokensUsed, 17);
});

test('TokenUsageTracker treats missing token file as empty and can create it on patch 404', async () => {
  let aeordb = createClient({ patchStatus: 404 });
  let tracker = new TokenUsageTracker({
    aeordb,
    clock: () => 1000,
  });

  assert.deepEqual(await tracker.load(), {});
  await tracker.addTokens('local/test/plugin', { tokensUsed: 5 });

  assert.deepEqual(aeordb.calls.map((call) => call.method), [ 'getFile', 'patchFile', 'putFile' ]);
  assert.deepEqual(aeordb.files.get(DEFAULT_TOKEN_USAGE_PATH), {
    'local/test/plugin': {
      tokensUsed: 5,
      createdAt: 1000,
      updatedAt: 1000,
    },
  });
});

test('TokenUsageTracker preserves constructor usage for memory-only trackers', async () => {
  let tracker = new TokenUsageTracker({
    usage: {
      'memory/test': {
        tokensUsed: 9,
        createdAt: 'first',
        updatedAt: 'first',
      },
    },
  });

  assert.deepEqual(await tracker.load(), {
    'memory/test': {
      tokensUsed: 9,
      createdAt: 'first',
      updatedAt: 'first',
    },
  });
});

test('normalizeProviderUsage accepts OpenAI-style usage shapes', () => {
  assert.deepEqual(normalizeProviderUsage({
    prompt_tokens: 11,
    completion_tokens: 7,
    serviceKey: 'openai/chatgpt/codex-agent',
  }), {
    inputTokens: 11,
    outputTokens: 7,
    readTokens: 11,
    writeTokens: 7,
    tokensUsed: 18,
    tracked: false,
    serviceKey: 'openai/chatgpt/codex-agent',
  });

  assert.equal(normalizeProviderUsage({ inputTokens: 0, outputTokens: 0 }), null);
});

function createClient(options = {}) {
  return {
    calls: [],
    files: new Map(),
    async getFile(path) {
      this.calls.push({ method: 'getFile', path });
      if (!this.files.has(path)) {
        let error = new Error(`missing: ${path}`);
        error.status = 404;
        throw error;
      }

      return this.files.get(path);
    },
    async patchFile(path, body) {
      this.calls.push({ method: 'patchFile', path, body });
      if (options.patchStatus) {
        let error = new Error('patch failed');
        error.status = options.patchStatus;
        throw error;
      }

      this.files.set(path, {
        ...(this.files.get(path) || {}),
        ...body,
      });
      return { path };
    },
    async putFile(path, body) {
      this.calls.push({ method: 'putFile', path, body });
      this.files.set(path, body);
      return { path };
    },
  };
}
