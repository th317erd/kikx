'use strict';

import http from 'node:http';
import { fileURLToPath } from 'node:url';

import { AppContext } from '../core/app/app-context.mjs';
import { AccountStore } from '../core/account/index.mjs';
import { createAuthService } from '../core/auth/index.mjs';
import { createMailer } from '../core/auth/mailer.mjs';
import {
  AEORDB_TOKEN_PATH,
  AEORDB_URL_PATH,
  AEOR_WEB_COMPONENTS_DIR_PATH,
  DATABASE_DRIVER_PATH,
  DATABASE_PATH_PATH,
  DATABASE_URL_PATH,
  KIKX_ADMIN_EMAIL_PATH,
  KIKX_ADMIN_NAME_PATH,
  KIKX_AUTH_ACCESS_TTL_SECONDS_PATH,
  KIKX_AUTH_MAGIC_LINK_TTL_SECONDS_PATH,
  KIKX_AUTH_MAILER_FROM_PATH,
  KIKX_AUTH_MAILER_MODE_PATH,
  KIKX_AUTH_MAILER_SMTP_URL_PATH,
  KIKX_AUTH_PUBLIC_URL_PATH,
  KIKX_AUTH_REFRESH_TTL_SECONDS_PATH,
  KIKX_COMPACTION_AGENT_ID_PATH,
  KIKX_COMPACTION_AGENT_CONTEXT_TOKENS_PATH,
  KIKX_COMPACTION_HARD_RATIO_PATH,
  KIKX_COMPACTION_TRIGGER_RATIO_PATH,
  KIKX_CONTEXT_PROMPT_RESERVE_TOKENS_PATH,
  KIKX_CONTEXT_WINDOW_TOKENS_PATH,
  KIKX_DATABASE_DRIVER_PATH,
  KIKX_DATABASE_PATH,
  KIKX_DATABASE_URL,
  KIKX_PLUGIN_PATHS_PATH,
  createConfigStore,
} from '../core/config/index.mjs';
import { resolveDatabaseDriver } from '../core/database/index.mjs';
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

