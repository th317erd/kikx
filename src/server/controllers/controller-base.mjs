'use strict';

// =============================================================================
// ControllerBase — V2 base controller with core accessors
// =============================================================================
// Extends Mythix ControllerBase with convenience methods for accessing
// KikxCore services. All V2 controllers inherit from this.
// =============================================================================

import { ControllerBase as MythixControllerBase } from 'mythix';

export class ControllerBase extends MythixControllerBase {
  // ---------------------------------------------------------------------------
  // Core Accessors
  // ---------------------------------------------------------------------------

  getCore() {
    return this.getApplication().getCore();
  }

  getAuthService() {
    return this.getApplication().getAuthService();
  }

  getKeystore() {
    return this.getApplication().getKeystore();
  }

  getSessionManager() {
    return this.getCore().getContext().getProperty('sessionManager');
  }

  getInteractionLoop() {
    return this.getCore().getContext().getProperty('interactionLoop');
  }

  getFramePersistence() {
    return this.getCore().getContext().getProperty('framePersistence');
  }

  getSessionScheduler() {
    return this.getCore().getContext().getProperty('sessionScheduler');
  }

  getStreamRelay() {
    return this.getCore().getContext().getProperty('streamRelay');
  }

  getCoreModels() {
    return this.getCore().getModels();
  }
}
