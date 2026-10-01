'use strict';

import fs from 'node:fs/promises';
import path from 'node:path';

import { writeText } from './http-helpers.mjs';

export async function serveStaticRequest({ request, response, url, staticRoots }) {
  let match = getStaticAsset(url.pathname, staticRoots);
  if (!match)
    return false;

  if (!match.filePath) {
    writeText(response, 403, 'Forbidden');
    return true;
  }

  await serveResolvedFile({ request, response, filePath: match.filePath, cacheControl: match.cacheControl });
  return true;
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
