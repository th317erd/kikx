'use strict';

import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AppContext } from '../core/app/app-context.mjs';
import { AeorDBClient } from '../core/aeordb/aeordb-client.mjs';

const CLIENT_ROOT = fileURLToPath(new URL('../client/', import.meta.url));
const DEFAULT_AEOR_WEB_COMPONENTS_ROOT = '/home/wyatt/Projects/aeor-web-components';

export function createServer(options = {}) {
  let context = options.context || new AppContext();
  let staticRoots = {
    client: options.clientRoot || CLIENT_ROOT,
    aeorWebComponents: options.aeorWebComponentsRoot || process.env.AEOR_WEB_COMPONENTS_DIR || DEFAULT_AEOR_WEB_COMPONENTS_ROOT,
  };

  if (!context.has('aeordb')) {
    context.set('aeordb', new AeorDBClient({
      baseURL: options.aeorDBURL || process.env.AEORDB_URL || 'http://127.0.0.1:6830',
      token: options.aeorDBToken || process.env.AEORDB_TOKEN || '',
      fetchImpl: options.fetchImpl || globalThis.fetch,
    }));
  }

  return http.createServer(async (request, response) => {
    try {
      await routeRequest({ request, response, context, staticRoots });
    } catch (error) {
      writeJSON(response, error.status || 500, {
        error: {
          message: error.message || 'Internal Server Error',
        },
      });
    }
  });
}

async function routeRequest({ request, response, context, staticRoots }) {
  let url = new URL(request.url, 'http://localhost');

  if (request.method === 'GET' && url.pathname === '/health') {
    writeJSON(response, 200, {
      ok: true,
      services: {
        aeordb: context.has('aeordb'),
      },
    });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/v1/aeordb/events-url') {
    let aeordb = context.require('aeordb');
    writeJSON(response, 200, {
      data: {
        url: aeordb.eventsURL({
          events: url.searchParams.get('events'),
          path_prefix: url.searchParams.get('path_prefix'),
        }),
      },
    });
    return;
  }

  if (request.method === 'GET' || request.method === 'HEAD') {
    let handled = await serveStaticRequest({ request, response, url, staticRoots });
    if (handled)
      return;
  }

  writeJSON(response, 404, {
    error: {
      message: 'Not Found',
    },
  });
}

async function serveStaticRequest({ request, response, url, staticRoots }) {
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

function writeText(response, statusCode, body) {
  response.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
  });
  response.end(body);
}

function writeJSON(response, statusCode, body) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(body));
}
