'use strict';

import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const DEFAULT_LOGICAL_WIDTH = 6;

export class HybridLogicalClock {
  constructor(options = {}) {
    this.now = options.now || defaultUnixMicros;
    this.runnerID = normalizeRunnerID(options.runnerID || randomUUID());
    this.logicalWidth = options.logicalWidth || DEFAULT_LOGICAL_WIDTH;
    this._lastPhysicalMicros = 0;
    this._logical = 0;
  }

  tick() {
    let physicalMicros = normalizeMicros(this.now());

    if (physicalMicros > this._lastPhysicalMicros) {
      this._lastPhysicalMicros = physicalMicros;
      this._logical = 0;
    } else {
      this._logical++;
    }

    return {
      at: this._lastPhysicalMicros,
      clock: formatClock(this._lastPhysicalMicros, this._logical, this.runnerID, this.logicalWidth),
    };
  }

  observe(clock) {
    let parsed = parseClock(clock);
    if (!parsed)
      return this.tick();

    let physicalMicros = normalizeMicros(this.now());
    let maxPhysicalMicros = Math.max(physicalMicros, this._lastPhysicalMicros, parsed.physicalMicros);

    if (maxPhysicalMicros === this._lastPhysicalMicros && maxPhysicalMicros === parsed.physicalMicros)
      this._logical = Math.max(this._logical, parsed.logical) + 1;
    else if (maxPhysicalMicros === this._lastPhysicalMicros)
      this._logical++;
    else if (maxPhysicalMicros === parsed.physicalMicros)
      this._logical = parsed.logical + 1;
    else
      this._logical = 0;

    this._lastPhysicalMicros = maxPhysicalMicros;
    return {
      at: this._lastPhysicalMicros,
      clock: formatClock(this._lastPhysicalMicros, this._logical, this.runnerID, this.logicalWidth),
    };
  }

  seed(clock) {
    let parsed = parseClock(clock);
    if (!parsed)
      return;

    if (parsed.physicalMicros > this._lastPhysicalMicros) {
      this._lastPhysicalMicros = parsed.physicalMicros;
      this._logical = parsed.logical;
      return;
    }

    if (parsed.physicalMicros === this._lastPhysicalMicros)
      this._logical = Math.max(this._logical, parsed.logical);
  }
}

export function defaultUnixMicros() {
  return Math.trunc((performance.timeOrigin + performance.now()) * 1000);
}

export function normalizeMicros(value) {
  let number = Number(value);
  if (!Number.isFinite(number) || number < 0)
    return defaultUnixMicros();

  let truncated = Math.trunc(number);
  return truncated < 100_000_000_000_000
    ? truncated * 1000
    : truncated;
}

export function parseClock(clock) {
  if (typeof clock !== 'string')
    return null;

  let match = clock.match(/^(\d{16})-(\d{6})-(.+)$/);
  if (!match)
    return null;

  let physicalMicros = Number(match[1]);
  let logical = Number(match[2]);
  if (!Number.isSafeInteger(physicalMicros) || !Number.isSafeInteger(logical))
    return null;

  return {
    physicalMicros,
    logical,
    runnerID: match[3],
  };
}

function formatClock(physicalMicros, logical, runnerID, logicalWidth) {
  return `${String(physicalMicros).padStart(16, '0')}-${String(logical).padStart(logicalWidth, '0')}-${runnerID}`;
}

function normalizeRunnerID(value) {
  let normalized = String(value || 'runner')
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return normalized || 'runner';
}
