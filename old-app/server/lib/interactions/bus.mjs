'use strict';

// ============================================================================
// Interaction Bus
// ============================================================================
// Routes interactions between agents and users.
// Supports async message passing with standardized format.

import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import { getFunctionInstance, getSessionFunctions, getUserFunctions } from './registry.mjs';

/**
 * Interaction message format:
 * {
 *   interaction_id: string,    // Unique interaction ID
 *   target_id: string,         // Target function ID or special target
 *   target_property: string,   // Method/property to invoke on target
 *   payload: any,              // Interaction payload
 *   ts: number,                // Timestamp (ms since epoch)
 *   source_id?: string,        // Source function ID (optional)
 *   session_id?: number,       // Session context (optional)
 *   user_id?: number,          // User context (optional)
 *   sender_id?: number,        // Sender ID - if set, interaction is "secure/authorized"
 *                              // This can ONLY be set by the system (stripped from agent responses)
 *                              // A non-null sender_id indicates the interaction originated from
 *                              // an authenticated user, not from an AI agent
 * }
 */

// Special target IDs
export const TARGETS = {
  USER:    '@user',     // Route to user (requires approval/input)
  SYSTEM:  '@system',   // Route to system handlers
  SESSION: '@session',  // Route to current session
  AGENT:   '@agent',    // Route to agent (for async results)
};

// Agent message queue (sessionId -> Array of pending messages for agent)
const agentMessageQueues = new Map();

/**
 * The Interaction Bus.
 * Singleton per process, but interactions are scoped by session/user.
 */
class InteractionBus extends EventEmitter {
  constructor() {
    super();

    // Pending interactions awaiting response
    // Map<interaction_id, { resolve, reject, timeout, interaction }>
    this._pending = new Map();

    // Interaction handlers by target pattern
    // Map<pattern, handler>
    this._handlers = new Map();

    // Interaction history (limited)
    this._history     = [];
    this._historyMax  = 1000;

    // Register default handlers
    this._registerDefaultHandlers();
  }

  /**
   * Create a new interaction.
   *
   * @param {string} targetId - Target function ID or special target
   * @param {string} targetProperty - Method/property to invoke
   * @param {*} payload - Interaction payload
   * @param {Object} [options] - Options
   * @param {string} [options.sourceId] - Source function ID
   * @param {number} [options.sessionId] - Session ID
   * @param {number} [options.userId] - User ID
   * @param {number} [options.senderId] - Sender ID (indicates authorized user interaction)
   * @param {number} [options.sourceAgentId] - Agent ID that originated this interaction
   * @returns {Object} The interaction object
   */
  create(targetId, targetProperty, payload, options = {}) {
    let interaction = {
      interaction_id:   randomUUID(),
      target_id:        targetId,
      target_property:  targetProperty,
      payload:          payload,
      ts:               Date.now(),
      source_id:        options.sourceId || null,
      session_id:       options.sessionId || null,
      user_id:          options.userId || null,
      source_agent_id:  options.sourceAgentId || null,
    };

    // Only include sender_id if explicitly provided
    // This marks the interaction as "secure/authorized" from an authenticated user
    if (options.senderId !== undefined) {
      interaction.sender_id = options.senderId;
    }

    return interaction;
  }

  /**
   * Send an interaction and wait for response.
   *
   * @param {Object} interaction - The interaction object
   * @param {number} [timeout=0] - Timeout in ms (0 = no timeout)
   * @returns {Promise<*>} Response payload
   */
  async send(interaction, timeout = 0) {
    // Add to history
    this._addToHistory(interaction);

    // Emit for logging/debugging
    this.emit('interaction', interaction);

    // Try to route the interaction
    let response = await this._route(interaction, timeout);

    return response;
  }

  /**
   * Send an interaction without waiting for response (fire-and-forget).
   *
   * @param {Object} interaction - The interaction object
   */
  fire(interaction) {
    // Add to history
    this._addToHistory(interaction);

    // Emit for logging/debugging
    this.emit('interaction', interaction);

    // Route asynchronously without waiting
    this._route(interaction, 0).catch((error) => {
      this.emit('error', { interaction, error });
    });
  }

