'use strict';

import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AppContext } from '../core/app/app-context.mjs';
import { AccountStore } from '../core/account/index.mjs';
import { AeorDBClient } from '../core/aeordb/aeordb-client.mjs';
import {
  AgentCwdStore,
  AgentManager,
  AgentTodoStore,
  registerAgentRouting,
} from '../core/agents/index.mjs';
import { CompactionService } from '../core/compaction/index.mjs';
import { CommandRegistry, registerInternalCommands } from '../core/commands/index.mjs';
import { PluginRegistry } from '../core/plugins/index.mjs';
import { loadPlugins } from '../core/plugins/plugin-loader.mjs';
import { FrameRouter } from '../core/routing/index.mjs';
import { FrameRuntime } from '../core/runtime/frame-runtime.mjs';
import { FeedbackStore } from '../core/feedback/index.mjs';
import { TokenUsageTracker } from '../core/tokens/index.mjs';
import {
  LocalCommandExecutionService,
  LocalFileAccessService,
  ProcessManager,
  PuppeteerBrowserService,
  registerBuiltInTools,
  ToolExecutionService,
  ToolOutputStore,
} from '../core/tools/index.mjs';

const CLIENT_ROOT = fileURLToPath(new URL('../client/', import.meta.url));
const DEFAULT_AEOR_WEB_COMPONENTS_ROOT = '/home/wyatt/Projects/aeor-web-components';
const DEFAULT_TOOL_OUTPUT_API_BYTES = 128 * 1024;

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

  if (!context.has('pluginRegistry'))
    context.set('pluginRegistry', new PluginRegistry());

  if (!context.has('builtInToolsRegistered')) {
    registerBuiltInTools(context.require('pluginRegistry'));
    context.set('builtInToolsRegistered', true);
  }

  if (!context.has('webBrowser')) {
    context.set('webBrowser', new PuppeteerBrowserService({
      logger: options.logger || console,
    }));
  }

  if (!context.has('fileAccess'))
    context.set('fileAccess', new LocalFileAccessService({ cwd: process.cwd() }));

  if (!context.has('commandExecutor'))
    context.set('commandExecutor', new LocalCommandExecutionService({ cwd: process.cwd() }));

  if (!context.has('toolOutputStore')) {
    context.set('toolOutputStore', new ToolOutputStore({
      aeordb: context.require('aeordb'),
    }));
  }

  if (!context.has('toolExecutor'))
    context.set('toolExecutor', new ToolExecutionService({
      toolOutputStore: context.require('toolOutputStore'),
    }));

  if (!context.has('commandRegistry'))
    context.set('commandRegistry', new CommandRegistry());

  if (!context.has('internalCommandsRegistered')) {
    registerInternalCommands({
      pluginRegistry: context.require('pluginRegistry'),
      commandRegistry: context.require('commandRegistry'),
    });
    context.set('internalCommandsRegistered', true);
  }

  if (!context.has('frameRouter'))
    context.set('frameRouter', new FrameRouter());

  if (!context.has('tokenUsage')) {
    context.set('tokenUsage', new TokenUsageTracker({
      aeordb: context.require('aeordb'),
    }));
  }

  if (!context.has('accountStore')) {
    context.set('accountStore', new AccountStore({
      aeordb: context.require('aeordb'),
    }));
  }

  if (!context.has('tokenUsageLoadPromise')) {
    let tokenUsage = context.require('tokenUsage');
    context.set('tokenUsageLoadPromise', Promise.resolve(
      typeof tokenUsage.load === 'function' ? tokenUsage.load() : tokenUsage.snapshot?.() || {},
    ));
  }

  if (!context.has('pluginLoadPromise')) {
    context.set('pluginLoadPromise', (async () => {
      await loadPlugins({
        pluginPaths: options.pluginPaths || process.env.KIKX_PLUGIN_PATHS || '',
        registry: context.require('pluginRegistry'),
        commandRegistry: context.require('commandRegistry'),
        context,
      });
      context.require('frameRouter').loadFromRegistry(context.require('pluginRegistry'));
      registerAgentRouting(context.require('frameRouter'));
    })());
  }

  if (!context.has('agentManager')) {
    context.set('agentManager', new AgentManager({
      aeordb: context.require('aeordb'),
      pluginRegistry: context.require('pluginRegistry'),
    }));
  }

  if (!context.has('agentTodoStore')) {
    context.set('agentTodoStore', new AgentTodoStore({
      aeordb: context.require('aeordb'),
    }));
  }

  if (!context.has('agentCwdStore')) {
    context.set('agentCwdStore', new AgentCwdStore({
      aeordb: context.require('aeordb'),
      baseCWD: process.cwd(),
    }));
  }

  if (!context.has('feedbackStore')) {
    context.set('feedbackStore', new FeedbackStore({
      aeordb: context.require('aeordb'),
    }));
  }

  if (!context.has('frameRuntime')) {
    context.set('frameRuntime', new FrameRuntime({
      aeordb: context.require('aeordb'),
      frameRouter: context.require('frameRouter'),
      services: { context },
    }));
  }

  if (!context.has('compactionService')) {
    context.set('compactionService', new CompactionService({
      agentManager: context.require('agentManager'),
      pluginRegistry: context.require('pluginRegistry'),
      frameRuntime: context.require('frameRuntime'),
      contextWindowTokens: parseEnvPositiveInteger(process.env.KIKX_CONTEXT_WINDOW_TOKENS, 128000),
      compactionAgentContextTokens: parseEnvPositiveInteger(process.env.KIKX_COMPACTION_AGENT_CONTEXT_TOKENS, 128000),
      promptReserveTokens: parseEnvNonNegativeInteger(process.env.KIKX_CONTEXT_PROMPT_RESERVE_TOKENS, 8000),
      compactionTriggerRatio: parseEnvRatio(process.env.KIKX_COMPACTION_TRIGGER_RATIO, 0.7),
      hardLimitRatio: parseEnvRatio(process.env.KIKX_COMPACTION_HARD_RATIO, 1),
      logger: options.logger || console,
    }));
  }

  if (!context.has('processManager')) {
    context.set('processManager', new ProcessManager({
      commandExecutor: context.require('commandExecutor'),
      toolOutputStore: context.require('toolOutputStore'),
      frameRuntime: context.require('frameRuntime'),
      context,
      logger: options.logger || console,
    }));
  }

  if (!context.has('runtimeRecoveryPromise')) {
    let frameRuntime = context.require('frameRuntime');
    let aeordb = context.require('aeordb');
    let logger = options.logger || console;
    context.set('runtimeRecoveryPromise', Promise.resolve(
      typeof frameRuntime.recoverStaleRuntimeFrames === 'function' && typeof aeordb.listDirectory === 'function'
        ? frameRuntime.recoverStaleRuntimeFrames()
        : { recovered: 0, skipped: true },
    ).then((result) => {
      if (result?.recovered > 0)
        logger.warn?.('Kikx recovered stale runtime frames', result);

      return result;
    }).catch((error) => {
      logger.error?.('Kikx stale runtime frame recovery failed', error);
      return { recovered: 0, error };
    }));
  }

  if (!context.has('scheduledFrameWorkerPromise')) {
    let frameRuntime = context.require('frameRuntime');
    context.set('scheduledFrameWorkerPromise', Promise.resolve(context.require('runtimeRecoveryPromise')).then(() => (
      typeof frameRuntime.startScheduledFrameWorker === 'function' && canLoadScheduledFrames(frameRuntime)
        ? frameRuntime.startScheduledFrameWorker()
        : null
    )).catch((error) => {
      (options.logger || console)?.error?.('Kikx scheduled frame worker failed to start', error);
      return null;
    }));
  }

  if (!context.has('tokenUsageRuntimeBridge')) {
    let tokenUsage = context.require('tokenUsage');
    let frameRuntime = context.require('frameRuntime');
    if (frameRuntime.tokenUsage !== tokenUsage)
      connectTokenUsageToRuntime(tokenUsage, frameRuntime);

    context.set('tokenUsageRuntimeBridge', true);
  }

  let server = http.createServer(async (request, response) => {
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
  server.kikxContext = context;
  return server;
}

function canLoadScheduledFrames(frameRuntime) {
  let aeordb = frameRuntime?.frameStore?.aeordb;
  return typeof frameRuntime?.frameStore?.listScheduledFrames === 'function'
    && (typeof aeordb?.searchFiles === 'function' || typeof aeordb?.listDirectory === 'function');
}

async function routeRequest({ request, response, context, staticRoots }) {
  if (context.has('pluginLoadPromise'))
    await context.require('pluginLoadPromise');

  if (context.has('tokenUsageLoadPromise'))
    await context.require('tokenUsageLoadPromise');

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

  if (request.method === 'GET' && url.pathname === '/api/v1/tokens') {
    let tokenUsage = context.require('tokenUsage');
    let snapshot = typeof tokenUsage.snapshot === 'function' ? tokenUsage.snapshot() : {};
    writeJSON(response, 200, {
      data: {
        tokenUsage: snapshot,
        totalTokensUsed: typeof tokenUsage.totalTokensUsed === 'function'
          ? tokenUsage.totalTokensUsed()
          : totalTokensUsed(snapshot),
      },
    });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/v1/account') {
    let accountStore = context.require('accountStore');
    let identity = accountStore.resolveIdentity(request);
    writeJSON(response, 200, {
      data: {
        account: await accountStore.getAccount(identity),
      },
    });
    return;
  }

  if (request.method === 'PATCH' && url.pathname === '/api/v1/account') {
    let body = await readJSON(request);
    let accountStore = context.require('accountStore');
    let identity = accountStore.resolveIdentity(request);
    writeJSON(response, 200, {
      data: {
        account: await accountStore.updateAccount(identity, body),
      },
    });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/v1/events') {
    let frameRuntime = context.require('frameRuntime');
    streamRuntimeEvents({ request, response, frameRuntime, sessionID: url.searchParams.get('sessionID') || '' });
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

  if (request.method === 'GET' && url.pathname === '/api/v1/client-components') {
    let pluginRegistry = context.require('pluginRegistry');
    writeJSON(response, 200, {
      data: {
        components: typeof pluginRegistry.listClientComponentDescriptors === 'function'
          ? pluginRegistry.listClientComponentDescriptors()
          : [],
      },
    });
    return;
  }

  let toolOutputRoute = matchToolOutputRoute(url.pathname);
  if (request.method === 'GET' && toolOutputRoute) {
    let toolOutputStore = context.require('toolOutputStore');
    let full = parseBoolean(url.searchParams.get('full'), false);
    let output = await toolOutputStore.getToolOutput({
      id: toolOutputRoute.outputID,
      start: parseOptionalNonNegativeInteger(url.searchParams.get('start')),
      end: parseOptionalPositiveInteger(url.searchParams.get('end')),
      maxBytes: full
        ? null
        : parseOptionalPositiveInteger(url.searchParams.get('maxBytes')) || DEFAULT_TOOL_OUTPUT_API_BYTES,
    });

    writeJSON(response, 200, {
      data: {
        output,
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
          frames: await frameRuntime.listFrames(sessionRoute.sessionID, {
            limit: parsePositiveInteger(url.searchParams.get('limit'), 1000),
            offset: parseNonNegativeInteger(url.searchParams.get('offset'), 0),
          }),
        },
      });
      return;
    }

    if (request.method === 'POST' && sessionRoute.resource === 'messages') {
      let body = await readJSON(request);
      if (!body.text || typeof body.text !== 'string' || body.text.trim() === '')
        throw httpError(400, 'text is required');

      let account = await getRequestAccount(context, request);
      let messageInput = {
        text: body.text,
        userID: account?.id || body.userID || body.authorID || null,
      };
      let authorDisplayName = account?.name || body.authorDisplayName || '';
      if (authorDisplayName)
        messageInput.authorDisplayName = authorDisplayName;

      let result = await frameRuntime.appendUserMessage(sessionRoute.sessionID, messageInput);

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

async function getRequestAccount(context, request) {
  if (!context.has('accountStore'))
    return null;

  let accountStore = context.require('accountStore');
  let identity;

  try {
    identity = accountStore.resolveIdentity(request);
  } catch (error) {
    if (error?.status === 401)
      return null;

    throw error;
  }

  return await accountStore.getAccount(identity);
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

function parseEnvPositiveInteger(value, fallback) {
  if (value == null || value === '')
    return fallback;

  let parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : fallback;
}

function parseEnvNonNegativeInteger(value, fallback) {
  if (value == null || value === '')
    return fallback;

  let parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseEnvRatio(value, fallback) {
  if (value == null || value === '')
    return fallback;

  let parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0)
    return fallback;

  return Math.min(parsed, 1);
}

function parseOptionalPositiveInteger(value) {
  if (value == null)
    return null;

  let parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw httpError(400, 'value must be a positive integer');

  return parsed;
}

function parseOptionalNonNegativeInteger(value) {
  if (value == null)
    return null;

  let parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0)
    throw httpError(400, 'value must be a non-negative integer');

  return parsed;
}

function parseBoolean(value, fallback = false) {
  if (value == null || value === '')
    return fallback;

  return value === '1' || value === 'true' || value === 'yes';
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

function matchToolOutputRoute(pathname) {
  let match = /^\/api\/v1\/tool-outputs\/([^/]+)$/.exec(pathname);
  if (!match)
    return null;

  return {
    outputID: decodeURIComponent(match[1]),
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

  if (body.character != null && typeof body.character !== 'string')
    throw httpError(400, 'character must be a string');

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

function streamRuntimeEvents({ request, response, frameRuntime, sessionID = '' }) {
  if (!frameRuntime || typeof frameRuntime.on !== 'function')
    throw httpError(500, 'Frame runtime does not support events');

  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });

  writeSSE(response, 'connected', { ok: true });

  let handler = (event) => {
    if (sessionID && event.sessionID && event.sessionID !== sessionID)
      return;

    writeSSE(response, event.type || 'message', event);
  };
  let cleanup = () => {
    frameRuntime.off?.('event', handler);
    clearInterval(heartbeat);
  };
  let heartbeat = setInterval(() => {
    if (!response.destroyed)
      response.write(': heartbeat\n\n');
  }, 25000);
  heartbeat.unref?.();

  frameRuntime.on('event', handler);
  request.on('close', cleanup);
}

function writeSSE(response, event, data) {
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}

function connectTokenUsageToRuntime(tokenUsage, frameRuntime) {
  if (!tokenUsage || typeof tokenUsage.on !== 'function' || !frameRuntime)
    return;

  tokenUsage.on('updated', (event) => {
    let payload = event || {};
    if (typeof frameRuntime.emitRuntimeEvent === 'function') {
      frameRuntime.emitRuntimeEvent('tokens.updated', payload);
      return;
    }

    frameRuntime.emit?.('event', {
      type: 'tokens.updated',
      ...payload,
    });
  });
}

function totalTokensUsed(snapshot) {
  let total = 0;
  for (let entry of Object.values(snapshot || {})) {
    let value = Number(entry?.tokensUsed);
    if (Number.isFinite(value) && value > 0)
      total += Math.trunc(value);
  }

  return total;
}
