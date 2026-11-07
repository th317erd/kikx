'use strict';

import fs from 'node:fs/promises';
import path from 'node:path';

import { stampAssetText } from './asset-stamping.mjs';
import { writeText } from './http-helpers.mjs';

// Documents and stylesheets carry references that must change when the bytes
// behind them change; see asset-stamping.mjs for why (Cloudflare rewrites
// `no-cache` to `max-age=14400` on `.css`, so an unchanged URL stays stale for
// four hours after a deploy).
const STAMPED_EXTENSIONS = new Set([ '.html', '.css' ]);

export async function serveStaticRequest({ request, response, url, staticRoots }) {
  let match = getStaticAsset(url.pathname, staticRoots);
  if (!match)
    return false;

  if (!match.filePath) {
    writeText(response, 403, 'Forbidden');
    return true;
  }

  if (STAMPED_EXTENSIONS.has(path.extname(match.filePath).toLowerCase())) {
    await serveStampedFile({
      request,
      response,
      filePath: match.filePath,
      cacheControl: match.cacheControl,
      staticRoots,
    });
    return true;
  }

  await serveResolvedFile({ request, response, filePath: match.filePath, cacheControl: match.cacheControl });
  return true;
}

// Serve a file after rewriting its cache-busting references. Only reachable
// through the static roots above, never for plugin assets: a plugin's own
// files are not ours to rewrite.
//
// Stamping happens here, at serve time, never on disk. `index.html` keeps its
// plain hrefs so repository guards can still resolve them against the working
// tree, and a stamped URL still returns the exact bytes of the sheet on disk.
async function serveStampedFile({ request, response, filePath, cacheControl = 'no-cache', staticRoots }) {
  let stats;
  try {
    stats = await fs.stat(filePath);
  } catch (_error) {
    writeText(response, 404, 'Not Found');
    return;
  }

  if (!stats.isFile()) {
    writeText(response, 404, 'Not Found');
    return;
  }

  // A stamping failure must never break delivery. Unstamped text serves the
  // same content on an unchanged URL — the pre-existing cache behaviour — which
  // is strictly better than a 500 on the document root.
  let body;
  try {
    let text = await fs.readFile(filePath, 'utf8');
    body = Buffer.from(await stampAssetText({ filePath, text, staticRoots }), 'utf8');
  } catch (_error) {
    try {
      body = await fs.readFile(filePath);
    } catch (_readError) {
      writeText(response, 404, 'Not Found');
      return;
    }
  }

  response.writeHead(200, {
    'Content-Type': contentTypeFor(filePath),
    // Stamped text can be longer than the file on disk, so the length is the
    // rendered one. Sending `stats.size` here truncates the document.
    'Content-Length': body.length,
    'Cache-Control': cacheControl,
  });

  if (request.method === 'HEAD') {
    response.end();
    return;
  }

  response.end(body);
}

// Stream a known, already-resolved file. Shared by the static roots and the
// plugin asset route. A missing/non-file path yields 404; a null path yields
// 403 (used when a caller rejects a traversal attempt).
export async function serveResolvedFile({ request, response, filePath, cacheControl = 'no-cache' }) {
  if (!filePath) {
    writeText(response, 403, 'Forbidden');
    return;
  }

  let stats;
  try {
    stats = await fs.stat(filePath);
  } catch (_error) {
    writeText(response, 404, 'Not Found');
    return;
  }

  if (!stats.isFile()) {
    writeText(response, 404, 'Not Found');
    return;
  }

  let headers = {
    'Content-Type': contentTypeFor(filePath),
    'Content-Length': stats.size,
    'Cache-Control': cacheControl,
  };

  response.writeHead(200, headers);
  if (request.method === 'HEAD') {
    response.end();
    return;
  }

  let body = await fs.readFile(filePath);
  response.end(body);
}

function getStaticAsset(pathname, staticRoots) {
  if (pathname === '/' || pathname === '/index.html') {
    return {
      filePath: safeResolve(staticRoots.client, 'index.html'),
      cacheControl: 'no-cache',
    };
  }

  if (pathname.startsWith('/client/')) {
    return {
      filePath: safeResolve(staticRoots.client, pathname.slice('/client/'.length)),
      cacheControl: 'no-cache',
    };
  }

  if (pathname.startsWith('/shared/')) {
    return {
      filePath: safeResolve(staticRoots.shared, pathname.slice('/shared/'.length)),
      cacheControl: 'no-cache',
    };
  }

  if (pathname.startsWith('/vendor/aeor-web-components/')) {
    return {
      filePath: safeResolve(staticRoots.aeorWebComponents, pathname.slice('/vendor/aeor-web-components/'.length)),
      cacheControl: 'no-cache',
    };
  }

  return null;
}

function safeResolve(root, relativePath) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(relativePath);
  } catch (_error) {
    return null;
  }

  return resolveWithin(root, decodedPath);
}

// Resolve `relativePath` under `root`, rejecting traversal (encoded or raw
// `..`), null bytes, and absolute escapes. Returns the absolute candidate
// path, or null when the path would escape the root.
export function resolveWithin(root, relativePath) {
  if (typeof relativePath !== 'string' || relativePath.includes('\0'))
    return null;

  let resolvedRoot = path.resolve(root);
  let candidate = path.resolve(resolvedRoot, relativePath);
  let relative = path.relative(resolvedRoot, candidate);

  if (relative.startsWith('..') || path.isAbsolute(relative))
    return null;

  return candidate;
}

export function contentTypeFor(filePath) {
  let ext = path.extname(filePath).toLowerCase();
  let types = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.ico': 'image/x-icon',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
  };

  return types[ext] || 'application/octet-stream';
}
