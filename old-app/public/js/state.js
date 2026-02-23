'use strict';

// ============================================================================
// State
// ============================================================================

// Keys that are automatically synced between state.* and GlobalState
const SYNCED_KEYS = new Set([
  'user', 'sessions', 'agents', 'abilities',
  'currentSession', 'globalSpend', 'serviceSpend', 'sessionSpend',
]);

const _state = {
  user:                 null,
  sessions:             [],
  agents:               [],
  abilities:            { system: [], user: [] },
  currentSession:       null,
  // NOTE: state.messages removed - use sessionStore.getSession(id) instead
  isLoading:            false,
  runningOperations:    [],
  editingAbilityId:     null,
  ws:                   null,
  assertions:           {},    // Map of messageId -> [assertion, ...]
  pendingQuestions:     {},    // Map of assertionId -> { resolve, timeout }
  activeDemandQuestion: null,  // { messageId, assertionId } for current demand question
  showHidden:           false, // Toggle for showing archived/agent sessions
  showHiddenMessages:   false, // Toggle for showing hidden messages in chat
  pendingApprovals:     {},    // Map of executionId -> approval request data
  pendingAbilityQs:     {},    // Map of questionId -> ability question data
  searchQuery:          '',    // Search query for sessions
  messageQueue:         [],    // Queued messages while agent is busy
  streamingMode:        true,  // Use streaming mode for agent responses
  streamingMessage:     null,  // Current streaming message state { id, content, elements }
  globalSpend:          { cost: 0 },  // Total spend across all agents
  serviceSpend:         { cost: 0 },  // Spend for agents with same API key
  sessionSpend:         { cost: 0 },  // Spend for current session
};

// Proxy wrapper: when a synced key is written, auto-forward to GlobalState
const state = new Proxy(_state, {
  set(target, key, value) {
    target[key] = value;

    // Forward synced keys to GlobalState (if loaded)
    if (SYNCED_KEYS.has(key) && !window.__stateSyncing && typeof window.setGlobal === 'function') {
      window.__stateSyncing = true;
      try {
        window.setGlobal(key, value);
      } finally {
        window.__stateSyncing = false;
      }
    }

    return true;
  },
});

// ============================================================================
// DOM Elements
// ============================================================================

const elements = {
  // Views
  loginView:    document.getElementById('login-view'),
  sessionsView: document.getElementById('sessions-view'),
  chatView:     document.getElementById('chat-view'),
  settingsView: document.getElementById('settings-view'),

  // Login (hero-login component handles its own form)
  loginComponent: document.getElementById('login-component'),

  // Sessions (hero-sessions-list component handles its own DOM)
  sessionsList: document.getElementById('sessions-list'),

  // Chat
  messagesContainer: document.getElementById('chat'),  // hero-chat component
  heroChat:          document.getElementById('chat'),  // hero-chat component reference
  chatMain:          document.querySelector('.chat-main'),

  // Operations Panel
  operationsPanel:      document.getElementById('operations-panel'),
  operationsList:       document.getElementById('operations-list'),
  toggleOperations:     document.getElementById('toggle-operations'),
};

// Read base path from <base> tag (set by server from package.json config)
const BASE_PATH = document.querySelector('base')?.getAttribute('href')?.replace(/\/$/, '') || '';

// Expose state globally for ES modules (hero-app, session-frames-provider, etc.)
window.state = state;
window.elements = elements;
