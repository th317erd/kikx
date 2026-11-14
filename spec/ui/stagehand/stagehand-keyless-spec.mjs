'use strict';

// Keyless Ollama mode for Stagehand (owner, 2026-11-14: "Is it possible to
// use Ollama for Stagehand?"). RED-first pins for the loader contract:
//
//   1. an explicit ollama/ model short-circuits BEFORE any AeorDB call and
//      returns the non-empty placeholder every test's skip guard wants;
//   2. with no key anywhere (the AeorDB key source is dead by owner ruling,
//      :6830) the loader DEGRADES instead of throwing ECONNREFUSED — defaults
//      the model to Ollama's cloud star and stays keyless;
//   3. a real environment key keeps absolute precedence (nothing forces
//      Ollama onto a host that configured OpenAI).

import assert from 'node:assert/strict';
import test from 'node:test';

const ENV_KEYS = [
  'KIKX_STAGEHAND_OPENAI_API_KEY',
  'OPENAI_API_KEY',
  'KIKX_STAGEHAND_MODEL',
  'OLLAMA_HOST',
  'AEORDB_URL',
  'AEORDB_ROOT_KEY',
  'AEORDB_TOKEN',
];

function withEnv(overrides, fn) {
  const saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  Object.assign(process.env, overrides);
  const restore = () => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  };
  return Promise.resolve()
    .then(fn)
    .finally(restore);
}

async function loadUtils() {
  return import('./stagehand-test-utils.mjs');
}

test('an explicit ollama/ model short-circuits keyless, before any AeorDB call', () => withEnv({
  KIKX_STAGEHAND_MODEL: 'ollama/mimo-v2.6-flash:cloud',
  AEORDB_URL: 'http://127.0.0.1:1', // closed port: any network attempt would fail loudly
  AEORDB_ROOT_KEY: 'dead',
}, async () => {
  const { loadStagehandOpenAIAPIKey } = await loadUtils();
  const started = Date.now();
  const key = await loadStagehandOpenAIAPIKey({ force: true });
  assert.equal(key, 'ollama-keyless', 'the placeholder satisfies every skip guard');
  assert.equal(process.env.OLLAMA_HOST, 'http://127.0.0.1:11434',
    'the provider host is pinned to IPv4 loopback');
  assert.ok(Date.now() - started < 2000,
    'no network attempt: a dead AeorDB call would take longer (and must never happen here)');
}));

test('no key anywhere: the loader DEGRADES to keyless Ollama instead of throwing (dead :6830)', () => withEnv({
  AEORDB_URL: 'http://127.0.0.1:1',
  AEORDB_ROOT_KEY: 'dead',
}, async () => {
  const { loadStagehandOpenAIAPIKey } = await loadUtils();
  const key = await loadStagehandOpenAIAPIKey({ force: true });
  assert.ok(key && key.length > 0,
    'non-empty: an empty string would skip every stagehand test (the old failure)');
  assert.equal(process.env.KIKX_STAGEHAND_MODEL, 'ollama/deepseek-v4.1-flash:cloud',
    'the default model is DeepSeek 4.1 Flash per owner ruling (controls: 11/28 vs MiMo 7/28, 2/2 on JSON), set BEFORE any new Stagehand()');
}));

test('a real environment key keeps absolute precedence — no forced Ollama', () => withEnv({
  OPENAI_API_KEY: 'sk-real-key',
  KIKX_STAGEHAND_MODEL: '',
  AEORDB_URL: 'http://127.0.0.1:1',
  AEORDB_ROOT_KEY: 'dead',
}, async () => {
  const { loadStagehandOpenAIAPIKey } = await loadUtils();
  const key = await loadStagehandOpenAIAPIKey({ force: true });
  assert.equal(key, 'sk-real-key', 'env key wins untouched');
  assert.notEqual(process.env.KIKX_STAGEHAND_MODEL, 'ollama/deepseek-v4.1-flash:cloud',
    'the ollama default is NOT forced onto a keyed host');
}));
