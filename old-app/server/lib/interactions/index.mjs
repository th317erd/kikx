'use strict';

// ============================================================================
// Interactions System
// ============================================================================
// Provides async message passing between agents, users, and functions.
//
// Core Concepts:
// - Interaction: A message with target, property, and payload
// - InteractionFunction: Base class for functions with registration
// - InteractionBus: Routes interactions to their targets
// - SystemFunction: Singleton dispatcher for @system target

// Import for local use
import { getInteractionBus as _getInteractionBus } from './bus.mjs';
import { initializeSystemFunction as _initializeSystemFunction, registerFunctionClass as _registerFunctionClass, buildAgentInstructions as _buildAgentInstructions } from './functions/system.mjs';
import { WebSearchFunction } from './functions/websearch.mjs';
import { HelpFunction } from './functions/help.mjs';
import { PromptUpdateFunction } from './functions/prompt-update.mjs';
import { DelegateFunction } from './functions/delegate.mjs';
import { ExecuteCommandFunction } from './functions/execute-command.mjs';

// Re-export base class and permission constants
export { InteractionFunction, PERMISSION } from './function.mjs';

// Re-export registry (legacy - now handled by system.mjs)
export {
  registerFunctionClass,
  getFunctionClass,
  getFunctionClassNames,
  getAllFunctionClasses,
  instantiateForSession,
  instantiateForUser,
  getFunctionInstance,
  getSessionFunctions,
  getUserFunctions,
  cleanupSession,
  cleanupUser,
  unregisterFunctionClass,
  clearFunctionClasses,
} from './registry.mjs';

// Re-export bus
export {
  InteractionBus,
  getInteractionBus,
  interact,
  askUser,
  getAgentMessages,
  queueAgentMessage,
  clearAgentMessages,
  TARGETS,
} from './bus.mjs';

// Re-export interaction detection and execution
export {
  detectInteractions,
  executeInteractions,
  formatInteractionFeedback,
} from './detector.mjs';

// Re-export user input function
export {
  UserInputFunction,
  askText,
  askNumber,
  askChoice,
  askConfirm,
} from './functions/user-input.mjs';

// Re-export system function and registration
export {
  SystemFunction,
  registerFunctionClass as registerSystemFunction,
  unregisterFunctionClass as unregisterSystemFunction,
  getRegisteredFunctionClass,
  getRegisteredFunctionNames,
  getAllRegisteredFunctions,
  clearRegisteredFunctions,
  getSystemFunction,
  initializeSystemFunction,
  checkSystemFunctionAllowed,
  buildAgentInstructions,
  // Legacy aliases
  PERMISSION_LEVELS,
  registerSystemMethod,
  getSystemMethodNames,
  getAllSystemMethods,
  checkSystemMethodAllowed,
} from './functions/system.mjs';

// Re-export websearch function
export {
  WebSearchFunction,
  fetchWebPage,
  searchWeb,
} from './functions/websearch.mjs';

// Re-export help function
export { HelpFunction } from './functions/help.mjs';

// Re-export prompt update function
export { PromptUpdateFunction } from './functions/prompt-update.mjs';

// Re-export delegate function
export { DelegateFunction } from './functions/delegate.mjs';

// Re-export execute command function
export { ExecuteCommandFunction } from './functions/execute-command.mjs';

/**
 * Initialize the interactions system.
 * Call this during server startup.
 *
 * @param {Object} options - Options
 * @param {Function} [options.onUserInteraction] - Handler for user interactions
 * @param {Function} [options.onSystemInteraction] - Handler for system interactions
 */
export function initializeInteractions(options = {}) {
  let bus = _getInteractionBus();

  // Initialize the @system singleton
  _initializeSystemFunction();

  // Register built-in function classes
  _registerFunctionClass(WebSearchFunction);
  _registerFunctionClass(HelpFunction);
  _registerFunctionClass(PromptUpdateFunction);
  _registerFunctionClass(DelegateFunction);
  _registerFunctionClass(ExecuteCommandFunction);

  // Set up handlers if provided
  if (options.onUserInteraction) {
    bus.on('user_interaction', options.onUserInteraction);
  }

  if (options.onSystemInteraction) {
    bus.on('system_interaction', options.onSystemInteraction);
  }

  console.log('Interactions system initialized');
}

/**
 * Connect the interaction bus to WebSocket for user interactions.
 *
 * @param {Function} broadcastToSession - Function to broadcast to session (sessionId, message)
 * @param {Function} broadcastToUser - Fallback for interactions without session context (userId, message)
 * @returns {Function} Handler for incoming WebSocket messages
 */
export function connectToWebSocket(broadcastToSession, broadcastToUser) {
  let bus = _getInteractionBus();

  // When an interaction needs user input, broadcast via WebSocket
  bus.on('user_interaction', (interaction) => {
    if (interaction.session_id) {
      broadcastToSession(interaction.session_id, {
        type:        'interaction_request',
        interaction: interaction,
      });
    } else if (interaction.user_id && broadcastToUser) {
      broadcastToUser(interaction.user_id, {
        type:        'interaction_request',
        interaction: interaction,
      });
    }
  });

  // Return handler for incoming WebSocket messages
  return (userId, message) => {
    if (message.type === 'interaction_response') {
      bus.respond(
        message.interactionId,
        message.payload,
        message.success !== false
      );
    }
  };
}

/**
 * Get dynamic agent instructions including all registered functions.
 * Call this after initialization to get instructions to feed to the agent.
 *
 * @returns {string} Markdown instructions
 */
export function getAgentFunctionInstructions() {
  return _buildAgentInstructions();
}

export default {
  initializeInteractions,
  connectToWebSocket,
  getAgentFunctionInstructions,
};
