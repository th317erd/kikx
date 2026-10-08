'use strict';

// S5: an opt-in, bounded, server-side memory sampler. A long-lived service can
// leak slowly across days; a cheap periodic `process.memoryUsage()` reading
// gives the infra/health surface evidence without ever logging per sample.
//
// Disabled by default: when disabled `start()`/`sample()` are no-ops and
// `snapshot()` returns an empty, still-bounded shape. When enabled it keeps a
// fixed-size ring (the oldest entry is overwritten) and fires a *single*
// warning when RSS growth across the trailing window crosses the threshold.
// The warning re-arms only after growth falls back below the threshold, so a
// sustained leak produces one log line per breach, never one per sample.

export const DEFAULT_MEMORY_SAMPLE_LIMIT = 120;
export const DEFAULT_MEMORY_SAMPLE_INTERVAL_MS = 30_000;
export const DEFAULT_MEMORY_GROWTH_WINDOW_SAMPLES = 20;
const MIN_MEMORY_SAMPLE_INTERVAL_MS = 250;

export function createMemorySampler(options = {}) {
  let enabled = options.enabled === true;
  let intervalMS = normalizeIntervalMS(options.intervalMS);
  let maxSamples = normalizePositiveInteger(options.maxSamples, DEFAULT_MEMORY_SAMPLE_LIMIT);
  let growthWindowSamples = normalizePositiveInteger(options.growthWindowSamples, DEFAULT_MEMORY_GROWTH_WINDOW_SAMPLES);
  let growthThresholdBytes = normalizeNonNegativeInteger(options.growthThresholdBytes, 0);
  let readMemory = typeof options.readMemory === 'function' ? options.readMemory : defaultReadMemory;
  let logger = options.logger || console;
  let now = typeof options.now === 'function' ? options.now : () => Date.now();

  // Bounded ring. `samples.length` never exceeds `maxSamples`.
  let samples = [];
  let timer = null;
  // True while a breach has not been reported yet; flips false after warning and
  // back to true once growth recovers.
  let warningArmed = true;
  let warningCount = 0;

  function sample() {
    if (!enabled)
      return null;

    let reading;
    try {
      reading = readMemory();
    } catch (_error) {
      // A broken reader must never break the sampler's caller.
      return null;
    }

    let entry = {
      at: now(),
      rss: toBytes(reading?.rss),
      heapUsed: toBytes(reading?.heapUsed),
      external: toBytes(reading?.external),
    };

    samples.push(entry);
    if (samples.length > maxSamples)
      samples.splice(0, samples.length - maxSamples);

    evaluateGrowth();
    return entry;
  }

  function evaluateGrowth() {
    if (growthThresholdBytes <= 0 || samples.length < 2)
      return;

    let window = Math.min(samples.length, growthWindowSamples);
    let first = samples[samples.length - window];
    let last = samples[samples.length - 1];
    let growth = last.rss - first.rss;

    if (growth < growthThresholdBytes) {
      warningArmed = true;
      return;
    }

    if (!warningArmed)
      return;

    warningArmed = false;
    warningCount += 1;

    try {
      logger.warn?.(
        `[kikx] memory growth: RSS +${formatMiB(growth)} MiB over ${window} samples (now ${formatMiB(last.rss)} MiB)`,
      );
    } catch (_error) {
      // A broken logger must not break sampling.
    }
  }

  function start() {
    if (!enabled || timer)
      return;

    // Take a baseline immediately so the first growth window is meaningful even
    // before the first interval elapses.
    sample();
    timer = setInterval(() => {
      sample();
    }, intervalMS);
    // A monitoring timer must never hold the process open on its own.
    timer.unref?.();
  }

  function stop() {
    if (!timer)
      return;

    clearInterval(timer);
    timer = null;
  }

  function snapshot(snapshotOptions = {}) {
    let includeSamples = snapshotOptions.includeSamples === true;
    return {
      enabled,
      running: timer !== null,
      intervalMS,
      maxSamples,
      growthWindowSamples,
      growthThresholdBytes,
      sampleCount: samples.length,
      warningCount,
      latest: samples.length > 0 ? copySample(samples[samples.length - 1]) : null,
      // Never hand out the live ring; a bounded copy only.
      samples: includeSamples ? samples.map(copySample) : [],
    };
  }

  return {
    start,
    stop,
    sample,
    snapshot,
    isEnabled: () => enabled,
    isRunning: () => timer !== null,
  };
}

function defaultReadMemory() {
  return process.memoryUsage();
}

function copySample(sample) {
  return {
    at: sample.at,
    rss: sample.rss,
    heapUsed: sample.heapUsed,
    external: sample.external,
  };
}

function toBytes(value) {
  let bytes = Number(value);
  return Number.isFinite(bytes) && bytes >= 0 ? Math.round(bytes) : 0;
}

function normalizeIntervalMS(value) {
  let ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0)
    return DEFAULT_MEMORY_SAMPLE_INTERVAL_MS;

  return Math.max(Math.round(ms), MIN_MEMORY_SAMPLE_INTERVAL_MS);
}

function normalizePositiveInteger(value, fallback) {
  let parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : fallback;
}

function normalizeNonNegativeInteger(value, fallback) {
  let parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function formatMiB(bytes) {
  return (bytes / (1024 * 1024)).toFixed(1);
}
