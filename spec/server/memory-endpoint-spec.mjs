'use strict';

// S5: the sampler is exposed through the existing unauthenticated infra/health
// surface, alongside `/health`. The ring is opt-in via `?samples=1` so a routine
// probe never pays for serializing the samples.

import assert from 'node:assert/strict';
import test from 'node:test';

import { AppContext } from '../../src/core/app/app-context.mjs';
import { createServer } from '../../src/server/create-server.mjs';
import { createMemorySampler } from '../../src/server/memory-sampler.mjs';

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      let address = server.address();
      resolve(`http://${address.address}:${address.port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

test('GET /api/v1/infra/memory reports the disabled default without auth', async () => {
  let server = await createServer({ context: new AppContext({ aeordb: {} }) });
  let baseURL = await listen(server);

  try {
    let response = await fetch(`${baseURL}/api/v1/infra/memory`);
    let body = await response.json();

    assert.equal(response.status, 200, 'the infra surface needs no credentials, like /health');
    assert.equal(body.data.memory.enabled, false);
    assert.equal(body.data.memory.sampleCount, 0);
    assert.deepEqual(body.data.memory.samples, []);

    let healthBody = await (await fetch(`${baseURL}/health`)).json();
    assert.equal(healthBody.memory.enabled, false);
  } finally {
    await close(server);
  }
});

test('GET /api/v1/infra/memory returns a bounded ring and a compact health summary', async () => {
  let sampler = createMemorySampler({
    enabled: true,
    maxSamples: 5,
    readMemory: () => ({ rss: 64 * 1024 * 1024, heapUsed: 10 * 1024 * 1024, external: 1024 }),
  });
  sampler.sample();
  sampler.sample();

  let server = await createServer({ context: new AppContext({ aeordb: {}, memorySampler: sampler }) });
  let baseURL = await listen(server);

  try {
    // `start()` took one baseline sample, so the ring holds at least three.
    let summary = (await (await fetch(`${baseURL}/api/v1/infra/memory`)).json()).data.memory;
    assert.equal(summary.enabled, true);
    assert.ok(summary.sampleCount >= 3);
    assert.equal(summary.latest.rss, 64 * 1024 * 1024);
    assert.deepEqual(summary.samples, [], 'routine probes must not receive the ring');

    let withSamples = (await (await fetch(`${baseURL}/api/v1/infra/memory?samples=1`)).json()).data.memory;
    assert.equal(withSamples.samples.length, withSamples.sampleCount);
    assert.ok(withSamples.samples.length <= summary.maxSamples);

    let healthBody = await (await fetch(`${baseURL}/health`)).json();
    assert.equal(healthBody.memory.enabled, true);
    assert.equal(healthBody.memory.sampleCount, summary.sampleCount);
  } finally {
    await close(server);
  }

  assert.equal(sampler.isRunning(), false, 'closing the server must stop the sampler');
});
