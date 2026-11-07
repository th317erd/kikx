'use strict';

// Content-addressed cache busting for static delivery.
//
// Why this exists: Cloudflare rewrites the origin's `Cache-Control: no-cache`
// to `max-age=14400` for `.css` URLs (and vendored `.js`), drops the ETag and
// stamps its own `Last-Modified`, so a browser cannot revalidate early. A
// stylesheet whose URL never changes therefore stays stale for four hours
// after a deploy, which is how the composer served a STOP control painted as a
// button inside a button, and a token icon stacked above its count, while the
// origin was serving correct CSS the whole time.
//
// The fix is to change the URL when the bytes change:
//   - index.html links each stylesheet as `/client/styles/x.css?v=<content>`
//   - each served stylesheet rewrites its own `@import` specifiers the same way
//
// Both layers are required. Stamping only the document leaves the ten sheets
// `app.css` imports on unversioned URLs, which is exactly the stale layer.
//
// A stylesheet's version is the hash of its *rendered* text, not its own bytes.
// `app.css` is a stub that means only its ten children; across the deploy that
// shipped the stale composer, `app.css` was byte-identical while
// `app-composer.css` and `app-base-shell.css` both changed. Hashing the parent
// would have produced an unchanged version for a changed document — a stamp
// that looks right and busts nothing. See renderedCSSVersion().
//
// Stamping happens at serve time, never on disk: index.html keeps its plain
// hrefs so repository-level guards (spec/client/stylesheet-links-spec.mjs) can
// still resolve them against the working tree. Those guards assert the exact
// string '/client/styles/questions.css' is linked, which a committed stamp
// would break.
//
// Scope note, deliberately not stamped: `.js` and `.mjs` modules. Client
// modules come back `cf-cache-status: DYNAMIC` with `no-cache` and are never
// cached, so a stamp there would only churn the import graph. Vendored
// aeor-web-components `.js` IS edge-cached (measured: `max-age=14400`,
// `cf-cache-status: EXPIRED`), so it remains a residual skew risk; versioning
// it means rewriting the module graph (every `import` specifier in aeor-ui.mjs
// and inside the vendor tree), which is a separate change.
//
// See docs/deploy-3098-runbook-20261031.md:38 and the composer artifact report.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_CLIENT_ROOT = fileURLToPath(new URL('../client/', import.meta.url));

