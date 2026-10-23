'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_PROVIDER_RETRY_DELAYS_MS,
  isRetryableProviderError,
  isSubstantiveProviderOutput,
  runProviderWithRetry,
} from '../../../src/core/agents/provider-retry.mjs';

async function collect(iterable) {
  let values = [];
  for await (let value of iterable)
    values.push(value);
  return values;
}

function errorWith(properties) {
  return Object.assign(new Error(properties.message || 'provider failed'), properties);
}

test('provider retries use 1s, 2s, 3s, then 4s and allow five total attempts', async () => {
  let attempts = 0;
  let delays = [];
  let retries = [];
  let createProvider = () => ({
    async *run() {
      attempts++;
      if (attempts < 5)
        throw new Error('Ollama stream error: Internal Server Error (ref: c445a77b)');
      yield { type: 'AgentMessage', content: { text: 'recovered' } };
    },
  });

  let outputs = await collect(runProviderWithRetry({
    createProvider,
    sleep: async (delayMs) => delays.push(delayMs),
    onRetry: (event) => retries.push(event),
  }));

  assert.equal(attempts, 5);
  assert.deepEqual(delays, [ 1000, 2000, 3000, 4000 ]);
  assert.deepEqual(retries.map((event) => [ event.attempt, event.maxAttempts, event.delayMs ]), [
    [ 2, 5, 1000 ],
    [ 3, 5, 2000 ],
    [ 4, 5, 3000 ],
    [ 5, 5, 4000 ],
  ]);
  assert.deepEqual(outputs, [{ type: 'AgentMessage', content: { text: 'recovered' } }]);
  assert.deepEqual([ ...DEFAULT_PROVIDER_RETRY_DELAYS_MS ], [ 1000, 2000, 3000, 4000 ]);
});

test('provider retries never replay after substantive output', async () => {
  let attempts = 0;
  let delays = [];
  let createProvider = () => ({
    async *run() {
      attempts++;
      yield { type: 'AgentThinking', content: { text: 'already thinking' } };
      throw errorWith({ status: 503, message: 'Service Unavailable' });
    },
  });

  await assert.rejects(
    () => collect(runProviderWithRetry({ createProvider, sleep: async (delayMs) => delays.push(delayMs) })),
    /Service Unavailable/,
  );
  assert.equal(attempts, 1);
  assert.deepEqual(delays, []);
});

test('phantom typing signals do not block a retry', async () => {
  let attempts = 0;
  let createProvider = () => ({
    async *run() {
      attempts++;
      yield { type: 'BeginTyping' };
      if (attempts === 1)
        throw errorWith({ statusCode: 500, message: 'Internal Server Error' });
      yield { type: 'EndTyping' };
      yield { type: 'Done', content: { status: 'finalized' } };
    },
  });

  let outputs = await collect(runProviderWithRetry({
    createProvider,
    retryDelaysMs: [ 0 ],
    sleep: async () => {},
  }));

  assert.equal(attempts, 2);
  assert.deepEqual(outputs.map((output) => output.type), [ 'BeginTyping', 'BeginTyping', 'EndTyping', 'Done' ]);
});

test('a provider side-effect marker blocks replay even before visible output', async () => {
  let attempts = 0;
  let delays = [];
  let createProvider = () => {
    let provider = {
      providerRetryUnsafe: false,
      async *run() {
        attempts++;
        provider.providerRetryUnsafe = true;
        throw errorWith({ status: 503, message: 'Service Unavailable' });
      },
    };
    return provider;
  };

  await assert.rejects(
    () => collect(runProviderWithRetry({ createProvider, sleep: async (delayMs) => delays.push(delayMs) })),
    /Service Unavailable/,
  );
  assert.equal(attempts, 1);
  assert.deepEqual(delays, []);
});

test('non-retryable provider errors surface immediately', async () => {
  let attempts = 0;
  let createProvider = () => ({
    async *run() {
      attempts++;
      throw errorWith({ status: 404, message: 'Ollama HTTP 404: model not found' });
    },
  });

  await assert.rejects(
    () => collect(runProviderWithRetry({ createProvider, sleep: async () => {} })),
    /model not found/,
  );
  assert.equal(attempts, 1);
});

test('the final retryable failure reports the total attempt count', async () => {
  let attempts = 0;
  let delays = [];
  let createProvider = () => ({
    async *run() {
      attempts++;
      throw new Error('Ollama stream error: Bad Gateway');
    },
  });

  await assert.rejects(
    async () => await collect(runProviderWithRetry({
      createProvider,
      sleep: async (delayMs) => delays.push(delayMs),
    })),
    (error) => {
      assert.match(error.message, /Bad Gateway/);
      assert.equal(error.providerAttempts, 5);
      return true;
    },
  );
  assert.equal(attempts, 5);
  assert.deepEqual(delays, [ 1000, 2000, 3000, 4000 ]);
});

test('retryable status, network, and transient stream errors are classified', () => {
  for (let status of [ 429, 500, 502, 503, 504 ])
    assert.equal(isRetryableProviderError(errorWith({ status })), true, `status ${status}`);

  for (let code of [ 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_SOCKET' ])
    assert.equal(isRetryableProviderError(errorWith({ code })), true, `code ${code}`);

  assert.equal(isRetryableProviderError(new Error('Ollama HTTP 502: Bad Gateway')), true);
  assert.equal(isRetryableProviderError(new Error('Ollama stream error: Internal Server Error (ref: x)')), true);
  assert.equal(isRetryableProviderError(new Error('Ollama stream error: model does not support tools')), false);
  assert.equal(isRetryableProviderError(errorWith({ status: 400, message: 'Bad Request' })), false);
  assert.equal(isRetryableProviderError(errorWith({ retryable: false, status: 503 })), false);
});

test('only content-bearing outputs are retry barriers', () => {
  assert.equal(isSubstantiveProviderOutput({ type: 'BeginTyping' }), false);
  assert.equal(isSubstantiveProviderOutput({ type: 'EndTyping' }), false);
  assert.equal(isSubstantiveProviderOutput({ type: 'AgentThinking' }), true);
  assert.equal(isSubstantiveProviderOutput({ type: 'AgentMessageDelta' }), true);
  assert.equal(isSubstantiveProviderOutput({ type: 'Done' }), true);
  assert.equal(isSubstantiveProviderOutput(null), true);
});
