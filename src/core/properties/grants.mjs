'use strict';

// Properties-store P2 (plan §4): grants are read/write SEPARATE maps, DENY
// beats ALLOW, default is DENY, wildcards are prefix-only with the bare '*'
// accepted as the plan §4 idiom (coerced to the whole absolute tree '/*').
// Grants ride manifest.json — the file the S4 signature envelope signs — so
// registration input is validated like a security boundary: malformed shapes
// refuse at load, never half-register. The FQID is registry-UNIQUE: the same
// pluginID from a DIFFERENT plugin path is a collision (refused); the same
// path re-registering (reload) replaces cleanly.

import { normalizePropertyPrefix } from './keys.mjs';
import { PropertyStoreError } from './store.mjs';
import { normalizeDeclaredSchemas } from './schemas.mjs';

// FQID = fully-qualified plugin identifier, Java-style path form, at least
// three segments (plan §2: '/org/category/name'). Never a filesystem path.
export function normalizePluginID(raw) {
  if (typeof raw !== 'string')
    throw new PropertyStoreError('property_plugin_id_invalid',
      `pluginID must be a string (got ${raw === null ? 'null' : typeof raw})`);
  let normalized;
  try {
    normalized = normalizePropertyPrefix(raw);
  } catch (error) {
    throw new PropertyStoreError('property_plugin_id_invalid',
      `pluginID ${JSON.stringify(raw)} is not a valid path: ${error.message}`);
  }
  if (!normalized.startsWith('/'))
    throw new PropertyStoreError('property_plugin_id_invalid',
      `pluginID must be an absolute path-form id: ${JSON.stringify(raw)}`);
  const segments = normalized.slice(1).split('/').filter((segment) => segment !== '');
  if (segments.length < 3)
    throw new PropertyStoreError('property_plugin_id_invalid',
      `pluginID needs at least three segments (/org/category/name): ${JSON.stringify(raw)}`);
  return normalized;
}

const invalidGrant = (message) => new PropertyStoreError('property_grant_invalid', message);

function normalizeEntry(entry, where) {
  if (typeof entry !== 'string' || entry.trim() === '')
    throw invalidGrant(`${where} entries must be non-empty strings`);
  let normalized;
  try {
    normalized = normalizePropertyPrefix(entry);
  } catch (error) {
    throw invalidGrant(`${where} entry ${JSON.stringify(entry)} is invalid: ${error.message}`);
  }
  if (normalized === '*')
    normalized = '/*'; // plan §4 literal: "deny": "*"
  if (normalized.includes('*') && normalized !== '/*' && !normalized.endsWith('/*'))
    throw invalidGrant(`wildcards are prefix-only ('/prefix/*' or '*'): ${JSON.stringify(entry)}`);
  if (!normalized.startsWith('/'))
    throw invalidGrant(`grant entries must be absolute property keys: ${JSON.stringify(entry)}`);
  // Path tokens in PATTERNS: only {uuid} (owner Q1 — one-segment substitution
  // notation; {UUID} folds to it via lowercase). {current} is an IDENTITY
  // token handled in the facade's calculate step — never a grant — and any
  // other brace is a typo we refuse rather than match literally.
  for (const segment of normalized.split('/')) {
    if (segment === '{uuid}')
      continue; // the one legal pattern token (owner Q1)
    if (segment.includes('{'))
      throw invalidGrant(`path token ${JSON.stringify(segment)} is not allowed — patterns accept only {uuid} segments`);
    if (segment.includes('}'))
      throw invalidGrant(`unbalanced brace in pattern segment ${JSON.stringify(segment)}`);
  }
  return normalized;
}

function toEntryList(value, where) {
  const list = typeof value === 'string' ? [ value ] : value;
  if (!Array.isArray(list))
    throw invalidGrant(`${where} must be a string or an array of strings`);
  return list.map((entry) => normalizeEntry(entry, where));
}

function emptyMap() {
  return { deny: [], allow: [] };
}

function normalizeActionMap(map, action) {
  if (map === undefined)
    return emptyMap();
  if (map === null || typeof map !== 'object' || Array.isArray(map))
    throw invalidGrant(`access.${action} must be an object with deny/allow arrays`);
  const unknown = Object.keys(map).filter((key) => key !== 'deny' && key !== 'allow');
  if (unknown.length)
    throw invalidGrant(`access.${action} has unknown keys: ${unknown.join(', ')}`);
  return {
    deny: map.deny === undefined ? [] : toEntryList(map.deny, `access.${action}.deny`),
    allow: map.allow === undefined ? [] : toEntryList(map.allow, `access.${action}.allow`),
  };
}

function normalizeAccess(access) {
  if (access === undefined || access === null)
    return { read: emptyMap(), write: emptyMap() };
  if (typeof access !== 'object' || Array.isArray(access))
    throw invalidGrant('access must be an object with read/write maps');
  const unknown = Object.keys(access).filter((key) => key !== 'read' && key !== 'write');
  if (unknown.length)
    throw invalidGrant(`access has unknown keys: ${unknown.join(', ')}`);
  return {
    read: normalizeActionMap(access.read, 'read'),
    write: normalizeActionMap(access.write, 'write'),
  };
}