const LINK_TAG_RE = /<link\b[^>]*>/gi;
const LINK_HREF_RE = /\bhref\s*=\s*(["'])([^"']*)\1/i;
const CSS_IMPORT_RE = /@import\s+(?:url\(\s*)?(["']?)([^"')\s]+)\1\s*\)?/g;
const CSS_URL_RE = /url\(\s*(["']?)([^"')\s]+)\1\s*\)/g;

// Only these are edge-cached and therefore need a version. Anything else is
// either uncacheable (`.mjs` is DYNAMIC) or not our business.
const VERSIONED_EXTENSIONS = new Set([ '.css' ]);

// Fonts are edge-cached exactly like stylesheets (measured: `max-age=14400`
// through Cloudflare), so an unchanged font URL stays stale for four hours
// after a deploy just like an unchanged sheet did. `.css` payloads are
// deliberately absent: `@import` owns those, and stamping them here too would
// create a second source of truth for the same specifier.
const CSS_URL_VERSIONED_EXTENSIONS = new Set([ '.woff', '.woff2', '.ttf', '.otf' ]);

// version key -> version. Keyed by path + mtime + size, so a rewrite invalidates
// the entry even when the new bytes happen to be identical in length.
let versionCache = new Map();

// stat fingerprint of a sheet + every sheet it imports -> rendered version.
let renderedVersionCache = new Map();

export function clearAssetVersionCache() {
  versionCache = new Map();
  renderedVersionCache = new Map();
}

function isVersionedAsset(filePath) {
  return VERSIONED_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

// A 12-char content digest of one file's own bytes. Short because it rides in
// every URL and in every @import of the split sheets; 48 bits is far past
// collision relevance here.
export async function assetVersionForFile(filePath) {
  if (!filePath)
    return null;

  let stats;
  try {
    stats = await fs.stat(filePath);
  } catch (_error) {
    return null;
  }

  if (!stats.isFile())
    return null;

  let key = `${filePath}\u0000${stats.mtimeMs}\u0000${stats.size}`;
  let cached = versionCache.get(key);
  if (cached)
    return cached;

  let body;
  try {
    body = await fs.readFile(filePath);
  } catch (_error) {
    return null;
  }

  let version = crypto.createHash('sha256').update(body).digest('hex').slice(0, 12);
  versionCache.set(key, version);
  return version;
}

// Replace (or add) the `v` query on a URL, preserving every other parameter and
// any fragment. Idempotent: stamping a stamped URL re-stamps rather than nests.
// This also supersedes the hand-maintained literals in index.html
// (`frame-colors.css?v=20261027-1`): the old `v` is dropped, not duplicated.
export function withAssetVersion(href, version) {
  if (!version)
    return href;

  let hash = '';
  let hashAt = href.indexOf('#');
  if (hashAt !== -1) {
    hash = href.slice(hashAt);
    href = href.slice(0, hashAt);
  }

  let query = '';
  let queryAt = href.indexOf('?');
  if (queryAt !== -1) {
    query = href.slice(queryAt + 1);
    href = href.slice(0, queryAt);
  }

  let params = query
    .split('&')
    .filter((pair) => pair && pair.split('=')[0] !== 'v');
  params.push(`v=${version}`);

  return `${href}?${params.join('&')}${hash}`;
}

// Protocol-relative (`//host/x.css`) and any scheme-bearing reference (`https:`,
// `data:`, `blob:`) is remote: it has no file in our trees, so it is never
// rewritten. A bare path (`./x.css`, `/client/x.css`) has no scheme.
function isRemoteReference(reference) {
  if (!reference)
    return true;
  if (/^[a-z][a-z0-9+.-]*:/i.test(reference))
    return true;
  return reference.startsWith('//');
}

// Resolve `relativePath` under `root`, refusing traversal and null bytes.
// Local to this module to keep the dependency one-directional: static-files.mjs
// imports us, so importing it back would create an import cycle.
function containWithin(root, relativePath) {
  if (!root || typeof relativePath !== 'string' || relativePath.includes('\u0000'))
    return null;

  let resolvedRoot = path.resolve(root);
  let candidate = path.resolve(resolvedRoot, relativePath);
  let relative = path.relative(resolvedRoot, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative))
    return null;

  return candidate;
}

// The vendor tree is configured (AEOR_WEB_COMPONENTS_DIR_PATH) and lives outside
// this repository on a normal install, so there is no trustworthy default for
// it. Callers pass `aeorWebComponentsRoot` from the server's own staticRoots; when
// they do not, vendor references simply stay unstamped rather than resolving
// against a path that may not exist.
function rootForRoots(roots) {
  // create-server builds staticRoots as { client, shared, aeorWebComponents };
  // earlier drafts of this module expected { clientRoot, aeorWebComponentsRoot }.
  // Accept both, because a silent key mismatch here does not throw: it makes
  // every reference unresolvable, so the document ships with no stamps at all
  // and the cache behaviour is exactly as broken as before, only quieter.
  return {
    client: (roots && (roots.client || roots.clientRoot)) || DEFAULT_CLIENT_ROOT,
    vendor: (roots && (roots.aeorWebComponents || roots.aeorWebComponentsRoot)) || null,
  };
}

// Map a URL from the document (`/client/...`, `/vendor/aeor-web-components/...`)
// onto the file the server would actually serve for it.
function resolveDocumentAsset(href, roots) {
  let clean = href.split('#')[0].split('?')[0];
  if (!clean || isRemoteReference(clean))
    return null;

  let { client, vendor } = rootForRoots(roots);

  if (clean.startsWith('/client/'))
    return containWithin(client, clean.slice('/client/'.length));
  if (vendor && clean.startsWith('/vendor/aeor-web-components/'))
    return containWithin(vendor, clean.slice('/vendor/aeor-web-components/'.length));

  return null;
}

// Map an `@import` specifier onto disk, relative to the sheet that contains it.
// The containment root is the root that sheet lives under, so a stylesheet can
// reference its neighbours but not escape its tree.
function resolveSheetReference(reference, fromFile, roots) {
  let clean = reference.split('#')[0].split('?')[0];
  if (!clean || isRemoteReference(clean))
    return null;

  let { client, vendor } = rootForRoots(roots);
  let baseDir = fromFile ? path.dirname(fromFile) : path.join(client, 'styles');

  let root = baseDir;
  for (let candidate of [ client, vendor ]) {
    if (!candidate)
      continue;
    let resolvedCandidate = path.resolve(candidate);
    let relative = path.relative(resolvedCandidate, baseDir);
    if (!relative.startsWith('..') && !path.isAbsolute(relative))
      root = resolvedCandidate;
  }

  return containWithin(root, path.relative(root, baseDir ? path.resolve(baseDir, clean) : clean));
}

// Stamp the `url(...)` payloads inside a sheet — in practice the `@font-face`
// sources. Returns the rewritten text plus a fingerprint of every file that
// contributed, so a caller can fold it into the sheet's own version and a font
// change still moves the URL above it.
async function stampCSSUrls(css, fromFile, roots) {
  if (typeof css !== 'string' || !css.includes('url('))
    return { text: css, fingerprint: '' };

  let matches = [ ...css.matchAll(CSS_URL_RE) ];
  if (matches.length === 0)
    return { text: css, fingerprint: '' };

  let resolved = await Promise.all(matches.map(async (match) => {
    let reference = match[2];
    if (isRemoteReference(reference))
      return null;

    let assetPath = resolveSheetReference(reference, fromFile, roots);
    let extension = path.extname(assetPath || '').toLowerCase();
    if (!CSS_URL_VERSIONED_EXTENSIONS.has(extension))
      return null;

    let stats;
    try {
      stats = await fs.stat(assetPath);
    } catch (_error) {
      return null;
    }
    if (!stats.isFile())
      return null;

    let version = await assetVersionForFile(assetPath);
    if (!version)
      return null;

    return { version, fingerprint: `${assetPath}\u0000${stats.mtimeMs}\u0000${stats.size}` };
  }));

  let index = 0;
  let fingerprint = '';
  let text = css.replace(CSS_URL_RE, (all, quote, reference) => {
    let entry = resolved[index++];
    if (!entry)
      return all;
    fingerprint += `|${entry.fingerprint}`;
    return all.replace(reference, withAssetVersion(reference, entry.version));
  });

  return { text, fingerprint };
}

// ── rendered-content versioning ────────────────────────────────────────────
//
// A split stylesheet's identity is its whole import graph. renderSheet returns
// the sheet with its children's versions already inlined, plus a fingerprint of
// every stat that contributed — so a change anywhere in the subtree produces a
// new version, and an unchanged subtree can be answered from cache.
async function renderSheet(filePath, roots, seen) {
  let absolute = path.resolve(filePath);
  let stats = await fs.stat(absolute);
  let own = `${absolute}\u0000${stats.mtimeMs}\u0000${stats.size}`;

  // An import cycle cannot be stamped meaningfully; leave the reference bare
  // rather than recursing forever.
  if (seen.has(own))
    return { version: null, fingerprint: '' };

  let nextSeen = new Set(seen);
  nextSeen.add(own);

  let text = await fs.readFile(absolute, 'utf8');
  let fingerprint = own;

  let rendered = await stampCSSImports(text, async (reference) => {
    let childPath = resolveSheetReference(reference, absolute, roots);
    if (!isVersionedAsset(childPath || ''))
      return null;

    let child;
    try {
      child = await renderSheet(childPath, roots, nextSeen);
    } catch (_error) {
      return null;
    }

    fingerprint += `|${child.fingerprint}`;
    return child.version;
  });

  // Font payloads must be stamped before the version is hashed. Otherwise a
  // changed font would keep the sheet's URL: the cached version is keyed by
  // stat fingerprint, which only tracked stylesheet stats.
  let urls = await stampCSSUrls(rendered, absolute, roots);
  fingerprint += urls.fingerprint;

  let version = crypto.createHash('sha256').update(urls.text).digest('hex').slice(0, 12);
  return { version, fingerprint };
}

// The version that goes on the URL for this stylesheet: a hash of the sheet as
// the browser will receive it, including every imported child's stamped form.
export async function renderedCSSVersion(filePath, roots = {}) {
  if (!filePath)
    return null;

  let result;
  try {
    result = await renderSheet(filePath, roots, new Set());
  } catch (_error) {
    return null;
  }

  if (!result.fingerprint || !result.version)
    return null;

  let cached = renderedVersionCache.get(result.fingerprint);
  if (cached)
    return cached;

  renderedVersionCache.set(result.fingerprint, result.version);
  // Unbounded growth would only ever cost memory on a dev box; cap it anyway.
  if (renderedVersionCache.size > 512)
    renderedVersionCache = new Map([ [result.fingerprint, result.version] ]);

  return result.version;
}

async function applyLinkVersion(tag, resolveVersion) {
  if (!/\brel\s*=\s*["']stylesheet["']/i.test(tag))
    return tag;

  let hrefMatch = tag.match(LINK_HREF_RE);
  if (!hrefMatch)
    return tag;

  let href = hrefMatch[2];
  let version = await resolveVersion(href);
  if (!version)
    return tag;

  let versioned = withAssetVersion(href, version);
  return tag.replace(LINK_HREF_RE, (_all, quote) => `href=${quote}${versioned}${quote}`);
}

export async function stampHTMLAssets(html, options = {}) {
  let resolveVersion = options.resolveVersion || (async (href) => {
    let filePath = resolveDocumentAsset(href, options);
    if (!isVersionedAsset(filePath || ''))
      return null;
    return renderedCSSVersion(filePath, options);
  });

  let tags = [];
  html.replace(LINK_TAG_RE, (tag) => {
    tags.push(tag);
    return tag;
  });

  if (tags.length === 0)
    return html;

  let stamped = [];
  for (let tag of tags)
    stamped.push(await applyLinkVersion(tag, resolveVersion));

  let index = 0;
  return html.replace(LINK_TAG_RE, () => stamped[index++]);
}

export async function stampCSSImports(css, resolve) {
  if (typeof css !== 'string' || !css.includes('@import'))
    return css;

  let matches = [ ...css.matchAll(CSS_IMPORT_RE) ];
  if (matches.length === 0)
    return css;

  // A remote specifier has no file in our trees, so any "version" for it would
  // be invented: rewriting a third-party URL corrupts CSS we do not own. Leave
  // it alone, but keep a null in the list so replace()'s counter stays aligned
  // with `matches`.
  let versions = await Promise.all(matches.map((match) => {
    if (isRemoteReference(match[2]))
      return null;
    return resolve(match[2]);
  }));

  let index = 0;
  return css.replace(CSS_IMPORT_RE, (all, quote, reference) => {
    let version = versions[index++];
    if (!version)
      return all;

    let versioned = withAssetVersion(reference, version);
    return all.replace(reference, versioned);
  });
}

// Entry point used by the static handler: given a file and the text about to be
// sent, return the text with its cache-busted references. Unknown file types
// are returned untouched.
export async function stampAssetText({ filePath, text, staticRoots, clientRoot, aeorWebComponentsRoot }) {
  let roots = staticRoots || { clientRoot, aeorWebComponentsRoot };
  let extension = path.extname(filePath || '').toLowerCase();

  if (extension === '.html') {
    return stampHTMLAssets(text, { ...roots });
  }

  if (extension === '.css') {
    let imported = await stampCSSImports(text, async (reference) => {
      let assetPath = resolveSheetReference(reference, filePath, roots);
      if (!isVersionedAsset(assetPath || ''))
        return null;
      return renderedCSSVersion(assetPath, roots);
    });

    let urls = await stampCSSUrls(imported, filePath, roots);
    return urls.text;
  }

  return text;
}
