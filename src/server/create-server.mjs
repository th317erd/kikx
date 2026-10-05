'use strict';

import http from 'node:http';
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
import { registerCoreClasses, resolveCoreClass } from '../core/plugins/core-classes.mjs';
import { FrameRouter } from '../core/routing/index.mjs';
import { FrameRuntime } from '../core/runtime/frame-runtime.mjs';
import { FeedbackStore } from '../core/feedback/index.mjs';
import { TeamManager } from '../core/teams/index.mjs';
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

import {
  parseEnvNonNegativeInteger,
  parseEnvPositiveInteger,
  parseEnvRatio,
  writeJSON,
} from './http-helpers.mjs';
import { connectTokenUsageToRuntime } from './events.mjs';
import { routeRequest } from './router.mjs';

const CLIENT_ROOT = fileURLToPath(new URL('../client/', import.meta.url));
const SHARED_ROOT = fileURLToPath(new URL('../shared/', import.meta.url));
const DEFAULT_AEOR_WEB_COMPONENTS_ROOT = '/home/wyatt/Projects/aeor-web-components';

export function createServer(options = {}) {
  let context = options.context || new AppContext();
  let staticRoots = {
    client: options.clientRoot || CLIENT_ROOT,
    shared: options.sharedRoot || SHARED_ROOT,
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

  // Register override-worthy core classes into the universal ClassRegistry so a
  // plugin can replace them (registerClass the same key) and unregisterPlugin
  // can pop back to core.
  if (!context.has('coreClassesRegistered')) {
    registerCoreClasses(context.require('pluginRegistry'));
    context.set('coreClassesRegistered', true);
  }

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

  if (!context.has('frameRouter')) {
    // Resolve via the registry so a plugin can override FrameRouter.
    let RouterClass = resolveCoreClass(context.require('pluginRegistry'), 'FrameRouter', FrameRouter);
    context.set('frameRouter', new RouterClass());
  }

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

  if (!context.has('teamManager')) {
    context.set('teamManager', new TeamManager({
      aeordb: context.require('aeordb'),
      agentManager: context.require('agentManager'),
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
    let RuntimeClass = resolveCoreClass(context.require('pluginRegistry'), 'FrameRuntime', FrameRuntime);
    context.set('frameRuntime', new RuntimeClass({
      aeordb: context.require('aeordb'),
      frameRouter: context.require('frameRouter'),
      services: { context },
    }));
  }

  if (!context.has('compactionService')) {
    let CompactionClass = resolveCoreClass(context.require('pluginRegistry'), 'CompactionService', CompactionService);
    context.set('compactionService', new CompactionClass({
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

  // Readiness gate for probes and the deploy verifier: false until startup
  // recovery and the scheduled-frame worker have settled, so a probe never
  // observes the transient window before persisted scheduled frames are loaded.
  // Exposed verbatim as `ready` on GET /health.
  if (!context.has('startupReady')) {
    context.set('startupReady', false);
    Promise.resolve(context.require('scheduledFrameWorkerPromise'))
      .catch(() => {})
      .then(() => {
        context.set('startupReady', true);
      });
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
