'use strict';

// ============================================================================
// Interaction Registry
// ============================================================================
// Manages function registrations scoped per-user and per-session.
// Uses WeakMap-style semantics for automatic cleanup when sessions end.

import { InteractionFunction } from './function.mjs';

// Function class registrations (global, keyed by function name)
const functionClasses = new Map();

// Active function instances per session
// Map<sessionId, Map<functionId, InteractionFunction>>
const sessionFunctions = new Map();

// Active function instances per user (not session-scoped)
// Map<userId, Map<functionId, InteractionFunction>>
const userFunctions = new Map();

/**
 * Register a function class.
 * Function classes can be instantiated per-session or per-user.
 *
 * @param {string} name - Function name
 * @param {typeof InteractionFunction} FunctionClass - The function class
 * @param {Object} options - Registration options
 * @param {string} [options.source='user'] - Source (builtin, system, user, plugin)
 * @param {string} [options.description] - Description
 * @param {Object} [options.inputSchema] - JSON Schema for input validation
 */
export function registerFunctionClass(name, FunctionClass, options = {}) {
  if (typeof name !== 'string' || !name) {
    throw new Error('Function name is required');
  }

  if (!(FunctionClass.prototype instanceof InteractionFunction) && FunctionClass !== InteractionFunction) {
    throw new Error('FunctionClass must extend InteractionFunction');
  }

  functionClasses.set(name, {
    name,
    FunctionClass,
    source:      options.source || 'user',
    description: options.description || '',
    inputSchema: options.inputSchema || null,
  });
}

/**
 * Get a registered function class.
 *
 * @param {string} name - Function name
 * @returns {Object|null} Function registration or null
 */
export function getFunctionClass(name) {
  return functionClasses.get(name) || null;
}

/**
 * Get all registered function class names.
 *
 * @returns {Array<string>} Function names
 */
export function getFunctionClassNames() {
  return Array.from(functionClasses.keys());
}

/**
 * Get all registered function classes.
 *
 * @returns {Array<Object>} Function registrations
 */
export function getAllFunctionClasses() {
  return Array.from(functionClasses.values());
}

/**
 * Instantiate a function for a session.
 *
 * @param {string} name - Function name
 * @param {number|string} sessionId - Session ID
 * @param {Object} context - Execution context
 * @returns {InteractionFunction} The function instance
 */
export function instantiateForSession(name, sessionId, context = {}) {
  let registration = functionClasses.get(name);

  if (!registration) {
    throw new Error(`Unknown function: ${name}`);
  }

  let instance = new registration.FunctionClass(name, { ...context, sessionId });

  // Add to session functions
  if (!sessionFunctions.has(sessionId)) {
    sessionFunctions.set(sessionId, new Map());
  }

  sessionFunctions.get(sessionId).set(instance.id, instance);

  // Clean up when function completes
  instance.execution.finally(() => {
    let sessionMap = sessionFunctions.get(sessionId);
    if (sessionMap) {
      sessionMap.delete(instance.id);
      if (sessionMap.size === 0) {
        sessionFunctions.delete(sessionId);
      }
    }
  });

  return instance;
}

/**
 * Instantiate a function for a user (not session-scoped).
 *
 * @param {string} name - Function name
 * @param {number} userId - User ID
 * @param {Object} context - Execution context
 * @returns {InteractionFunction} The function instance
 */
export function instantiateForUser(name, userId, context = {}) {
  let registration = functionClasses.get(name);

  if (!registration) {
    throw new Error(`Unknown function: ${name}`);
  }

  let instance = new registration.FunctionClass(name, { ...context, userId });

  // Add to user functions
  if (!userFunctions.has(userId)) {
    userFunctions.set(userId, new Map());
  }

  userFunctions.get(userId).set(instance.id, instance);

  // Clean up when function completes
  instance.execution.finally(() => {
    let userMap = userFunctions.get(userId);
    if (userMap) {
      userMap.delete(instance.id);
      if (userMap.size === 0) {
        userFunctions.delete(userId);
      }
    }
  });

  return instance;
}

