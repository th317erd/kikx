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

  let stats;
  try {
    stats = await fs.stat(match.filePath);
  } catch (_error) {
    writeText(response, 404, 'Not Found');
    return true;
  }

  if (!stats.isFile()) {
    writeText(response, 404, 'Not Found');
    return true;
  }

  let headers = {
    'Content-Type': contentTypeFor(match.filePath),
    'Content-Length': stats.size,
    'Cache-Control': match.cacheControl || 'no-cache',
  };

  response.writeHead(200, headers);
  if (request.method === 'HEAD') {
    response.end();
    return true;
  }

  let body = await fs.readFile(match.filePath);
  response.end(body);
  return true;
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

  if (decodedPath.includes('\0'))
    return null;

  let resolvedRoot = path.resolve(root);
  let candidate = path.resolve(resolvedRoot, decodedPath);
  let relative = path.relative(resolvedRoot, candidate);

  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)))
    return candidate;

  return null;
}

function contentTypeFor(filePath) {
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
