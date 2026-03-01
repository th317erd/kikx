'use strict';

/**
 * Kikx Components Entry Point
 *
 * Components are loaded in two ways:
 * 1. JS import (here) - for Light DOM components and services
 * 2. mythix-require (in index.html) - for Shadow DOM components with templates
 *
 * Shadow DOM components MUST be loaded via mythix-require so their
 * HTML templates are available when the shadow root is created.
 */

// Core infrastructure
export { GlobalState, KikxComponent, DynamicProperty, Utils } from './kikx-base.js';

// Expose GlobalState globally for legacy scripts
import { GlobalState as GS, DynamicProperty as DP } from './kikx-base.js';

// Application shell (Light DOM - no template needed)
export { KikxApp, parseRoute } from './kikx-app/kikx-app.js';

// Services (no visual component)
export { KikxWebSocket } from './kikx-websocket.js';

// Provider components (no shadow DOM - structural/scoping)
export { SessionFramesProvider } from './session-frames-provider/session-frames-provider.js';

// Base modal class (exports GlobalState, escapeHtml, MODAL_STYLES)
export { KikxModal, GlobalState as ModalGlobalState, escapeHtml, MODAL_STYLES } from './kikx-modal/kikx-modal.js';

// Step modal base class
export { KikxStepModal, STEP_MODAL_STYLES } from './kikx-step-modal/kikx-step-modal.js';

// Step component for declarative multi-step modals
export { KikxStep } from './kikx-step/kikx-step.js';

// Modal components - new naming convention
export { KikxModalCreateSession } from './kikx-modal-create-session/kikx-modal-create-session.js';
export { KikxModalCreateAgent } from './kikx-modal-create-agent/kikx-modal-create-agent.js';
export { KikxModalConfigureAbility } from './kikx-modal-configure-ability/kikx-modal-configure-ability.js';
export { KikxModalAbilities } from './kikx-modal-abilities/kikx-modal-abilities.js';
export { KikxModalAgents } from './kikx-modal-agents/kikx-modal-agents.js';
export { KikxModalAgentSettings } from './kikx-modal-agent-settings/kikx-modal-agent-settings.js';

// Legacy aliases for backward compatibility
export { KikxModalCreateSession as KikxModalSession } from './kikx-modal-create-session/kikx-modal-create-session.js';
export { KikxModalCreateAgent as KikxModalAgent } from './kikx-modal-create-agent/kikx-modal-create-agent.js';
export { KikxModalConfigureAbility as KikxModalAbility } from './kikx-modal-configure-ability/kikx-modal-configure-ability.js';
export { KikxModalAgentSettings as KikxModalAgentConfig } from './kikx-modal-agent-settings/kikx-modal-agent-settings.js';

// NOTE: Shadow DOM components are loaded ONLY via mythix-require in index.html.
// Do NOT import them here — mythix-require injects the template first, then
// loads the <script> which registers the custom element. Importing here would
// define the class before the template is available, causing a race condition
// where the template dedup check matches the component instance.
//
// Shadow DOM components loaded via mythix-require:
// - kikx-header, kikx-status-bar, kikx-main-controls, kikx-sessions-list
// - kikx-chat, kikx-input, hml-prompt
// - kikx-login, kikx-settings, kikx-participant-list

// One-time initialization
if (!window.__heroComponentsLoaded) {
  window.__heroComponentsLoaded = true;
  window.GlobalState = GS;
  window.DynamicProperty = DP;

  // Keys synced bidirectionally between state.* and GlobalState
  const SYNCED_KEYS = new Set([
    'user', 'sessions', 'agents', 'abilities',
    'currentSession', 'globalSpend', 'serviceSpend', 'sessionSpend',
  ]);

  /**
   * Helper to set GlobalState values from legacy scripts.
   * Also reverse-syncs to window.state for synced keys.
   * @param {string} key - GlobalState key (e.g., 'sessions')
   * @param {*} value - New value
   */
  window.setGlobal = (key, value) => {
    if (GS[key]) {
      GS[key][DP.set](value);

      // Reverse-sync synced keys to window.state
      if (SYNCED_KEYS.has(key) && !window.__stateSyncing && window.state) {
        window.__stateSyncing = true;
        try {
          window.state[key] = value;
        } finally {
          window.__stateSyncing = false;
        }
      }
    } else {
      console.warn(`GlobalState.${key} does not exist`);
    }
  };

  // Subscribe to GlobalState changes and reverse-sync to window.state.
  // This ensures that when Mythix UI components (e.g., kikx-app) call
  // this.setGlobal('currentSession', ...), the legacy state.currentSession
  // is also updated — critical for streaming/prompt answer flows.
  for (const key of SYNCED_KEYS) {
    if (GS[key] && typeof GS[key].addEventListener === 'function') {
      GS[key].addEventListener('update', (event) => {
        if (!window.__stateSyncing && window.state) {
          window.__stateSyncing = true;
          try {
            window.state[key] = event.value;
          } finally {
            window.__stateSyncing = false;
          }
        }
      });
    }
  }

  console.log('[Hero] JS-loaded components: kikx-app, kikx-websocket, kikx-modal-*');
  console.log('[Hero] Mythix-loaded components: kikx-header, kikx-status-bar, kikx-main-controls, kikx-sessions-list, kikx-chat, kikx-input, hml-prompt');
}
