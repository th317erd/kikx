'use strict';

import { randomBytes } from 'node:crypto';

function normalizeRequiredString(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '')
    throw new TypeError(`${fieldName} must be a non-empty string`);

  return value.trim();
}

function normalizeOptionalString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizePositiveInteger(value, fieldName) {
  let number = Number(value);
  if (!Number.isFinite(number) || number <= 0)
    throw new TypeError(`${fieldName} must be a positive integer`);

  return Math.trunc(number);
}

function normalizeNonNegativeInteger(value, defaultValue) {
  let number = Number(value);
  if (!Number.isFinite(number) || number < 0)
    return defaultValue;

  return Math.trunc(number);
}

function clampInteger(value, defaultValue, min, max) {
  let number = Number(value);
  if (!Number.isFinite(number))
    number = defaultValue;

  number = Math.trunc(number);
  return Math.min(max, Math.max(min, number));
}

function normalizeProcessID(value) {
  let normalized = normalizeRequiredString(value, 'processID');
  if (!/^[A-Za-z0-9_-]+$/.test(normalized))
    throw new TypeError('processID may only contain letters, numbers, underscores, and hyphens');

  return normalized;
}

function normalizeStreamName(value) {
  let normalized = normalizeOptionalString(value || 'combined');
  if (![ 'combined', 'stdout', 'stderr' ].includes(normalized))
    throw new TypeError('stream must be combined, stdout, or stderr');

  return normalized;
}

function normalizeSignal(value) {
  let signal = normalizeOptionalString(value || 'SIGTERM').toUpperCase();
  if (!/^SIG[A-Z0-9]+$/.test(signal))
    throw new TypeError('signal must be a POSIX signal name such as SIGTERM');

  return signal;
}

function normalizeRegexFlags(value) {
  let flags = normalizeOptionalString(value);
  if (!/^[dgimsuvy]*$/.test(flags))
    throw new TypeError('flags contains unsupported regular expression flags');

  return Array.from(new Set(flags.replace(/g/g, '').split(''))).join('');
}

function normalizeSearchFlags(flags) {
  return normalizeRegexFlags(flags);
}

function normalizeStatusFilter(value) {
  let values = Array.isArray(value) ? value : value ? [ value ] : [];
  return values
    .map((item) => normalizeOptionalString(item))
    .filter(Boolean);
}

function normalizeReadRange({ start, end, maxBytes }) {
  let normalizedStart = normalizeNonNegativeInteger(start, 0);
  let normalizedEnd = end == null ? null : normalizeNonNegativeInteger(end, 0);
  if (normalizedEnd != null && normalizedEnd < normalizedStart)
    throw new TypeError('end must be greater than or equal to start');

  return {
    start: normalizedStart,
    end: normalizedEnd,
    hasEnd: normalizedEnd != null,
    maxBytes: maxBytes == null ? null : normalizePositiveInteger(maxBytes, 'maxBytes'),
  };
}

function createProcessID() {
  return `proc-${randomBytes(8).toString('hex')}`;
}

function isVisibleToAgent(record, agentID) {
  return !agentID || !record.agentID || record.agentID === agentID;
}

function encodeSegment(value) {
  return encodeURIComponent(String(value)).replace(/%/g, '_');
}

export {
  clampInteger,
  createProcessID,
  encodeSegment,
  isVisibleToAgent,
  normalizeNonNegativeInteger,
  normalizeOptionalString,
  normalizePositiveInteger,
  normalizeProcessID,
  normalizeReadRange,
  normalizeRegexFlags,
  normalizeRequiredString,
  normalizeSearchFlags,
  normalizeSignal,
  normalizeStatusFilter,
  normalizeStreamName,
};
