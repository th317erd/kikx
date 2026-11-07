'use strict';

// Campaign S3 slice 2 (plan 5-S3, 10): resolve a package against the
// CONFIGURED registry list (default public npm; host never hardcoded),
// fetch its packument bounded, pick a version, and insist on a sha512
// dist.integrity before any bytes are downloaded for extraction. All
// network access goes through an injected fetchImpl so tests mock the
// registry entirely — no test, and no offline environment, ever reaches
// the real network.

import crypto from 'node:crypto';

const PUBLIC_NPM = 'https://registry.npmjs.org';
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const DEFAULT_MAX_PACKUMENT = 16 * 1024 * 1024;
const DEFAULT_MAX_TARBALL = 64 * 1024 * 1024;

function fail(error) {
  const e = new Error(`[npm-registry] ${error}`);
  e.error = error;
  return e;
}

// First usable URL from configuration: https only (http allowed solely for
// loopback, for local mirrors and tests), no credentials in the URL.
// Unset/empty/garbage falls back to public npm.
export function pickRegistryBase(raw) {
  const list = Array.isArray(raw) ? raw : String(raw ?? '').split(',');
  for (const item of list) {
    const s = String(item).trim();
    if (!s) continue;
    let url;
    try { url = new URL(s); } catch { continue; }
    if (url.username || url.password) continue;
    const loopback = LOOPBACK_HOSTS.has(url.hostname);
    if (url.protocol === 'https:') return s.replace(/\/+$/, '');
    if (url.protocol === 'http:' && loopback) return s.replace(/\/+$/, '');
  }
  return PUBLIC_NPM;
}

function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v);
  if (!m) return null;
  return { parts: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] || null };
}

function cmpVersion(a, b) {
  for (let i = 0; i < 3; i += 1) if (a.parts[i] !== b.parts[i]) return a.parts[i] < b.parts[i] ? -1 : 1;
  if (a.pre && !b.pre) return -1;
  if (!a.pre && b.pre) return 1;
  if (a.pre && b.pre) return a.pre < b.pre ? -1 : a.pre > b.pre ? 1 : 0;
  return 0;
}

// Partial versions like "1", "1.2", "1.x", "1.2.3" (null = unspecified).
function parsePartial(s) {
  const m = /^(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?$/.exec(s);
  if (!m) return null;
  const nums = m.slice(1, 4).map((p) => (p === undefined || /^[xX*]$/.test(p) ? null : Number(p)));
  return { nums, pre: m[4] || null, specified: m.slice(1, 4).findIndex((p) => p !== undefined) };
}

function lowerBound(nums) {
  return [nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0];
}

function upperFrom(nums, slot) {
  const lo = lowerBound(nums);
  const hi = [...lo];
  hi[slot] += 1;
  for (let i = slot + 1; i < 3; i += 1) hi[i] = 0;
  return hi;
}

function ltParts(a, b) { for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] < b[i]; return false; }

function satisfies(parsed, token) {
  const t = token.startsWith('v') && /\d/.test(token) ? token.slice(1) : token.trim();
  const m = /^(>=|<=|>|<|=|\^|~)?(.*)$/.exec(t);
  const op = m[1] || '=';
  const partial = parsePartial(m[2]);
  if (!partial) return false;
  const rangeHasPre = Boolean(partial.pre);
  if (parsed.pre && !rangeHasPre) return false;

  const lo = lowerBound(partial.nums);
  const cur = parsed.parts;
  const geLo = !ltParts(cur, lo);
  const gtLo = ltParts(lo, cur); // lo < cur  ⇔  cur > lo

  switch (op) {
    case '=': {
      if (partial.nums.some((n, i) => n !== null && n !== cur[i])) return false;
      if (partial.nums[0] === null) return true; // *, x
      if (partial.pre) return parsed.pre === partial.pre;
      return parsed.pre === null; // exact release never matches a prerelease
    }
    case '>': return gtLo;
    case '>=': return geLo;
    case '<': return ltParts(cur, lo);
    case '<=': return geLo || ltParts(cur, lo);
    case '^': {
      if (!geLo) return false;
      const [maj, min] = [partial.nums[0] ?? 0, partial.nums[1]];
      let hi;
      if (partial.nums[0] === null) return true;
      if (maj > 0 || min === null) hi = [maj + 1, 0, 0];
      else if (partial.nums[2] === null) hi = [0, min + 1, 0];
      else hi = [0, min, partial.nums[2] + 1];
      return ltParts(cur, hi); // lo <= cur < hi
    }
    case '~': {
      if (!geLo) return false;
      const hi = partial.nums[1] === null
        ? [ (partial.nums[0] ?? 0) + 1, 0, 0 ]
        : [ partial.nums[0] ?? 0, partial.nums[1] + 1, 0 ];
      return ltParts(cur, hi); // lo <= cur < hi
    }
    default: return false;
  }
}

