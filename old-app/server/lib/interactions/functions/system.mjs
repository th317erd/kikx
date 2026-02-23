'use strict';

// ============================================================================
// System Function - Singleton Router
// ============================================================================
// The @system function is a special singleton that routes interactions to
// registered function classes. It acts as a dispatcher, creating instances
// and invoking them based on target_property.
//
// Registration Flow:
//   1. Function classes are registered via registerFunctionClass()
//   2. Agent requests: { target_id: "@system", target_property: "websearch", payload: {...} }
//   3. System finds the registered class, checks permissions via allowed()
//   4. If allowed, creates instance and executes
//   5. Returns result to agent
//
// This singleton does NOT use the standard register() pattern because it IS
// the dispatcher that routes to other registered functions.

import { InteractionFunction, PERMISSION } from '../function.mjs';
import { getInteractionBus, TARGETS } from '../bus.mjs';

// Registry of function classes (name -> class)
const functionClasses = new Map();

// The singleton instance
let systemInstance = null;

/**
 * The System Function class.
 * Singleton that dispatches to registered function classes.
 */
export class SystemFunction extends InteractionFunction {
  constructor() {
    super('@system', { singleton: true });
    this.state = 'running';  // Always running
    this.startedAt = new Date();
  }

  /**
   * System function uses a special registration.
   */
  static register() {
    return {
      name:        '@system',
      description: 'System dispatcher that routes to registered functions',
      target:      '@system',
      permission:  PERMISSION.ALWAYS,
      singleton:   true,
    };
  }

  /**
   * System function doesn't use start() - it's always running.
   */
  async start() {
    throw new Error('SystemFunction is a singleton and cannot be started');
  }

  /**
   * Execute is not used for system function.
   */
  async execute() {
    throw new Error('SystemFunction dispatches via handle(), not execute()');
  }

  /**
   * Check if a method is allowed to be called with the given payload.
   * Delegates to the target function class's allowed() method.
   *
   * @param {string} methodName - Method name (target_property)
   * @param {*} payload - Payload that would be passed
   * @param {Object} context - Execution context
   * @returns {Promise<{allowed: boolean, reason?: string}>}
   */
  async allowed(methodName, payload, context = {}) {
    let FunctionClass = functionClasses.get(methodName);

    if (!FunctionClass) {
      return {
        allowed: false,
        reason:  `Unknown function: ${methodName}. Available: ${getRegisteredFunctionNames().join(', ')}`,
      };
    }

    // Create temporary instance to check permissions
    let instance = new FunctionClass(context);

    try {
      return await instance.allowed(payload, context);
    } catch (error) {
      return {
        allowed: false,
        reason:  `Permission check failed: ${error.message}`,
      };
    }
  }

  /**
   * Handle an incoming interaction by dispatching to the appropriate function.
   * Checks permissions before executing.
   *
   * @param {Object} interaction - The interaction
   * @returns {Promise<Object>} Response with status and result
   */
  async handle(interaction) {
    let methodName = interaction.target_property;

    if (!methodName) {
      return {
        status: 'error',
        error:  'No target_property specified for @system interaction',
      };
    }

    // Check if function exists
    let FunctionClass = functionClasses.get(methodName);

    if (!FunctionClass) {
      return {
        status: 'error',
        error:  `Unknown function: ${methodName}. Available: ${getRegisteredFunctionNames().join(', ')}`,
      };
    }

    // Build context for permission check and execution.
    // Merge execution context if available (set by detector.mjs executeInteractions)
    // so that functions like delegate() have access to dataKey, agentId, etc.
    let context = {
      ...(interaction._executionContext || {}),
      interactionId: interaction.interaction_id,
      sessionId:     interaction.session_id,
      userId:        interaction.user_id,
      sourceId:      interaction.source_id,
    };

    // Create instance
    let instance = new FunctionClass(context);

    // Check permissions
    let permissionResult = await instance.allowed(interaction.payload, context);

    if (!permissionResult.allowed) {
      this.emit('function_denied', {
        function: methodName,
        payload:  interaction.payload,
        reason:   permissionResult.reason,
      });

      return {
        status: 'denied',
        reason: permissionResult.reason,
      };
    }

    // Execute the function
    this.emit('function_call', {
      function: methodName,
      payload:  interaction.payload,
    });

    try {
      let result = await instance.start(interaction.payload);

      this.emit('function_complete', {
        function: methodName,
        result:   result,
      });

      return {
        status: 'completed',
        result: result,
      };

    } catch (error) {
      this.emit('function_error', {
        function: methodName,
        error:    error.message,
      });

      return {
        status: 'failed',
        error:  error.message,
      };
    }
  }

