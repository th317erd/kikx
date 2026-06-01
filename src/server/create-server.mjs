'use strict';

import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AppContext } from '../core/app/app-context.mjs';
import { AeorDBClient } from '../core/aeordb/aeordb-client.mjs';
import { AgentManager } from '../core/agents/agent-manager.mjs';
import { PluginRegistry } from '../core/plugins/index.mjs';
import { loadPlugins } from '../core/plugins/plugin-loader.mjs';
import { FrameRuntime } from '../core/runtime/frame-runtime.mjs';

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

  if (!context.has('frameRuntime'))
    context.set('frameRuntime', new FrameRuntime({ aeordb: context.require('aeordb') }));

  if (!context.has('pluginRegistry'))
    context.set('pluginRegistry', new PluginRegistry());

  if (!context.has('pluginLoadPromise')) {
    context.set('pluginLoadPromise', loadPlugins({
      pluginPaths: options.pluginPaths || process.env.KIKX_PLUGIN_PATHS || '',
      registry: context.require('pluginRegistry'),
      context,
    }));
  }

  if (!context.has('agentManager')) {
    context.set('agentManager', new AgentManager({
      aeordb: context.require('aeordb'),
      pluginRegistry: context.require('pluginRegistry'),
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
  if (context.has('pluginLoadPromise'))
    await context.require('pluginLoadPromise');

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

  if (request.method === 'GET' && url.pathname === '/api/v1/sessions') {
    let frameRuntime = context.require('frameRuntime');
    writeJSON(response, 200, {
      data: {
        sessions: await frameRuntime.listSessions({
          limit: parsePositiveInteger(url.searchParams.get('limit'), 50),
          offset: parseNonNegativeInteger(url.searchParams.get('offset'), 0),
        }),
      },
    });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/v1/agent-providers') {
    let agentManager = context.require('agentManager');
    writeJSON(response, 200, {
      data: {
        providers: agentManager.listProviders(),
      },
    });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/v1/agents') {
    let agentManager = context.require('agentManager');
    writeJSON(response, 200, {
      data: {
        agents: await agentManager.listAgents({
          limit: parsePositiveInteger(url.searchParams.get('limit'), 50),
          offset: parseNonNegativeInteger(url.searchParams.get('offset'), 0),
        }),
      },
    });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/v1/agents') {
    let body = await readJSON(request);
    validateAgentBody(body, { creating: true });

    let agentManager = context.require('agentManager');
    writeJSON(response, 201, {
      data: {
        agent: await agentManager.createAgent(body),
      },
    });
    return;
  }

  let agentRoute = matchAgentRoute(url.pathname);
  if (agentRoute) {
    let agentManager = context.require('agentManager');

    if (request.method === 'GET') {
      writeJSON(response, 200, {
        data: {
          agent: await agentManager.getAgent(agentRoute.agentID),
        },
      });
      return;
    }

    if (request.method === 'PATCH') {
      let body = await readJSON(request);
      validateAgentBody(body, { creating: false });
      writeJSON(response, 200, {
        data: {
          agent: await agentManager.updateAgent(agentRoute.agentID, body),
        },
      });
      return;
    }

    if (request.method === 'DELETE') {
      await agentManager.deleteAgent(agentRoute.agentID);
      response.writeHead(204);
      response.end();
      return;
    }
  }

  if (request.method === 'POST' && url.pathname === '/api/v1/sessions') {
    let body = await readJSON(request);
    if (body.title != null && (typeof body.title !== 'string' || body.title.trim() === ''))
      throw httpError(400, 'title must be a non-empty string');

    let frameRuntime = context.require('frameRuntime');
    let session = await frameRuntime.createSession({
      title: body.title,
      organizationID: body.organizationID || null,
      createdByUserID: body.createdByUserID || body.userID || null,
    });

    writeJSON(response, 201, {
      data: {
        session,
      },
    });
    return;
  }

  let sessionUpdateRoute = matchSessionUpdateRoute(url.pathname);
  if (request.method === 'PATCH' && sessionUpdateRoute) {
    let body = await readJSON(request);
    if (!body.title || typeof body.title !== 'string' || body.title.trim() === '')
      throw httpError(400, 'title must be a non-empty string');

    let frameRuntime = context.require('frameRuntime');
    let session = await frameRuntime.updateSession(sessionUpdateRoute.sessionID, {
      title: body.title,
    });

    writeJSON(response, 200, {
      data: {
        session,
      },
    });
    return;
  }

  let sessionRoute = matchSessionRoute(url.pathname);
  if (sessionRoute) {
    let frameRuntime = context.require('frameRuntime');

    if (request.method === 'GET' && sessionRoute.resource === 'frames') {
      writeJSON(response, 200, {
        data: {
          frames: await frameRuntime.listFrames(sessionRoute.sessionID),
        },
      });
      return;
    }

    if (request.method === 'POST' && sessionRoute.resource === 'messages') {
      let body = await readJSON(request);
      if (!body.text || typeof body.text !== 'string' || body.text.trim() === '')
        throw httpError(400, 'text is required');

      let result = await frameRuntime.appendUserMessage(sessionRoute.sessionID, {
        text: body.text,
        userID: body.userID || body.authorID || null,
      });

      writeJSON(response, 201, {
        data: result,
      });
      return;
    }
  }

  if (request.method === 'POST' && url.pathname === '/api/v1/auth/magic-link') {
    let body = await readJSON(request);
    if (!body.email || typeof body.email !== 'string')
      throw httpError(400, 'email is required');

    let aeordb = context.require('aeordb');
    writeJSON(response, 200, {
      data: await aeordb.requestMagicLink(body.email),
    });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/v1/auth/magic-link/verify') {
    let code = url.searchParams.get('code');
    if (!code)
      throw httpError(400, 'code is required');

    let aeordb = context.require('aeordb');
    writeJSON(response, 200, {
      data: await aeordb.verifyMagicLink(code),
    });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/v1/auth/token') {
    let body = await readJSON(request);
    if (!body.api_key || typeof body.api_key !== 'string')
      throw httpError(400, 'api_key is required');

    let aeordb = context.require('aeordb');
    writeJSON(response, 200, {
      data: await aeordb.exchangeAPIKey(body.api_key),
    });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/v1/auth/refresh') {
    let body = await readJSON(request);
    if (!body.refresh_token || typeof body.refresh_token !== 'string')
      throw httpError(400, 'refresh_token is required');

    let aeordb = context.require('aeordb');
    writeJSON(response, 200, {
      data: await aeordb.refreshToken(body.refresh_token),
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

async function readJSON(request) {
  let chunks = [];
  let size = 0;
  let maxSize = 1024 * 1024;

  for await (let chunk of request) {
    size += chunk.length;
    if (size > maxSize)
      throw httpError(413, 'Request body is too large');

    chunks.push(chunk);
  }

  if (chunks.length === 0)
    return {};

  let text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch (_error) {
    throw httpError(400, 'Request body must be valid JSON');
  }
}

function httpError(status, message) {
  let error = new Error(message);
  error.status = status;
  return error;
}

function parsePositiveInteger(value, fallback) {
  if (value == null)
    return fallback;

  let parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw httpError(400, 'limit must be a positive integer');

  return parsed;
}

function parseNonNegativeInteger(value, fallback) {
  if (value == null)
    return fallback;

  let parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0)
    throw httpError(400, 'offset must be a non-negative integer');

  return parsed;
}

function matchSessionUpdateRoute(pathname) {
  let match = /^\/api\/v1\/sessions\/([^/]+)$/.exec(pathname);
  if (!match)
    return null;

  return {
    sessionID: decodeURIComponent(match[1]),
  };
}

function matchSessionRoute(pathname) {
  let match = /^\/api\/v1\/sessions\/([^/]+)\/(frames|messages)$/.exec(pathname);
  if (!match)
    return null;

  return {
    sessionID: decodeURIComponent(match[1]),
    resource: match[2],
  };
}

function matchAgentRoute(pathname) {
  let match = /^\/api\/v1\/agents\/([^/]+)$/.exec(pathname);
  if (!match)
    return null;

  return {
    agentID: decodeURIComponent(match[1]),
  };
}

function validateAgentBody(body, options = {}) {
  if (options.creating && (!body.name || typeof body.name !== 'string' || body.name.trim() === ''))
    throw httpError(400, 'name must be a non-empty string');

  if (body.name != null && (typeof body.name !== 'string' || body.name.trim() === ''))
    throw httpError(400, 'name must be a non-empty string');

  if (options.creating && (!body.pluginID || typeof body.pluginID !== 'string' || body.pluginID.trim() === ''))
    throw httpError(400, 'pluginID must be a non-empty string');

  if (body.pluginID != null && (typeof body.pluginID !== 'string' || body.pluginID.trim() === ''))
    throw httpError(400, 'pluginID must be a non-empty string');

  if (body.config != null && (typeof body.config !== 'object' || Array.isArray(body.config)))
    throw httpError(400, 'config must be an object');

  if (body.secrets != null && (typeof body.secrets !== 'object' || Array.isArray(body.secrets)))
    throw httpError(400, 'secrets must be an object');

  if (body.clearSecrets != null && !Array.isArray(body.clearSecrets))
    throw httpError(400, 'clearSecrets must be an array');

  if (body.enabled != null && typeof body.enabled !== 'boolean')
    throw httpError(400, 'enabled must be a boolean');
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