  /**
   * Send an interaction and create a pending promise.
   *
   * @param {Object} interaction - The interaction object
   * @param {number} [timeout=0] - Timeout in ms (0 = no timeout)
   * @returns {Promise<*>} Response payload
   */
  request(interaction, timeout = 0) {
    return new Promise((resolve, reject) => {
      let timeoutId = null;

      if (timeout > 0) {
        timeoutId = setTimeout(() => {
          this._pending.delete(interaction.interaction_id);
          reject(new Error(`Interaction timed out: ${interaction.target_property}`));
        }, timeout);
      }

      this._pending.set(interaction.interaction_id, {
        resolve: (result) => {
          if (timeoutId) clearTimeout(timeoutId);
          this._pending.delete(interaction.interaction_id);
          resolve(result);
        },
        reject: (error) => {
          if (timeoutId) clearTimeout(timeoutId);
          this._pending.delete(interaction.interaction_id);
          reject(error);
        },
        timeout: timeoutId,
        interaction,
      });

      // Route the interaction
      this._route(interaction, 0).catch((error) => {
        // If routing fails, reject the pending promise
        let pending = this._pending.get(interaction.interaction_id);
        if (pending) {
          pending.reject(error);
        }
      });
    });
  }

  /**
   * Respond to a pending interaction.
   *
   * @param {string} interactionId - Interaction ID
   * @param {*} payload - Response payload
   * @param {boolean} [success=true] - Whether the response is successful
   * @param {Object} [securityContext] - Optional security context
   * @param {number} [securityContext.userId] - Authenticated user ID for verification
   * @param {number} [securityContext.agentId] - Agent ID (if response originates from an agent)
   * @returns {boolean} True if interaction was pending
   */
  respond(interactionId, payload, success = true, securityContext = {}) {
    let pending = this._pending.get(interactionId);

    if (!pending)
      return false;

    // If the interaction has a user_id, verify the responding user matches
    if (securityContext.userId && pending.interaction.user_id &&
        securityContext.userId !== pending.interaction.user_id) {
      console.warn(`[Security] Interaction response user mismatch: user ${securityContext.userId} tried to respond to interaction for user ${pending.interaction.user_id}`);
      return false;
    }

    // Self-approval prevention: agents cannot respond to their own interactions
    if (securityContext.agentId && pending.interaction.source_agent_id &&
        securityContext.agentId === pending.interaction.source_agent_id) {
      console.warn(`[Security] Self-response blocked: agent ${securityContext.agentId} tried to respond to its own interaction ${interactionId}`);
      return false;
    }

    if (success) {
      pending.resolve(payload);
    } else {
      pending.reject((payload instanceof Error) ? payload : new Error(String(payload)));
    }

    return true;
  }

  /**
   * Register an interaction handler.
   *
   * @param {string|RegExp} pattern - Target pattern to match
   * @param {Function} handler - Handler function(interaction) => Promise<*>
   */
  registerHandler(pattern, handler) {
    this._handlers.set(pattern, handler);
  }

  /**
   * Unregister an interaction handler.
   *
   * @param {string|RegExp} pattern - Target pattern
   * @returns {boolean} True if unregistered
   */
  unregisterHandler(pattern) {
    return this._handlers.delete(pattern);
  }

  /**
   * Get pending interaction count.
   *
   * @returns {number} Count
   */
  getPendingCount() {
    return this._pending.size;
  }

  /**
   * Get interaction history.
   *
   * @param {Object} [filter] - Optional filter
   * @param {number} [filter.sessionId] - Filter by session
   * @param {number} [filter.userId] - Filter by user
   * @param {number} [filter.limit] - Max results
   * @returns {Array} Interactions
   */
  getHistory(filter = {}) {
    let results = this._history;

    if (filter.sessionId) {
      results = results.filter((i) => i.session_id === filter.sessionId);
    }

    if (filter.userId) {
      results = results.filter((i) => i.user_id === filter.userId);
    }

    if (filter.limit) {
      results = results.slice(-filter.limit);
    }

    return results;
  }

  /**
   * Clear interaction history.
   *
   * @param {Object} [filter] - Optional filter
   */
  clearHistory(filter = {}) {
    if (!filter.sessionId && !filter.userId) {
      this._history = [];
      return;
    }

    this._history = this._history.filter((i) => {
      if (filter.sessionId && i.session_id === filter.sessionId) return false;
      if (filter.userId && i.user_id === filter.userId) return false;
      return true;
    });
  }

  // -------------------------------------------------------------------------
  // Private Methods
  // -------------------------------------------------------------------------

