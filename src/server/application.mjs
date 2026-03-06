'use strict';

// =============================================================================
// V2 Application — extends MythixApplication
// =============================================================================
// Creates KikxCore first, then starts Mythix HTTP server.
// Exposes core services to controllers via getCore(), getAuthService(), etc.
// Overrides createDatabaseConnection() to reuse KikxCore's connection.
// =============================================================================

import { Application as MythixApplication } from 'mythix';

import { getRoutes }       from './routes/index.mjs';
import * as Controllers    from './controllers/index.mjs';
import { KikxCore }        from '../core/kikx-core.mjs';
import { Keystore }        from '../core/crypto/keystore.mjs';
import { AuthService }     from './auth/index.mjs';
import { SessionManager }  from '../core/session/index.mjs';
import { FramePersistence } from '../core/frames/index.mjs';
import { InteractionLoop }  from '../core/interaction/index.mjs';
import { ContentSanitizer } from '../core/lib/content-sanitizer.mjs';
import { SessionScheduler }      from '../core/scheduling/session-scheduler.mjs';
import { AgentResolver }         from '../core/scheduling/agent-resolver.mjs';
import { SchedulerOrchestrator } from '../core/scheduling/scheduler-orchestrator.mjs';

export class Application extends MythixApplication {
  static getName() {
    return 'kikx-v2';
  }

  constructor(_options) {
    let options = Object.assign({}, {
      httpServer: {
        middleware: [],
      },
    }, _options || {});

    super(options);

    this._core        = null;
    this._keystore    = null;
    this._authService = null;
  }

  // ---------------------------------------------------------------------------
  // Routes + Controllers
  // ---------------------------------------------------------------------------

  getRoutes(...args) {
    return getRoutes.apply(this, args);
  }

  getAppControllerClasses() {
    return {
      ...super.getAppControllerClasses(),
      ...Controllers,
    };
  }

  // ---------------------------------------------------------------------------
  // Core Lifecycle
  // ---------------------------------------------------------------------------

  async start(options) {
    // Initialize KikxCore before Mythix starts its HTTP server
    await this._initializeCore(options);

    // Now start Mythix (which starts the HTTP server)
    await super.start(options);
  }

  async stop() {
    // Stop orchestrator before tearing down core
    if (this._core) {
      let orchestrator = this._core.getContext().getProperty('schedulerOrchestrator');
      if (orchestrator)
        orchestrator.stop();
    }

    // Stop Mythix HTTP server first
    await super.stop();

    // Then tear down KikxCore
    if (this._core) {
      await this._core.stop();
      this._core = null;
    }

    if (this._keystore) {
      this._keystore.destroy();
      this._keystore = null;
    }

    this._authService = null;
  }

  async _initializeCore(options) {
    let coreConfig = (options && options.core) || this.getOptions().core || {};

    // Create and start KikxCore
    this._core = new KikxCore(coreConfig);
    await this._core.start();

    let context = this._core.getContext();

    // Initialize keystore
    let keystoreConfig = (options && options.keystore) || this.getOptions().keystore || {};

    // In development, use a deterministic REK so JWTs survive server restarts
    let environment = this.getOptions().environment || 'development';
    if (environment === 'development' && !keystoreConfig.devMode) {
      keystoreConfig = { ...keystoreConfig, devMode: true, devSeed: 'kikx-development-seed' };
    }

    this._keystore = new Keystore(keystoreConfig);
    this._keystore.initialize();
    context.setProperty('keystore', this._keystore);

    // Initialize auth service
    this._authService = new AuthService({ context, keystore: this._keystore });

    // Initialize core services
    let sessionManager  = new SessionManager(context);
    let framePersistence = new FramePersistence(context);
    let sanitizer       = new ContentSanitizer();
    let interactionLoop = new InteractionLoop(context);

    // Initialize scheduler for multi-agent coordination
    let sessionScheduler = new SessionScheduler({
      sessionManager,
      interactionLoop,
    });

    // Initialize agent resolver and scheduler orchestrator
    let agentResolver = new AgentResolver(this._core);
    let orchestrator  = new SchedulerOrchestrator({
      scheduler:       sessionScheduler,
      agentResolver,
      interactionLoop,
    });

    orchestrator.start();

    context.setProperty('sessionManager', sessionManager);
    context.setProperty('framePersistence', framePersistence);
    context.setProperty('contentSanitizer', sanitizer);
    context.setProperty('interactionLoop', interactionLoop);
    context.setProperty('sessionScheduler', sessionScheduler);
    context.setProperty('agentResolver', agentResolver);
    context.setProperty('schedulerOrchestrator', orchestrator);
  }

  // ---------------------------------------------------------------------------
  // Override database connection to reuse KikxCore's
  // ---------------------------------------------------------------------------

  async createDatabaseConnection() {
    // KikxCore already owns the database connection.
    // Return it so Mythix doesn't create a second one.
    if (this._core)
      return this._core.getConnection();

    return null;
  }

  // ---------------------------------------------------------------------------
  // Core Accessors (used by controllers via this.getApplication())
  // ---------------------------------------------------------------------------

  getCore() {
    return this._core;
  }

  getAuthService() {
    return this._authService;
  }

  getKeystore() {
    return this._keystore;
  }
}
