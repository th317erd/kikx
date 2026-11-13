'use strict';

// Properties-store P2 (plan §3): sensitivity is CORE-OWNED, never
// requester-owned — no self-granting. The registry maps absolute keys and
// prefix patterns to public | internal | secret; most specific entry wins;
// an unmatched absolute key defaults to 'internal' (grant-able, never
// accidentally world-readable). Wildcards are prefix-only: exact keys,
// '/prefix/*', or the root '/*' — nothing else. HTTP identities never touch
// this layer (P3 keeps the scope rules at the transport).

import { normalizePropertyPrefix } from './keys.mjs';
import { PropertyStoreError } from './store.mjs';

export const SENSITIVITIES = Object.freeze([ 'public', 'internal', 'secret' ]);

// Seed rows (docs/dump surfaces read these). Everything unlisted resolves
// 'internal' via the root pattern.
export const DEFAULT_PROPERTY_SENSITIVITIES = Object.freeze([
  Object.freeze([ '/core/kikx/email/configuration', 'secret' ]),
  Object.freeze([ '/core/user/theme/primary_color', 'internal' ]),
  Object.freeze([ '/core/*', 'internal' ]),
  Object.freeze([ '/*', 'internal' ]),
]);

function invalid(message) {
  return new PropertyStoreError('property_registry_invalid', message);
}

function normalizePattern(pattern) {
  if (typeof pattern !== 'string')
    throw invalid(`registry pattern must be a string (got ${typeof pattern})`);
  let normalized;
  try {
    normalized = normalizePropertyPrefix(pattern);
  } catch (error) {
    throw invalid(`registry pattern ${JSON.stringify(pattern)} is not a valid absolute prefix: ${error.message}`);
  }
  if (!normalized.startsWith('/'))
    throw invalid(`registry pattern must be absolute: ${JSON.stringify(pattern)}`);
  if (normalized.includes('*') && normalized !== '/*' && !normalized.endsWith('/*'))
    throw invalid(`wildcards are prefix-only ('/prefix/*' or '/*'): ${JSON.stringify(pattern)}`);
  return normalized;
}

export class CorePropertyRegistry {
  constructor(entries = DEFAULT_PROPERTY_SENSITIVITIES) {
    this._rows = [];
    for (const entry of entries) {
      if (!Array.isArray(entry) || entry.length < 2)
        throw invalid('entries are [pattern, sensitivity] pairs');
      this.register(entry[0], entry[1]);
    }
  }

  register(pattern, sensitivity) {
    if (typeof sensitivity !== 'string' || !SENSITIVITIES.includes(sensitivity))
      throw invalid(`unknown sensitivity ${JSON.stringify(sensitivity)} (want ${SENSITIVITIES.join(' | ')})`);
    const normalized = normalizePattern(pattern);
    const existing = this._rows.find((row) => row.pattern === normalized);
    if (existing)
      existing.sensitivity = sensitivity;
    else
      this._rows.push({ pattern: normalized, sensitivity });
    return normalized;
  }

  // Most specific wins: an exact row beats its prefix row, the longest
  // prefix beats shorter ones, the root '/*' is the floor, and anything
  // unregistered lands on the 'internal' default (never 'public' by
  // accident).
  lookup(key) {
    if (typeof key !== 'string')
      return 'internal';
    let bestPrefixLength = -1;
    let best = null;
    for (const row of this._rows) {
      if (!row.pattern.includes('*')) {
        if (row.pattern === key)
          return row.sensitivity;
        continue;
      }
      const base = row.pattern.slice(0, -1); // '/core/*' -> '/core/'
      if (key.startsWith(base) && base.length > bestPrefixLength) {
        bestPrefixLength = base.length;
        best = row.sensitivity;
      }
    }
    return best ?? 'internal';
  }
}
