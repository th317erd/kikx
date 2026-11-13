'use strict';

// Properties-store P1 — key normalization (plan: docs/plans/properties-store.md
// §1 key model). One canonical spelling per key: ` /a/b`, `/a/b` and `/a//b`
// are one row, `..`/`.` never traverse or get rewritten, empty segments and
// invisible characters are refused, and length is bounded. The store calls
// normalizePropertyKey on EVERY read and write; the facade (P2) calls it
// before resolving relative keys into namespaces. Prefixes share the same
// folds but allow a trailing slash (`/core/` and `/core` name one subtree).

export const PROPERTY_KEY_MAX_LENGTH = 256;

export class PropertyKeyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PropertyKeyError';
    this.code = 'property_key_invalid';
  }
}

// C0/C1 controls and the bidi-override/format blocks (U+202A-202E,
// U+2066-2069). An invisible character in a key is spoofing surface, never
// content. Tab/newline are in this set too, but trim() runs FIRST, so
// whitespace padding is normalized away while embedded controls are refused.
// Code points, not a regex: this stays plain ASCII source regardless of how
// the file is written (a raw-NUL character class once broke it).
function hasForbiddenChar(text) {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)
      || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069))
      return true;
  }
  return false;
}

function normalizeCore(input, { allowEmpty, allowTrailingSlash }) {
  if (typeof input !== 'string')
    throw new PropertyKeyError(`property key must be a string (input is ${input === null ? 'null' : typeof input})`);

  let out = input.trim().toLowerCase();
  if (out === '') {
    if (allowEmpty)
      return '';
    throw new PropertyKeyError('property key is empty after trim');
  }
  if (hasForbiddenChar(out))
    throw new PropertyKeyError('property key contains a control or bidi character');

  // Collapse repeated slashes: `/a//b` and `/a/b` must never be two keys.
  out = out.replace(/\/{2,}/g, '/');

  const absolute = out.startsWith('/');
  const segments = (absolute ? out.slice(1) : out).split('/');
  let trailingSlash = false;
  if (allowTrailingSlash && segments.length > 0 && segments[segments.length - 1] === '') {
    segments.pop();
    trailingSlash = true;
  }
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i].trim();
    if (segment === '')
      throw new PropertyKeyError('property key contains an empty segment');
    if (segment === '.' || segment === '..')
      throw new PropertyKeyError('property key contains a path segment ("." / "..") — never rewritten, refused');
    segments[i] = segment;
  }

  out = absolute && segments.length === 0
    ? '/'  // root: '/' + [] + trailing flag must not reassemble into '//'
    : (absolute ? '/' : '') + segments.join('/') + (trailingSlash ? '/' : '');
  if (out.length > PROPERTY_KEY_MAX_LENGTH)
    throw new PropertyKeyError(`property key exceeds ${PROPERTY_KEY_MAX_LENGTH} characters`);
  return out;
}

export function normalizePropertyKey(key) {
  return normalizeCore(key, { allowEmpty: false, allowTrailingSlash: false });
}

// Prefix rule for list(): same folds, but '' = no filter, '/' = whole scope,
// and one trailing slash is legal (it never means "an empty segment under
// this key", because nothing is stored under it).
export function normalizePropertyPrefix(prefix) {
  return normalizeCore(prefix === null || prefix === undefined ? '' : prefix,
    { allowEmpty: true, allowTrailingSlash: true });
}

// Leading slash = absolute path (permission-checked at the facade, P2).
// Never throws; the facade calls this on already-normalized keys.
export function isAbsolutePropertyKey(key) {
  return typeof key === 'string' && key.startsWith('/');
}
