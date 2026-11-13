'use strict';

// Properties-store P6 (plan §4): DECLARED own-key schemas are validated
// server-side — the gate the static manifest was always protecting
// (validation + bounds), preserved by the dynamic-properties relaxation:
// declared keys get checked, undeclared dynamic keys stay free within the
// store's bounds. The block lives under `properties` in the SAME signed
// manifest.json the access block comes from, so it travels through the same
// admission + registration lifecycle (validated ONCE at load, never
// half-registered).

import { normalizePropertyKey } from './keys.mjs';
import { PropertyStoreError } from './store.mjs';

export const ALLOWED_SCHEMA_TYPES = Object.freeze(
  [ 'string', 'number', 'boolean', 'object', 'array', 'null' ]);

const invalid = (message) =>
  new PropertyStoreError('property_schema_invalid', `manifest properties block invalid: ${message}`);

// { relativeKey: { type, default? } } -> normalized map. Absolute keys belong
// in `access`; traversal is never legal; unknown schema fields are refused
// (no silent semantics — a field we ignore is a promise we do not keep).
export function normalizeDeclaredSchemas(properties) {
  if (properties === null || properties === undefined)
    return {};
  if (typeof properties !== 'object' || Array.isArray(properties))
    throw invalid('must be an object mapping relative keys to { type, default? }');
  const out = {};
  for (const [ rawKey, schema ] of Object.entries(properties)) {
    let key;
    try {
      key = normalizePropertyKey(rawKey);
    } catch (error) {
      throw invalid(`key ${JSON.stringify(rawKey)}: ${error.message}`);
    }
    if (key.startsWith('/'))
      throw invalid(`key ${JSON.stringify(rawKey)}: absolute keys belong in access, not properties`);
    if (Object.prototype.hasOwnProperty.call(out, key))
      throw invalid(`key ${JSON.stringify(rawKey)} normalizes onto the already-declared ${JSON.stringify(key)}`);
    if (!schema || typeof schema !== 'object' || Array.isArray(schema))
      throw invalid(`schema for ${JSON.stringify(key)} must be an object { type, default? }`);
    const unknown = Object.keys(schema).filter((field) => field !== 'type' && field !== 'default');
    if (unknown.length)
      throw invalid(`schema for ${JSON.stringify(key)} has unknown fields: ${unknown.join(', ')}`);
    if (typeof schema.type !== 'string' || !ALLOWED_SCHEMA_TYPES.includes(schema.type))
      throw invalid(`schema for ${JSON.stringify(key)} needs a type in (${ALLOWED_SCHEMA_TYPES.join(', ')})`);
    out[key] = 'default' in schema
      ? { type: schema.type, default: schema.default }
      : { type: schema.type };
  }
  return out;
}

// Throws property_schema_invalid on mismatch; returns true on success. The
// refusal names the key and the expected type (operator/plugin-author
// actionable). `where` carries the display key for the message.
export function validateDeclaredValue(schema, value, where) {
  const key = typeof where === 'string' ? where : 'value';
  const type = schema?.type;
  const fits = (() => {
    switch (type) {
      case 'string': return typeof value === 'string';
      case 'number': return typeof value === 'number' && Number.isFinite(value);
      case 'boolean': return typeof value === 'boolean';
      case 'object': return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
      case 'array': return Array.isArray(value);
      case 'null': return value === null;
      default: return false;
    }
  })();
  if (!fits)
    throw new PropertyStoreError('property_schema_invalid',
      `property ${JSON.stringify(key)} is declared type ${JSON.stringify(type ?? 'unknown')} — value refused`);
  return true;
}
