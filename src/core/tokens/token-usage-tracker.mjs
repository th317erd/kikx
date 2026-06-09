'use strict';

import { EventEmitter } from 'node:events';

export const DEFAULT_TOKEN_USAGE_PATH = '/kikx/tokens.json';

export class TokenUsageTracker extends EventEmitter {
  constructor(options = {}) {
    super();

    this.aeordb = options.aeordb || null;
    this.path = normalizePath(options.path || DEFAULT_TOKEN_USAGE_PATH);
    this.clock = options.clock || Date.now;
    this.flushOnAdd = options.flushOnAdd !== false;
    this._usage = normalizeTokenUsageSnapshot(options.usage || {});
  }

  async load() {
    if (!this.aeordb || typeof this.aeordb.getFile !== 'function')
      return this.snapshot();

    try {
      this._usage = normalizeTokenUsageSnapshot(await this.aeordb.getFile(this.path));
    } catch (error) {
      if (error?.status !== 404)
        throw error;

      this._usage = {};
    }

    return this.snapshot();
  }

  snapshot() {
    return cloneJSON(this._usage);
  }

  totalTokensUsed() {
    let total = 0;
    for (let entry of Object.values(this._usage))
      total += normalizeNonNegativeInteger(entry?.tokensUsed);

    return total;
  }

  async addUsage(serviceKey, usage, options = {}) {
    return await this.addTokens(serviceKey, usage, options);
  }

  async addTokens(serviceKey, usage, options = {}) {
    let key = normalizeServiceKey(serviceKey);
    let tokensUsed = normalizeUsageTokens(usage);
    if (tokensUsed <= 0)
      return this.snapshot()[key] || null;

    let now = normalizeTimestamp(options.updatedAt || options.timestamp, this.clock());
    let existing = this._usage[key] || {};
    let entry = {
      tokensUsed: normalizeNonNegativeInteger(existing.tokensUsed) + tokensUsed,
      createdAt: normalizeTimestamp(existing.createdAt, now),
      updatedAt: now,
    };
    this._usage = {
      ...this._usage,
      [key]: entry,
    };

    if (this.flushOnAdd && options.flush !== false)
      await this.flush({ [key]: entry });

    let event = {
      serviceKey: key,
      entry: cloneJSON(entry),
      tokenUsage: this.snapshot(),
      totalTokensUsed: this.totalTokensUsed(),
    };
    this.emit('updated', event);

    return cloneJSON(entry);
  }

  async flush(patch = this._usage) {
    if (!this.aeordb || typeof this.aeordb.patchFile !== 'function')
      return null;

    try {
      return await this.aeordb.patchFile(this.path, patch);
    } catch (error) {
      if (error?.status !== 404 || typeof this.aeordb.putFile !== 'function')
        throw error;

      return await this.aeordb.putFile(this.path, this._usage);
    }
  }
}

export function normalizeProviderUsage(usage = {}) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage))
    return null;

  let inputTokens = firstNonNegativeInteger(
    usage.inputTokens,
    usage.input_tokens,
    usage.promptTokens,
    usage.prompt_tokens,
    usage.readTokens,
  );
  let outputTokens = firstNonNegativeInteger(
    usage.outputTokens,
    usage.output_tokens,
    usage.completionTokens,
    usage.completion_tokens,
    usage.writeTokens,
  );
  let totalTokens = firstNonNegativeInteger(
    usage.tokensUsed,
    usage.totalTokens,
    usage.total_tokens,
    usage.total,
  );

  if (totalTokens === 0)
    totalTokens = inputTokens + outputTokens;

  if (totalTokens <= 0)
    return null;

  return {
    inputTokens,
    outputTokens,
    readTokens: firstNonNegativeInteger(usage.readTokens, inputTokens),
    writeTokens: firstNonNegativeInteger(usage.writeTokens, outputTokens),
    tokensUsed: totalTokens,
    tracked: usage.tracked === true,
    serviceKey: typeof usage.serviceKey === 'string' ? usage.serviceKey.trim() : '',
  };
}

function normalizeUsageTokens(usage) {
  if (typeof usage === 'number')
    return normalizeNonNegativeInteger(usage);

  return normalizeProviderUsage(usage)?.tokensUsed || 0;
}

function normalizeTokenUsageSnapshot(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    return {};

  let output = {};
  for (let [key, value] of Object.entries(input)) {
    if (!key || !value || typeof value !== 'object' || Array.isArray(value))
      continue;

    let tokensUsed = normalizeNonNegativeInteger(value.tokensUsed);
    if (tokensUsed <= 0)
      continue;

    let updatedAt = normalizeTimestamp(value.updatedAt, Date.now());
    output[key] = {
      tokensUsed,
      createdAt: normalizeTimestamp(value.createdAt, updatedAt),
      updatedAt,
    };
  }

  return output;
}

function normalizePath(path) {
  if (typeof path !== 'string' || path.trim() === '')
    throw new TypeError('token usage path must be a non-empty string');

  return path.startsWith('/') ? path : `/${path}`;
}

function normalizeServiceKey(value) {
  if (typeof value !== 'string' || value.trim() === '')
    throw new TypeError('serviceKey must be a non-empty string');

  return value.trim();
}

function firstNonNegativeInteger(...values) {
  for (let value of values) {
    let normalized = normalizeNonNegativeInteger(value);
    if (normalized > 0)
      return normalized;
  }

  return 0;
}

function normalizeNonNegativeInteger(value) {
  let number = Number(value);
  if (!Number.isFinite(number) || number <= 0)
    return 0;

  return Math.trunc(number);
}

function normalizeTimestamp(value, fallback) {
  if (typeof value === 'string' && value.trim() !== '')
    return value;

  if (typeof value === 'number' && Number.isFinite(value))
    return value;

  return fallback;
}

function cloneJSON(value) {
  return JSON.parse(JSON.stringify(value));
}