// Picks the version a spec resolves to: exact pin, dist-tag, or the highest
// version satisfying a spaceless range (caret/tilde/x-range/comparators, ||
// branches). Returns null when nothing satisfies — the route answers 404.
export function resolveVersionSpec(packument, spec) {
  const versions = Object.keys(packument?.versions || {});
  if (!versions.length) return null;
  if (!spec) {
    const latest = packument['dist-tags']?.latest;
    return versions.includes(latest) ? latest : null;
  }
  if (Object.prototype.hasOwnProperty.call(packument.versions, spec)) return spec;
  const tags = packument['dist-tags'] || {};
  if (tags[spec] && packument.versions[tags[spec]]) return tags[spec];
  const branches = String(spec).split('||');
  let best = null;
  let bestParsed = null;
  for (const v of versions) {
    const p = parseVersion(v);
    if (!p) continue;
    if (!branches.some((b) => satisfies(p, b))) continue;
    if (!bestParsed || cmpVersion(p, bestParsed) > 0) { best = v; bestParsed = p; }
  }
  return best;
}

async function fetchBounded(url, fetchImpl, maxBytes) {
  const res = await fetchImpl(url, { headers: { accept: 'application/json' } });
  if (!res || !res.ok) return null;
  const declared = Number(res.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw fail('too-large');
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > maxBytes) throw fail('too-large');
  return bytes;
}

// Resolves {name, spec} to install metadata. Fails closed: no sha512
// integrity means no install (error: 'integrity-missing'), and the tarball
// must live on the registry's own origin (mirrors rehost consistently;
// anything else is a redirect into attacker space: 'tarball-origin-mismatch').
export async function resolvePackage(name, spec, { registryUrls, fetchImpl = globalThis.fetch, maxBytes = DEFAULT_MAX_PACKUMENT } = {}) {
  const registry = pickRegistryBase(registryUrls);
  const encoded = name.replace('/', '%2f');
  let bytes;
  try {
    bytes = await fetchBounded(`${registry}/${encoded}`, fetchImpl, maxBytes);
  } catch (e) {
    if (e && e.error) throw e;
    return { error: 'registry-unreachable' };
  }
  let packument = {};
  if (bytes) { try { packument = JSON.parse(bytes.toString('utf8')); } catch { packument = {}; } }
  const version = resolveVersionSpec(packument, spec);
  if (!version) return { error: 'version-not-found' };
  const dist = packument.versions[version]?.dist || {};
  if (!dist.tarball) return { error: 'tarball-missing' };
  if (typeof dist.integrity !== 'string' || !dist.integrity.startsWith('sha512-')) return { error: 'integrity-missing' };
  try {
    if (new URL(dist.tarball).origin !== new URL(registry).origin) return { error: 'tarball-origin-mismatch' };
  } catch { return { error: 'tarball-origin-mismatch' }; }
  return { name, version, integrity: dist.integrity, tarball: dist.tarball, registry };
}

// Strict sha512 SRI comparison against the exact downloaded bytes. Multiple
// space-separated SRI tokens are allowed; any sha512 token may match.
export function verifyIntegrity(bytes, sri) {
  if (typeof sri !== 'string' || !sri) return false;
  const digest = crypto.createHash('sha512').update(bytes).digest('base64');
  return sri.split(/\s+/).some((t) => t === `sha512-${digest}`);
}

// Downloads the tarball and verifies it BEFORE it ever reaches the
// extractor. Throws {error:'integrity-mismatch'|'too-large'} on failure.
export async function downloadTarball({ tarball, integrity }, { fetchImpl = globalThis.fetch, maxBytes = DEFAULT_MAX_TARBALL } = {}) {
  const bytes = await fetchBounded(tarball, fetchImpl, maxBytes);
  if (!bytes) throw fail('download-failed');
  if (!verifyIntegrity(bytes, integrity)) throw fail('integrity-mismatch');
  return bytes;
}