  /**
   * Get info about all registered functions.
   *
   * @returns {Array} Function registration info
   */
  getRegisteredFunctions() {
    return Array.from(functionClasses.entries()).map(([name, FunctionClass]) => {
      let reg = FunctionClass.register();
      return {
        name:        reg.name,
        description: reg.description || '',
        permission:  reg.permission || PERMISSION.ALWAYS,
        schema:      reg.schema || null,
        examples:    reg.examples || [],
      };
    });
  }
}

// -------------------------------------------------------------------------
// Function Class Registry
// -------------------------------------------------------------------------

/**
 * Register a function class with the system.
 * The class must have a static register() method.
 *
 * @param {Function} FunctionClass - Class extending InteractionFunction
 */
export function registerFunctionClass(FunctionClass) {
  if (typeof FunctionClass !== 'function') {
    throw new Error('FunctionClass must be a class/constructor');
  }

  if (typeof FunctionClass.register !== 'function') {
    throw new Error(`${FunctionClass.name} must implement static register() method`);
  }

  let registration = FunctionClass.register();

  if (!registration.name) {
    throw new Error(`${FunctionClass.name}.register() must return an object with 'name' property`);
  }

  functionClasses.set(registration.name, FunctionClass);
  console.log(`Registered function: ${registration.name}`);
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
 * Get a registered function class.
 *
 * @param {string} name - Function name
 * @returns {Function|null} Function class or null
 */
export function getRegisteredFunctionClass(name) {
  return functionClasses.get(name) || null;
}

/**
 * Get all registered function names.
 *
 * @returns {Array<string>} Function names
 */
export function getRegisteredFunctionNames() {
  return Array.from(functionClasses.keys()).sort();
}

/**
 * Get all registered function classes with their registration info.
 *
 * @returns {Array<Object>} Function registration info
 */
export function getAllRegisteredFunctions() {
  return Array.from(functionClasses.entries()).map(([name, FunctionClass]) => {
    let reg = FunctionClass.register();
    return {
      name:        reg.name,
      description: reg.description || '',
      target:      reg.target || '@system',
      permission:  reg.permission || PERMISSION.ALWAYS,
      schema:      reg.schema || null,
      examples:    reg.examples || [],
    };
  });
}

/**
 * Clear all registered function classes.
 * Mainly for testing.
 */
export function clearRegisteredFunctions() {
  functionClasses.clear();
}

// -------------------------------------------------------------------------
// System Function Singleton
// -------------------------------------------------------------------------

/**
 * Get the system function singleton.
 *
 * @returns {SystemFunction} The singleton instance
 */
export function getSystemFunction() {
  if (!systemInstance) {
    systemInstance = new SystemFunction();
  }
  return systemInstance;
}

/**
 * Initialize the system function and register it with the interaction bus.
 */
export function initializeSystemFunction() {
  let system = getSystemFunction();
  let bus    = getInteractionBus();

  // Register handler for @system target
  bus.registerHandler(TARGETS.SYSTEM, async (interaction) => {
    return await system.handle(interaction);
  });

  console.log('System function initialized');
}

/**
 * Check if a system function is allowed.
 *
 * @param {string} functionName - Function name
 * @param {*} payload - Payload
 * @param {Object} context - Context
 * @returns {Promise<{allowed: boolean, reason?: string}>}
 */
export async function checkSystemFunctionAllowed(functionName, payload, context = {}) {
  let system = getSystemFunction();
  return await system.allowed(functionName, payload, context);
}

/**
 * Build agent instructions for all registered functions.
 * Returns a markdown document describing available functions.
 *
 * @returns {string} Markdown instructions for the agent
 */
export function buildAgentInstructions() {
  let functions = getAllRegisteredFunctions();

  if (functions.length === 0) {
    return '## Available Functions\n\nNo functions are currently registered.';
  }

  let lines = [
    '## Available System Functions',
    '',
    'The following functions are available via the `@system` target:',
    '',
  ];

  for (let func of functions) {
    lines.push(`### \`${func.name}\``);
    lines.push('');

    if (func.description) {
      lines.push(func.description);
      lines.push('');
    }

    // Schema
    if (func.schema && func.schema.properties) {
      lines.push('**Payload:**');
      lines.push('');
      lines.push('| Property | Type | Description |');
      lines.push('|----------|------|-------------|');

      for (let [propName, propDef] of Object.entries(func.schema.properties)) {
        let type = propDef.type || 'any';
        let desc = propDef.description || '';
        if (propDef.default !== undefined) {
          desc += ` (default: ${JSON.stringify(propDef.default)})`;
        }
        lines.push(`| \`${propName}\` | ${type} | ${desc} |`);
      }
      lines.push('');
    }

    // Examples
    if (func.examples && func.examples.length > 0) {
      lines.push('**Examples:**');
      lines.push('');

      for (let example of func.examples) {
        if (example.description) {
          lines.push(`*${example.description}:*`);
        }
        lines.push('```json');
        lines.push(JSON.stringify({
          interaction_id:  'example-id',
          target_id:       '@system',
          target_property: func.name,
          payload:         example.payload,
        }, null, 2));
        lines.push('```');
        lines.push('');
      }
    }

    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}

// -------------------------------------------------------------------------
// Legacy Compatibility (deprecated - use registerFunctionClass instead)
// -------------------------------------------------------------------------

/**
 * @deprecated Use registerFunctionClass() instead
 */
export function registerSystemMethod(name, handler, options = {}) {
  console.warn(`registerSystemMethod('${name}') is deprecated. Use registerFunctionClass() instead.`);

  // Create a dynamic function class for legacy handlers
  class LegacyFunction extends InteractionFunction {
    static register() {
      return {
        name:        name,
        description: options.description || '',
        target:      '@system',
        permission:  options.permission || PERMISSION.ALWAYS,
        schema:      options.inputSchema || null,
      };
    }

    constructor(context) {
      super(name, context);
    }

    async allowed(payload, context) {
      if (typeof options.allowed === 'function') {
        return await options.allowed(payload, context);
      }
      return { allowed: true };
    }

    async execute(params) {
      return await handler(params, this.context);
    }
  }

  registerFunctionClass(LegacyFunction);
}

// Legacy exports for backwards compatibility
export { PERMISSION as PERMISSION_LEVELS };
export const getSystemMethodNames = getRegisteredFunctionNames;
export const getAllSystemMethods = getAllRegisteredFunctions;
export const checkSystemMethodAllowed = checkSystemFunctionAllowed;
export const getSystemMethod = getRegisteredFunctionClass;

/**
 * Call a system function directly (convenience function).
 *
 * @param {string} functionName - Function name
 * @param {*} payload - Payload
 * @param {Object} context - Context
 * @returns {Promise<Object>} Result with status
 */
export async function callSystemMethod(functionName, payload, context = {}) {
  let bus = getInteractionBus();

  let interaction = bus.create(TARGETS.SYSTEM, functionName, payload, {
    sessionId: context.sessionId,
    userId:    context.userId,
  });

  return await bus.send(interaction);
}

export default {
  SystemFunction,
  PERMISSION,
  registerFunctionClass,
  unregisterFunctionClass,
  getRegisteredFunctionClass,
  getRegisteredFunctionNames,
  getAllRegisteredFunctions,
  clearRegisteredFunctions,
  getSystemFunction,
  initializeSystemFunction,
  checkSystemFunctionAllowed,
  buildAgentInstructions,
  // Legacy
  registerSystemMethod,
  getSystemMethodNames,
  getAllSystemMethods,
  checkSystemMethodAllowed,
  getSystemMethod,
  callSystemMethod,
};
