'use strict';

// Property paths are the canonical configuration keys. They are absolute,
// slash-delimited paths such as `/org/aeor/kikx/database/driver`. This module
// is pure and synchronous; it has no I/O and no dependencies.

export function normalizePropertyPath(path) {
  if (typeof path !== 'string')
    throw new TypeError(`Property path must be a string, received ${typeof path}`);

  let trimmed = path.trim();
  if (trimmed.length === 0)
    throw new TypeError('Property path must not be empty');

  let segments = trimmed.split('/').filter((segment) => segment.length > 0);
  if (segments.length === 0)
    return '/';

  return `/${segments.join('/')}`;
}

// Derive a `process.env` key from a property path. Every character outside
// `[A-Za-z0-9]` in a segment becomes `_`; segments are joined with `_` and the
// result is uppercased.
//
//   /org/aeor/kikx/database/driver -> ORG_AEOR_KIKX_DATABASE_DRIVER
export function envKeyFor(propertyPath) {
  let normalized = normalizePropertyPath(propertyPath);

  return normalized
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.replace(/[^A-Za-z0-9]/g, '_'))
    .join('_')
    .toUpperCase();
}

// Join an absolute base path with additional segments. Each segment is split
// on `/` and empty segments are discarded, matching `normalizePropertyPath`.
export function joinPropertyPath(base, ...segments) {
  let normalizedBase = normalizePropertyPath(base);
  let parts = [];

  if (normalizedBase !== '/')
    parts.push(normalizedBase.slice(1));

  for (const segment of segments) {
    let trimmed = String(segment).trim();
    if (trimmed.length === 0)
      continue;

    for (const part of trimmed.split('/')) {
      if (part.length > 0)
        parts.push(part);
    }
  }

  if (parts.length === 0)
    return '/';

  return `/${parts.join('/')}`;
}