/**
 * Get a function instance by ID.
 *
 * @param {string} functionId - Function ID
 * @param {number|string} [sessionId] - Session ID (optional, for session-scoped lookup)
 * @param {number} [userId] - User ID (optional, for user-scoped lookup)
 * @returns {InteractionFunction|null} Function instance or null
 */
export function getFunctionInstance(functionId, sessionId = null, userId = null) {
  // Try session-scoped first
  if (sessionId) {
    let sessionMap = sessionFunctions.get(sessionId);
    if (sessionMap && sessionMap.has(functionId)) {
      return sessionMap.get(functionId);
    }
  }

  // Try user-scoped
  if (userId) {
    let userMap = userFunctions.get(userId);
    if (userMap && userMap.has(functionId)) {
      return userMap.get(functionId);
    }
  }

  // Search all sessions and users
  for (let sessionMap of sessionFunctions.values()) {
    if (sessionMap.has(functionId)) {
      return sessionMap.get(functionId);
    }
  }

  for (let userMap of userFunctions.values()) {
    if (userMap.has(functionId)) {
      return userMap.get(functionId);
    }
  }

  return null;
}

/**
 * Get all function instances for a session.
 *
 * @param {number|string} sessionId - Session ID
 * @returns {Array<InteractionFunction>} Function instances
 */
export function getSessionFunctions(sessionId) {
  let sessionMap = sessionFunctions.get(sessionId);
  return (sessionMap) ? Array.from(sessionMap.values()) : [];
}

/**
 * Get all function instances for a user.
 *
 * @param {number} userId - User ID
 * @param {boolean} [includeSessionFunctions=false] - Include session-scoped functions
 * @returns {Array<InteractionFunction>} Function instances
 */
export function getUserFunctions(userId, includeSessionFunctions = false) {
  let functions = [];

  // Add user-scoped functions
  let userMap = userFunctions.get(userId);
  if (userMap) {
    functions.push(...userMap.values());
  }

  // Optionally add session-scoped functions
  if (includeSessionFunctions) {
    for (let sessionMap of sessionFunctions.values()) {
      for (let func of sessionMap.values()) {
        if (func.context.userId === userId) {
          functions.push(func);
        }
      }
    }
  }

  return functions;
}

/**
 * Clean up all functions for a session.
 *
 * @param {number|string} sessionId - Session ID
 * @param {string} [reason='Session ended'] - Cancellation reason
 */
export function cleanupSession(sessionId, reason = 'Session ended') {
  let sessionMap = sessionFunctions.get(sessionId);

  if (!sessionMap)
    return;

  for (let func of sessionMap.values()) {
    if (func.state === 'running' || func.state === 'pending') {
      func.cancel(reason);
    }
  }

  sessionFunctions.delete(sessionId);
}

/**
 * Clean up all functions for a user.
 *
 * @param {number} userId - User ID
 * @param {string} [reason='User logged out'] - Cancellation reason
 */
export function cleanupUser(userId, reason = 'User logged out') {
  let userMap = userFunctions.get(userId);

  if (userMap) {
    for (let func of userMap.values()) {
      if (func.state === 'running' || func.state === 'pending') {
        func.cancel(reason);
      }
    }
    userFunctions.delete(userId);
  }

  // Also clean up session functions for this user
  for (let [sessionId, sessionMap] of sessionFunctions) {
    for (let func of sessionMap.values()) {
      if (func.context.userId === userId) {
        if (func.state === 'running' || func.state === 'pending') {
          func.cancel(reason);
        }
      }
    }
  }
}

/**
 * Unregister a function class.
 *
 * @param {string} name - Function name
 * @returns {boolean} True if unregistered
 */
export function unregisterFunctionClass(name) {
  return functionClasses.delete(name);
}

/**
 * Clear all function class registrations.
 */
export function clearFunctionClasses() {
  functionClasses.clear();
}

export default {
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
};
