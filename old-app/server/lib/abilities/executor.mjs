'use strict';

// ============================================================================
// Ability Executor
// ============================================================================
// Executes abilities with approval flow and result handling.

import { getAbility } from './registry.mjs';
import { checkApprovalRequired, requestApproval, grantSessionApproval } from './approval.mjs';
import { broadcastToSession } from '../websocket.mjs';
import { injectProcesses, buildProcessMap } from '../processes/index.mjs';

/**
 * Execute an ability by name.
 *
 * @param {string} abilityName - Name of the ability to execute
 * @param {Object} params - Execution parameters
 * @param {Object} context - Execution context
 * @param {number} context.userId - User ID
 * @param {number} [context.sessionId] - Session ID
 * @param {string} [context.dataKey] - User's data key
 * @param {number} [context.approvalTimeout=0] - Approval timeout (0 = wait forever)
 * @param {boolean} [context.userInitiated=false] - If true, bypass approval (user explicitly requested)
 * @returns {Promise<Object>} Execution result
 */
export async function executeAbility(abilityName, params, context) {
  let ability = getAbility(abilityName);

  if (!ability) {
    return {
      success: false,
      status:  'error',
      error:   `Unknown ability: ${abilityName}`,
    };
  }

  // Broadcast execution start to all session participants
  broadcastToSession(context.sessionId, {
    type:        'ability_execution_start',
    abilityName: ability.name,
    abilityType: ability.type,
    params:      params,
    sessionId:   context.sessionId,
  });

  try {
    // Check if approval is required
    // User-initiated commands bypass approval (user explicitly requested the action)
    let needsApproval = !context.userInitiated && await checkApprovalRequired(ability, context);

    if (needsApproval) {
      // Request approval from user
      let approval = await requestApproval(
        ability,
        params,
        context,
        context.approvalTimeout || 0
      );

      if (approval.status !== 'approved') {
        broadcastToSession(context.sessionId, {
          type:        'ability_execution_denied',
          abilityName: ability.name,
          reason:      approval.reason,
          sessionId:   context.sessionId,
        });

        return {
          success: false,
          status:  approval.status,
          reason:  approval.reason || 'Approval denied',
        };
      }

      // If approved with session policy, remember for session
      if (ability.permissions.autoApprovePolicy === 'session' && context.sessionId) {
        grantSessionApproval(context.sessionId, ability.name);
      }
    }

    // Execute based on ability type
    let result;

    if (ability.type === 'function') {
      result = await executeFunctionAbility(ability, params, context);
    } else if (ability.type === 'process') {
      result = await executeProcessAbility(ability, params, context);
    } else {
      result = {
        success: false,
        status:  'error',
        error:   `Unknown ability type: ${ability.type}`,
      };
    }

    // Broadcast execution complete to all session participants
    broadcastToSession(context.sessionId, {
      type:        'ability_execution_complete',
      abilityName: ability.name,
      abilityType: ability.type,
      result:      result,
      sessionId:   context.sessionId,
    });

    return result;

  } catch (error) {
    // Broadcast execution error to all session participants
    broadcastToSession(context.sessionId, {
      type:        'ability_execution_error',
      abilityName: ability.name,
      error:       error.message,
      sessionId:   context.sessionId,
    });

    return {
      success: false,
      status:  'error',
      error:   error.message,
    };
  }
}

/**
 * Execute a function-type ability.
 *
 * @param {Object} ability - The ability
 * @param {Object} params - Parameters
 * @param {Object} context - Execution context
 * @returns {Promise<Object>} Result
 */
async function executeFunctionAbility(ability, params, context) {
  if (typeof ability.execute !== 'function') {
    return {
      success: false,
      status:  'error',
      error:   `Ability ${ability.name} has no execute function`,
    };
  }

  // TODO: Validate params against inputSchema if present

  let result = await ability.execute(params, context);

  // Normalize result
  if (result === undefined || result === null) {
    return { success: true, result: null };
  }

  if (typeof result === 'object' && result.hasOwnProperty('success')) {
    return result;
  }

  return { success: true, result };
}

/**
 * Execute a process-type ability.
 * Process abilities inject their content into the conversation context.
 *
 * @param {Object} ability - The ability
 * @param {Object} params - Parameters (can include template variables)
 * @param {Object} context - Execution context
 * @returns {Promise<Object>} Result with processed content
 */
async function executeProcessAbility(ability, params, context) {
  if (!ability.content) {
    return {
      success: false,
      status:  'error',
      error:   `Ability ${ability.name} has no content`,
    };
  }

  let content = ability.content;

  // Inject template variables if provided
  if (params && typeof params === 'object') {
    for (let [key, value] of Object.entries(params)) {
      let pattern = new RegExp(`\\{\\{${key}\\}\\}`, 'gi');
      content = content.replace(pattern, String(value));
    }
  }

  // Inject built-in template variables
  let now = new Date();
  content = content
    .replace(/\{\{DATE\}\}/gi, now.toLocaleDateString())
    .replace(/\{\{TIME\}\}/gi, now.toLocaleTimeString())
    .replace(/\{\{DATETIME\}\}/gi, now.toISOString())
    .replace(/\{\{USER_ID\}\}/gi, String(context.userId || ''))
    .replace(/\{\{SESSION_ID\}\}/gi, String(context.sessionId || ''))
    .replace(/\{\{USER_NAME\}\}/gi, context.username || '')
    .replace(/\{\{SESSION_NAME\}\}/gi, context.sessionName || '');

  return {
    success: true,
    content: content,
    injected: true,
  };
}

/**
 * Execute multiple abilities in sequence.
 *
 * @param {Array<{name: string, params: Object}>} abilities - Abilities to execute
 * @param {Object} context - Execution context
 * @returns {Promise<Array>} Results for each ability
 */
export async function executeAbilitiesSequential(abilities, context) {
  let results = [];

  for (let { name, params } of abilities) {
    let result = await executeAbility(name, params, context);
    results.push({ name, result });

    // Stop on error if configured
    if (!result.success && context.stopOnError) {
      break;
    }
  }

  return results;
}

/**
 * Execute multiple abilities in parallel.
 *
 * @param {Array<{name: string, params: Object}>} abilities - Abilities to execute
 * @param {Object} context - Execution context
 * @returns {Promise<Array>} Results for each ability
 */
export async function executeAbilitiesParallel(abilities, context) {
  let promises = abilities.map(async ({ name, params }) => {
    let result = await executeAbility(name, params, context);
    return { name, result };
  });

  return Promise.all(promises);
}

export default {
  executeAbility,
  executeAbilitiesSequential,
  executeAbilitiesParallel,
};