export async function createServer(options = {}) {
  let context = options.context || new AppContext();
  let config = options.config || context.get('config') || await createConfigStore({ jsonEnvPath: options.jsonEnvPath });
  context.set('config', config);

  // Resolve every config-derived value ONCE, before any store guard. All awaits
  // happen here so the guard/set pairs below run as one synchronous section: a
  // shared `context` is never observed half-wired while values are pending.
  let pluginPaths = options.pluginPaths || await config.get(KIKX_PLUGIN_PATHS_PATH) || '';
  let aeorWebComponentsRoot = options.aeorWebComponentsRoot || await config.get(AEOR_WEB_COMPONENTS_DIR_PATH) || DEFAULT_AEOR_WEB_COMPONENTS_ROOT;
  let aeorDBURL = options.aeorDBURL || await config.get(AEORDB_URL_PATH) || 'http://127.0.0.1:6830';
  let aeorDBToken = options.aeorDBToken || await config.get(AEORDB_TOKEN_PATH) || '';
  let databaseDriver = options.databaseDriver || await config.get(DATABASE_DRIVER_PATH) || await config.get(KIKX_DATABASE_DRIVER_PATH) || 'aeordb';
  let databasePath = options.databasePath || await config.get(DATABASE_PATH_PATH) || await config.get(KIKX_DATABASE_PATH) || null;
  let databaseURL = options.databaseURL || await config.get(DATABASE_URL_PATH) || await config.get(KIKX_DATABASE_URL) || null;
  let contextWindowTokens = parseEnvPositiveInteger(await config.get(KIKX_CONTEXT_WINDOW_TOKENS_PATH), 128000);
  let compactionAgentID = await config.get(KIKX_COMPACTION_AGENT_ID_PATH);
  let compactionAgentContextTokens = parseEnvPositiveInteger(await config.get(KIKX_COMPACTION_AGENT_CONTEXT_TOKENS_PATH), 128000);
  let promptReserveTokens = parseEnvNonNegativeInteger(await config.get(KIKX_CONTEXT_PROMPT_RESERVE_TOKENS_PATH), 8000);
  let compactionTriggerRatio = parseEnvRatio(await config.get(KIKX_COMPACTION_TRIGGER_RATIO_PATH), 0.7);
  let hardLimitRatio = parseEnvRatio(await config.get(KIKX_COMPACTION_HARD_RATIO_PATH), 1);
  let authAdminEmail = options.authAdminEmail || await config.get(KIKX_ADMIN_EMAIL_PATH) || '';
  let authAdminName = options.authAdminName || await config.get(KIKX_ADMIN_NAME_PATH) || '';
  let authPublicURL = options.authPublicURL || await config.get(KIKX_AUTH_PUBLIC_URL_PATH) || '';
  let authMailerMode = options.authMailerMode || await config.get(KIKX_AUTH_MAILER_MODE_PATH) || 'log';
  let authMailerSMTPURL = options.authMailerSMTPURL || await config.get(KIKX_AUTH_MAILER_SMTP_URL_PATH) || '';
  let authMailerFrom = options.authMailerFrom || await config.get(KIKX_AUTH_MAILER_FROM_PATH) || 'Kikx <no-reply@localhost>';
  let authAccessTTLSeconds = parseEnvPositiveInteger(await config.get(KIKX_AUTH_ACCESS_TTL_SECONDS_PATH), 3600);
  let authRefreshTTLSeconds = parseEnvPositiveInteger(await config.get(KIKX_AUTH_REFRESH_TTL_SECONDS_PATH), 2592000);
  let authMagicLinkTTLSeconds = parseEnvPositiveInteger(await config.get(KIKX_AUTH_MAGIC_LINK_TTL_SECONDS_PATH), 900);

  let staticRoots = {
    client: options.clientRoot || CLIENT_ROOT,
    shared: options.sharedRoot || SHARED_ROOT,
    aeorWebComponents: aeorWebComponentsRoot,
  };

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

  if (!context.has('pluginLoadPromise')) {
    context.set('pluginLoadPromise', (async () => {
      await loadPlugins({
        pluginPaths,
        registry: context.require('pluginRegistry'),
        commandRegistry: context.require('commandRegistry'),
        context,
      });
      context.require('frameRouter').loadFromRegistry(context.require('pluginRegistry'));
      registerAgentRouting(context.require('frameRouter'));
    })());
  }

  // Plugins must be loaded before the driver is resolved: a plugin may register
  // the selected driver. The built-in aeordb driver is registered by
  // registerCoreClasses, so a default boot always has at least one driver.
  await context.require('pluginLoadPromise');

  if (!context.has('db')) {
    // `aeordb` remains an alias for hosts/tests that inject it directly.
    let injectedLegacy = context.has('aeordb') && !options.databaseDriver;
    if (injectedLegacy) {
      // Tests/host embeddings may inject a ready client; expose it under both names.
      context.set('db', context.require('aeordb'));
    } else {
      let { driverID, DriverClass } = resolveDatabaseDriver(context.require('pluginRegistry'), databaseDriver);
      let db = new DriverClass({
        context,
        config,
        baseURL: options.aeorDBURL || aeorDBURL,
        // Generic connection URL for network drivers (PostgreSQL). AeorDB still
        // prefers its own baseURL above, so its behaviour is unchanged.
        url: databaseURL || options.aeorDBURL || aeorDBURL,
        // Generic location option for drivers that take a file/URL (e.g.
        // SQLite). AeorDB ignores it and keeps its own baseURL/url defaults.
        filename: databasePath || databaseURL || undefined,
        token: options.aeorDBToken ?? aeorDBToken,
        secrets: { url: databaseURL || aeorDBURL, token: aeorDBToken, filename: databasePath || undefined },
        fetchImpl: options.fetchImpl || globalThis.fetch,
      });
      if (typeof db.connect === 'function')
        await db.connect();

      context.set('db', db);
      context.set('aeordb', db);
      context.set('databaseDriverID', driverID);
    }
  }

  // Keep the `aeordb` alias for hosts/tests that read it. If a host
  // injected only `db`, mirror it so the alias is never missing.
  if (context.has('db') && !context.has('aeordb'))
    context.set('aeordb', context.require('db'));

  if (!context.has('authService')) {
    let logger = options.logger || console;
    let mailer = createMailer({ mode: authMailerMode, log: logger, smtpUrl: authMailerSMTPURL, from: authMailerFrom });
    context.set('authService', createAuthService({
      db: context.require('db'),
      mailer,
      logger,
      accessTTLSeconds: authAccessTTLSeconds,
      refreshTTLSeconds: authRefreshTTLSeconds,
      magicLinkTTLSeconds: authMagicLinkTTLSeconds,
      publicURL: authPublicURL || '',
    }));
  }

  if (!context.has('toolOutputStore')) {
    context.set('toolOutputStore', new ToolOutputStore({
      db: context.require('db'),
    }));
  }

  if (!context.has('toolExecutor'))
    context.set('toolExecutor', new ToolExecutionService({
      toolOutputStore: context.require('toolOutputStore'),
    }));

  if (!context.has('tokenUsage')) {
    context.set('tokenUsage', new TokenUsageTracker({
      db: context.require('db'),
    }));
  }

  if (!context.has('accountStore')) {
    context.set('accountStore', new AccountStore({
      db: context.require('db'),
      authService: context.require('authService'),
    }));
  }

  // Best-effort first-run bootstrap. It is never awaited and never fatal: a
  // storage failure (or a test double without list/put) only produces a
  // warning, so an existing server still starts and serves traffic.
  if (!context.has('authBootstrapPromise')) {
    let authService = context.require('authService');
    let logger = options.logger || console;
    let canList = typeof context.require('db')?.list === 'function';
    context.set('authBootstrapPromise', (async () => {
      try {
        if (options.skipAuthBootstrap)
          return { skipped: true };

        if (authAdminEmail) {
          let { user, created } = await authService.ensureAdmin({ email: authAdminEmail, name: authAdminName });
          if (created) {
            logger.info?.(`Kikx created the initial admin account ${user.email}`);
            await authService.requestMagicLink(user.email);
          }

          return { created };
        }

        if (canList && (await authService.users.count()) === 0)
          logger.warn?.('Kikx has no user accounts; set KIKX_ADMIN_EMAIL to create the first account.');

        return { created: false };
      } catch (error) {
        logger.warn?.(`Kikx auth bootstrap skipped: ${error?.message || error}`);
        return { error };
      }
    })());
  }

  if (!context.has('tokenUsageLoadPromise')) {
    let tokenUsage = context.require('tokenUsage');
    context.set('tokenUsageLoadPromise', Promise.resolve(
      typeof tokenUsage.load === 'function' ? tokenUsage.load() : tokenUsage.snapshot?.() || {},
    ));
  }

  if (!context.has('agentManager')) {
    context.set('agentManager', new AgentManager({
      db: context.require('db'),
      pluginRegistry: context.require('pluginRegistry'),
    }));
  }

  if (!context.has('teamManager')) {
    context.set('teamManager', new TeamManager({
      db: context.require('db'),
      agentManager: context.require('agentManager'),
    }));
  }

  if (!context.has('agentTodoStore')) {
    context.set('agentTodoStore', new AgentTodoStore({
      db: context.require('db'),
    }));
  }

  if (!context.has('agentCwdStore')) {
    context.set('agentCwdStore', new AgentCwdStore({
      db: context.require('db'),
      baseCWD: process.cwd(),
    }));
  }

  if (!context.has('feedbackStore')) {
    context.set('feedbackStore', new FeedbackStore({
      db: context.require('db'),
    }));
  }

  if (!context.has('frameRuntime')) {
    let RuntimeClass = resolveCoreClass(context.require('pluginRegistry'), 'FrameRuntime', FrameRuntime);
    context.set('frameRuntime', new RuntimeClass({
      db: context.require('db'),
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
      contextWindowTokens,
      compactionAgentID,
      compactionAgentContextTokens,
      promptReserveTokens,
      compactionTriggerRatio,
      hardLimitRatio,
      logger: options.logger || console,
    }));
  }

  if (!context.has('processManager')) {
    context.set('processManager', new ProcessManager({
      commandExecutor: context.require('commandExecutor'),
      toolOutputStore: context.require('toolOutputStore'),
      db: context.require('db'),
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

  // Rehydrate durable process records before the scheduled-frame worker fires any
  // reloaded wake, so an `exec-status` on a persisted process resolves instead of
  // throwing "Unknown process".
  if (!context.has('processRecoveryPromise')) {
    let processManager = context.require('processManager');
    let aeordb = context.require('aeordb');
    let logger = options.logger || console;
    let canList = typeof aeordb?.listDirectory === 'function';
    context.set('processRecoveryPromise', Promise.resolve(context.require('runtimeRecoveryPromise')).then(async () => {
      if (!canList || typeof processManager.rehydrate !== 'function')
        return { rehydrated: 0, skipped: true };

      let result = await processManager.rehydrate();
      if (result.interrupted > 0)
        logger.warn?.('Kikx rehydrated interrupted async processes', { interrupted: result.interrupted });

      return result;
    }).catch((error) => {
      logger.error?.('Kikx process rehydration failed', error);
      return { rehydrated: 0, interrupted: 0, error };
    }));
  }

  if (!context.has('scheduledFrameWorkerPromise')) {
    let frameRuntime = context.require('frameRuntime');
    let processManager = context.require('processManager');
    let logger = options.logger || console;
    context.set('scheduledFrameWorkerPromise', Promise.resolve(context.require('processRecoveryPromise')).then(async () => {
      let worker = (typeof frameRuntime.startScheduledFrameWorker === 'function' && canLoadScheduledFrames(frameRuntime))
        ? await frameRuntime.startScheduledFrameWorker()
        : null;

      // After the worker has loaded persisted timers, reschedule any completed
      // process whose wake was never persisted (the scheduling step was
      // interrupted). Already-persisted pending wakes are left to the worker.
      if (typeof processManager.recoverPendingWakes === 'function') {
        let recovered = await processManager.recoverPendingWakes({ frameRuntime });
        if (recovered.recovered > 0)
          logger.warn?.('Kikx rescheduled async process wakes', { recovered: recovered.recovered });
      }

      return worker;
    }).catch((error) => {
      logger.error?.('Kikx scheduled frame worker failed to start', error);
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
