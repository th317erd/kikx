'use strict';

// =============================================================================
// ModelsController — Plugin model manifest endpoint
// =============================================================================
// GET /api/v2/models — returns aggregated model list from all loaded plugins.
// Auth required (JWT via ControllerAuthBase).
// Response shape: { data: { models: [{ pluginID, id, contextWindow, ... }] } }
// =============================================================================

import { ControllerAuthBase } from './controller-auth-base.mjs';

export class ModelsController extends ControllerAuthBase {
  // ---------------------------------------------------------------------------
  // GET /api/v2/models
  // ---------------------------------------------------------------------------

  async index() {
    let pluginLoader = this.getCore().getPluginLoader();
    let registry     = pluginLoader ? pluginLoader.getRegistry() : null;
    let models       = [];

    if (registry) {
      let agentTypes = registry.getAgentTypes();

      if (agentTypes) {
        for (let [pluginID, AgentClass] of agentTypes) {
          if (typeof AgentClass.getModels === 'function') {
            try {
              let pluginModels = AgentClass.getModels();

              for (let model of (pluginModels || []))
                models.push({ pluginID, ...model });
            } catch (error) {
              // Plugin threw from getModels() — skip this plugin, log warning
              console.warn(`[ModelsController] getModels() threw for plugin "${pluginID}":`, error.message || error);
            }
          }
        }
      }
    }

    return { data: { models } };
  }
}