  _registerDefaultHandlers() {
    // Handle function targets
    this.registerHandler('function', async (interaction) => {
      let func = getFunctionInstance(
        interaction.target_id,
        interaction.session_id,
        interaction.user_id
      );

      if (!func) {
        throw new Error(`Function not found: ${interaction.target_id}`);
      }

      return await func.handle(interaction);
    });

    // Handle @user target
    this.registerHandler(TARGETS.USER, async (interaction) => {
      // Emit event for WebSocket to pick up
      this.emit('user_interaction', interaction);

      // This should be handled by request() with a pending promise
      // The actual response comes via WebSocket
      return { pending: true, interactionId: interaction.interaction_id };
    });

    // Handle @system target
    this.registerHandler(TARGETS.SYSTEM, async (interaction) => {
      this.emit('system_interaction', interaction);
      return { acknowledged: true };
    });

    // Handle @agent target - queue messages for the agent to receive
    this.registerHandler(TARGETS.AGENT, async (interaction) => {
      let sessionId = interaction.session_id;

      if (!sessionId) {
        throw new Error('@agent target requires session_id');
      }

      // Add to queue for this session
      if (!agentMessageQueues.has(sessionId)) {
        agentMessageQueues.set(sessionId, []);
      }

      agentMessageQueues.get(sessionId).push({
        interaction_id:  interaction.interaction_id,
        target_property: interaction.target_property,
        payload:         interaction.payload,
        ts:              interaction.ts,
      });

      this.emit('agent_message', interaction);

      return { queued: true };
    });
  }

  async _route(interaction, timeout) {
    let targetId = interaction.target_id;

    // Check for special targets
    if (targetId.startsWith('@')) {
      let handler = this._handlers.get(targetId);
      if (handler) {
        return await handler(interaction);
      }
      throw new Error(`No handler for target: ${targetId}`);
    }

    // Try function handler
    let funcHandler = this._handlers.get('function');
    if (funcHandler) {
      return await funcHandler(interaction);
    }

    throw new Error(`Cannot route interaction to: ${targetId}`);
  }

  _addToHistory(interaction) {
    this._history.push(interaction);

    // Trim history if needed
    if (this._history.length > this._historyMax) {
      this._history = this._history.slice(-this._historyMax);
    }
  }
}

// Singleton instance
let bus = null;

/**
 * Get the interaction bus singleton.
 *
 * @returns {InteractionBus} The bus instance
 */
export function getInteractionBus() {
  if (!bus) {
    bus = new InteractionBus();
  }
  return bus;
}

/**
 * Create and send an interaction.
 * Convenience function.
 *
 * @param {string} targetId - Target
 * @param {string} targetProperty - Property/method
 * @param {*} payload - Payload
 * @param {Object} [options] - Options
 * @returns {Promise<*>} Response
 */
export async function interact(targetId, targetProperty, payload, options = {}) {
  let bus         = getInteractionBus();
  let interaction = bus.create(targetId, targetProperty, payload, options);
  return await bus.send(interaction, options.timeout || 0);
}

/**
 * Create and send an interaction that requires user response.
 *
 * @param {string} property - What we're asking for
 * @param {*} payload - Payload (prompt, options, etc.)
 * @param {Object} [options] - Options
 * @returns {Promise<*>} User response
 */
export async function askUser(property, payload, options = {}) {
  return await interact(TARGETS.USER, property, payload, options);
}

/**
 * Get pending messages for the agent in a session.
 *
 * @param {number|string} sessionId - Session ID
 * @param {boolean} [clear=true] - Clear queue after getting messages
 * @returns {Array} Pending messages
 */
export function getAgentMessages(sessionId, clear = true) {
  let messages = agentMessageQueues.get(sessionId) || [];

  if (clear) {
    agentMessageQueues.delete(sessionId);
  }

  return messages;
}

/**
 * Queue a message for the agent.
 *
 * @param {number|string} sessionId - Session ID
 * @param {string} interactionId - Original interaction ID from agent
 * @param {string} property - Message type (e.g., 'interaction_update')
 * @param {Object} payload - Message payload
 */
export function queueAgentMessage(sessionId, interactionId, property, payload) {
  if (!agentMessageQueues.has(sessionId)) {
    agentMessageQueues.set(sessionId, []);
  }

  agentMessageQueues.get(sessionId).push({
    interaction_id:  interactionId,
    target_property: property,
    payload:         payload,
    ts:              Date.now(),
  });
}

/**
 * Clear agent message queue for a session.
 *
 * @param {number|string} sessionId - Session ID
 */
export function clearAgentMessages(sessionId) {
  agentMessageQueues.delete(sessionId);
}

export { InteractionBus };

export default {
  getInteractionBus,
  interact,
  askUser,
  getAgentMessages,
  queueAgentMessage,
  clearAgentMessages,
  TARGETS,
};