// Segment matcher (unified): literal segments bind exactly; '{uuid}'
// substitutes exactly ONE segment; the terminal '*' form is the prefix /
// subtree rule (strictly BELOW the node — '/core/*' never matches '/core').
// This is the AeorDB level-walk shape flattened into one pattern set
// (cf. aeordb permission_resolver.rs path_levels + path_pattern applicability).
function matches(pattern, key) {
  const patternSegments = pattern.split('/');
  const keySegments = key.split('/');
  const prefixForm = patternSegments[patternSegments.length - 1] === '*';
  if (prefixForm)
    patternSegments.pop();
  else if (pattern.includes('*'))
    return false; // unreachable post-validation — defensive
  if (prefixForm ? keySegments.length <= patternSegments.length : keySegments.length !== patternSegments.length)
    return false;
  for (let index = 0; index < patternSegments.length; index += 1) {
    const segment = patternSegments[index];
    if (segment === '{uuid}')
      continue; // exactly one segment, by construction of the length checks
    if (segment !== keySegments[index])
      return false;
  }
  return true;
}

// Specificity — the "nearest level with an opinion wins" rule (AeorDB):
// full-literal exact > {uuid} full match > longer prefix > the root '/*'.
const EXACT_SCORE = Number.MAX_SAFE_INTEGER;
const TOKEN_SCORE_BASE = 500_000_000;
function specificity(pattern) {
  if (pattern === '/*')
    return 1;
  if (pattern.endsWith('/*'))
    return pattern.length;
  if (pattern.includes('{uuid}'))
    return TOKEN_SCORE_BASE + pattern.length;
  return EXACT_SCORE;
}

export class GrantsRegistry {
  constructor() {
    this._byID = new Map(); // pluginID -> { access, pluginPath }
  }

  // `schemas` (plan P6) rides the SAME entry — one lifecycle for everything
  // the signed manifest declares: normalized atomically (a malformed
  // properties block registers NOTHING), collision/path rules shared.
  register(pluginID, access, pluginPath, schemas = null) {
    const id = normalizePluginID(pluginID);
    const normalizedAccess = normalizeAccess(access);
    const normalizedSchemas = schemas === null || schemas === undefined
      ? null
      : normalizeDeclaredSchemas(schemas);
    const existing = this._byID.get(id);
    if (existing && existing.pluginPath !== pluginPath)
      throw new PropertyStoreError('property_grant_duplicate',
        `pluginID ${id} is already registered from ${existing.pluginPath} — ${pluginPath} collides`);
    this._byID.set(id, { access: normalizedAccess, pluginPath, schemas: normalizedSchemas });
    return id;
  }

  // Declared own-key schemas for a plugin (null = nothing declared — the
  // facade's dynamic-keys relaxation path).
  getSchemas(pluginID) {
    try {
      return this._byID.get(normalizePluginID(pluginID))?.schemas ?? null;
    } catch {
      return null;
    }
  }

  // Path-guarded: an impostor path cannot release a legitimate plugin's
  // grants. Returns whether anything was released.
  unregister(pluginID, pluginPath) {
    let id;
    try {
      id = normalizePluginID(pluginID);
    } catch {
      return false;
    }
    const existing = this._byID.get(id);
    if (!existing)
      return false;
    if (pluginPath && existing.pluginPath !== pluginPath)
      return false;
    this._byID.delete(id);
    return true;
  }

  get(pluginID) {
    try {
      return this._byID.get(normalizePluginID(pluginID)) ?? null;
    } catch {
      return null;
    }
  }

  // Nearest declaration wins; DENY decides equal specificity — AeorDB's
  // same-level rule where allow writes true and deny writes false after it
  // (permission_resolver.rs:180-185). Absent from both maps = no opinion =
  // default deny (state starts false).
  evaluate(caller, action, key) {
    if (typeof caller !== 'string' || !caller.startsWith('plugin:'))
      return { allowed: false, reason: 'caller' };
    let id;
    try {
      id = normalizePluginID(caller.slice('plugin:'.length));
    } catch {
      return { allowed: false, reason: 'caller' };
    }
    const entry = this._byID.get(id);
    if (!entry)
      return { allowed: false, reason: 'no-grant' };
    const map = entry.access[action];
    if (!map)
      return { allowed: false, reason: 'no-grant' };
    if (typeof key !== 'string' || !key.startsWith('/'))
      return { allowed: false, reason: 'key' };
    let bestAllow = -1;
    let bestDeny = -1;
    for (const pattern of map.deny)
      if (matches(pattern, key)) bestDeny = Math.max(bestDeny, specificity(pattern));
    for (const pattern of map.allow)
      if (matches(pattern, key)) bestAllow = Math.max(bestAllow, specificity(pattern));
    if (bestDeny < 0 && bestAllow < 0)
      return { allowed: false, reason: 'no-grant' };
    if (bestDeny >= bestAllow)
      return { allowed: false, reason: 'deny' };
    return { allowed: true, reason: 'allow' };
  }
}
