'use strict';

import { getLoadedPlugins } from './loader.mjs';

/**
 * Hook types supported by the plugin system.
 */
export const HOOK_TYPES = {
  BEFORE_USER_MESSAGE:  'beforeUserMessage',
  AFTER_AGENT_RESPONSE: 'afterAgentResponse',
  BEFORE_COMMAND:       'beforeCommand',
  AFTER_COMMAND:        'afterCommand',
  BEFORE_TOOL:          'beforeTool',
  AFTER_TOOL:           'afterTool',
};

/**
 * Execute a hook across all loaded plugins.
 * Hooks are executed in order, with each hook receiving the output of the previous.
 *
 * @param {string} hookType - Hook type from HOOK_TYPES
 * @param {*} data - Data to pass through the hook pipeline
 * @param {object} context - Context object passed to hooks
 * @param {AbortSignal} [signal] - AbortSignal for cancellation
 * @returns {Promise<*>} Modified data after all hooks have run
 */
export async function executeHook(hookType, data, context = {}, signal) {
  if (signal?.aborted)
    throw new Error('Hook execution aborted');

  let plugins = getLoadedPlugins();
  let result  = data;

  for (let plugin of plugins) {
    if (signal?.aborted)
      throw new Error('Hook execution aborted');

    let hooks = plugin.module.hooks;

    if (!hooks || typeof hooks[hookType] !== 'function')
      continue;

    try {
      let hookResult = await hooks[hookType](result, context, signal);

      // If hook returns undefined, keep previous result
      if (hookResult !== undefined)
        result = hookResult;
    } catch (error) {
      // Log error but don't break the pipeline
      console.error(`Plugin "${plugin.metadata.name}" hook "${hookType}" failed:`, error.message);

      // Optionally re-throw for critical hooks
      if (context.throwOnError)
        throw error;
    }
  }

  return result;
}

/**
 * Execute beforeUserMessage hook.
 * Allows plugins to modify user messages before sending to agent.
 *
 * @param {string} message - User message
 * @param {object} context - Context (session, user, etc.)
 * @param {AbortSignal} [signal] - AbortSignal for cancellation
 * @returns {Promise<string>} Modified message
 */
export async function beforeUserMessage(message, context, signal) {
  return await executeHook(HOOK_TYPES.BEFORE_USER_MESSAGE, message, context, signal);
}

/**
 * Execute afterAgentResponse hook.
 * Allows plugins to modify agent responses before returning to user.
 *
 * @param {object} response - Agent response
 * @param {object} context - Context (session, user, etc.)
 * @param {AbortSignal} [signal] - AbortSignal for cancellation
 * @returns {Promise<object>} Modified response
 */
export async function afterAgentResponse(response, context, signal) {
  return await executeHook(HOOK_TYPES.AFTER_AGENT_RESPONSE, response, context, signal);
}

/**
 * Execute beforeCommand hook.
 * Allows plugins to modify command execution.
 *
 * @param {object} commandData - { command, args }
 * @param {object} context - Context (session, user, etc.)
 * @param {AbortSignal} [signal] - AbortSignal for cancellation
 * @returns {Promise<object>} Modified command data
 */
export async function beforeCommand(commandData, context, signal) {
  return await executeHook(HOOK_TYPES.BEFORE_COMMAND, commandData, context, signal);
}

/**
 * Execute afterCommand hook.
 * Allows plugins to process command results.
 *
 * @param {object} resultData - { command, args, result }
 * @param {object} context - Context (session, user, etc.)
 * @param {AbortSignal} [signal] - AbortSignal for cancellation
 * @returns {Promise<object>} Modified result data
 */
export async function afterCommand(resultData, context, signal) {
  return await executeHook(HOOK_TYPES.AFTER_COMMAND, resultData, context, signal);
}

/**
 * Execute beforeTool hook.
 * Allows plugins to modify tool execution.
 *
 * @param {object} toolData - { name, input }
 * @param {object} context - Context (session, user, etc.)
 * @param {AbortSignal} [signal] - AbortSignal for cancellation
 * @returns {Promise<object>} Modified tool data
 */
export async function beforeTool(toolData, context, signal) {
  return await executeHook(HOOK_TYPES.BEFORE_TOOL, toolData, context, signal);
}

/**
 * Execute afterTool hook.
 * Allows plugins to process tool results.
 *
 * @param {object} resultData - { name, input, result }
 * @param {object} context - Context (session, user, etc.)
 * @param {AbortSignal} [signal] - AbortSignal for cancellation
 * @returns {Promise<object>} Modified result data
 */
export async function afterTool(resultData, context, signal) {
  return await executeHook(HOOK_TYPES.AFTER_TOOL, resultData, context, signal);
}

export default {
  HOOK_TYPES,
  executeHook,
  beforeUserMessage,
  afterAgentResponse,
  beforeCommand,
  afterCommand,
  beforeTool,
  afterTool,
};
