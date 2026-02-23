'use strict';

/**
 * Hero Components Entry Point
 *
 * Components are loaded in two ways:
 * 1. JS import (here) - for Light DOM components and services
 * 2. mythix-require (in index.html) - for Shadow DOM components with templates
 *
 * Shadow DOM components MUST be loaded via mythix-require so their
 * HTML templates are available when the shadow root is created.
 */

// Core infrastructure
export { GlobalState, HeroComponent, DynamicProperty, Utils } from './hero-base.js';

// Expose GlobalState globally for legacy scripts
import { GlobalState as GS, DynamicProperty as DP } from './hero-base.js';

// Application shell (Light DOM - no template needed)
export { HeroApp, parseRoute } from './hero-app/hero-app.js';

// Services (no visual component)
export { HeroWebSocket } from './hero-websocket.js';

// Provider components (no shadow DOM - structural/scoping)
export { SessionFramesProvider } from './session-frames-provider/session-frames-provider.js';

// Base modal class (exports GlobalState, escapeHtml, MODAL_STYLES)
export { HeroModal, GlobalState as ModalGlobalState, escapeHtml, MODAL_STYLES } from './hero-modal/hero-modal.js';

// Step modal base class
export { HeroStepModal, STEP_MODAL_STYLES } from './hero-step-modal/hero-step-modal.js';

// Step component for declarative multi-step modals
export { HeroStep } from './hero-step/hero-step.js';

// Modal components - new naming convention
export { HeroModalCreateSession } from './hero-modal-create-session/hero-modal-create-session.js';
export { HeroModalCreateAgent } from './hero-modal-create-agent/hero-modal-create-agent.js';
export { HeroModalConfigureAbility } from './hero-modal-configure-ability/hero-modal-configure-ability.js';
export { HeroModalAbilities } from './hero-modal-abilities/hero-modal-abilities.js';
export { HeroModalAgents } from './hero-modal-agents/hero-modal-agents.js';
export { HeroModalAgentSettings } from './hero-modal-agent-settings/hero-modal-agent-settings.js';

// Legacy aliases for backward compatibility
export { HeroModalCreateSession as HeroModalSession } from './hero-modal-create-session/hero-modal-create-session.js';
export { HeroModalCreateAgent as HeroModalAgent } from './hero-modal-create-agent/hero-modal-create-agent.js';
export { HeroModalConfigureAbility as HeroModalAbility } from './hero-modal-configure-ability/hero-modal-configure-ability.js';
export { HeroModalAgentSettings as HeroModalAgentConfig } from './hero-modal-agent-settings/hero-modal-agent-settings.js';

// NOTE: Shadow DOM components are loaded ONLY via mythix-require in index.html.
// Do NOT import them here — mythix-require injects the template first, then
// loads the <script> which registers the custom element. Importing here would
// define the class before the template is available, causing a race condition
// where the template dedup check matches the component instance.
//
// Shadow DOM components loaded via mythix-require:
// - hero-header, hero-status-bar, hero-main-controls, hero-sessions-list
// - hero-chat, hero-input, hml-prompt
// - hero-login, hero-settings, hero-participant-list

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
  // This ensures that when Mythix UI components (e.g., hero-app) call
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

  console.log('[Hero] JS-loaded components: hero-app, hero-websocket, hero-modal-*');
  console.log('[Hero] Mythix-loaded components: hero-header, hero-status-bar, hero-main-controls, hero-sessions-list, hero-chat, hero-input, hml-prompt');
}
