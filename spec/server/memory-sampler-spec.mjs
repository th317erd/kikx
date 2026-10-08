'use strict';

// S5: the memory sampler is opt-in, bounded, and quiet. These specs pin the
// contract that matters for stability: disabled does nothing, the ring never
// exceeds its cap, and a growth breach logs exactly once until it recovers.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createMemorySampler,
  DEFAULT_MEMORY_SAMPLE_LIMIT,
} from '../../src/server/memory-sampler.mjs';

function sequentialReadings(values, fallback = {}) {
  let index = 0;
  let reads = 0;
  return {
    reads: () => reads,
    read() {
      reads += 1;
      let value = values[Math.min(index, values.length - 1)] ?? fallback;
      index += 1;
      return value;
    },
  };
}

test('a disabled sampler never reads memory, schedules, or reports samples', () => {
  let reads = 0;
  let sampler = createMemorySampler({
    enabled: false,
    readMemory: () => {
      reads += 1;
      return { rss: 100, heapUsed: 10, external: 1 };
    },
  });

  sampler.start();
  assert.equal(sampler.isRunning(), false);
  assert.equal(sampler.sample(), null);
  assert.equal(reads, 0, 'a disabled sampler must not sample at all');

  let snapshot = sampler.snapshot();
  assert.equal(snapshot.enabled, false);
  assert.equal(snapshot.running, false);
  assert.equal(snapshot.sampleCount, 0);
  assert.deepEqual(snapshot.samples, []);
  sampler.stop();
});

test('the sample ring is bounded and keeps the newest entries', () => {
  let source = sequentialReadings([
    { rss: 10 },
    { rss: 20 },
    { rss: 30 },
    { rss: 40 },
    { rss: 50 },
  ]);
  let sampler = createMemorySampler({
    enabled: true,
    maxSamples: 3,
    readMemory: () => source.read(),
  });

  for (let i = 0; i < 5; i += 1)
    sampler.sample();

  let snapshot = sampler.snapshot({ includeSamples: true });
  assert.equal(snapshot.sampleCount, 3);
  assert.deepEqual(snapshot.samples.map((entry) => entry.rss), [ 30, 40, 50 ]);

  // The snapshot must be a copy: mutating it cannot reach the live ring.
  snapshot.samples[0].rss = -1;
  assert.deepEqual(sampler.snapshot({ includeSamples: true }).samples.map((entry) => entry.rss), [ 30, 40, 50 ]);
});

test('maxSamples defaults to the documented cap', () => {
  let sampler = createMemorySampler({ enabled: true });
  assert.equal(sampler.snapshot().maxSamples, DEFAULT_MEMORY_SAMPLE_LIMIT);
});

test('growth past the threshold warns once and re-arms only after recovery', () => {
  let warnings = [];
  let logger = {
    warn(message) {
      warnings.push(message);
    },
    log() {
      throw new Error('the sampler must not log per sample');
    },
    info() {
      throw new Error('the sampler must not log per sample');
    },
  };
  let source = sequentialReadings([
    { rss: 1000 },
    { rss: 1000 },
    { rss: 2000 }, // breach: +1000 over 2 samples
    { rss: 2000 }, // still breached: must not warn again
    { rss: 1000 }, // recovery
    { rss: 2000 }, // new breach: warns again
  ]);
  let sampler = createMemorySampler({
    enabled: true,
    growthWindowSamples: 2,
    growthThresholdBytes: 100,
    logger,
    readMemory: () => source.read(),
  });

  for (let i = 0; i < 6; i += 1)
    sampler.sample();

  assert.equal(warnings.length, 2, 'one warning per breach, never one per sample');
  assert.match(warnings[0], /memory growth/);
  assert.equal(sampler.snapshot().warningCount, 2);
});

test('growth below the threshold is silent', () => {
  let warnings = [];
  let source = sequentialReadings([
    { rss: 1000 },
    { rss: 1050 },
    { rss: 1090 },
  ]);
  let sampler = createMemorySampler({
    enabled: true,
    growthWindowSamples: 2,
    growthThresholdBytes: 500,
    logger: { warn: (message) => warnings.push(message) },
    readMemory: () => source.read(),
  });

  for (let i = 0; i < 3; i += 1)
    sampler.sample();

  assert.deepEqual(warnings, []);
});

test('a thrown reading is contained and does not corrupt the ring', () => {
  let calls = 0;
  let sampler = createMemorySampler({
    enabled: true,
    maxSamples: 2,
    readMemory: () => {
      calls += 1;
      if (calls === 1)
        throw new Error('memoryUsage exploded');
      return { rss: 42 };
    },
  });

  assert.equal(sampler.sample(), null);
  assert.equal(sampler.snapshot().sampleCount, 0);

  sampler.sample();
  assert.equal(sampler.snapshot().sampleCount, 1);
  assert.equal(sampler.snapshot().latest.rss, 42);
});
