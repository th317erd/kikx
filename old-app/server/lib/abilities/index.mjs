'use strict';

// ============================================================================
// Abilities System - Main Module
// ============================================================================
// Unified system for processes and functions with permission management.

// Import for internal use
import {
  getAllAbilities as _getAllAbilities,
  getAbilitiesByType as _getAbilitiesByType,
  getAbilitiesBySource as _getAbilitiesBySource,
  getAbilitiesByCategory as _getAbilitiesByCategory,
} from './registry.mjs';

// Re-export everything from submodules
export {
  registerAbility,
  getAbility,
  hasAbility,
  unregisterAbility,
  getAllAbilities,
  getAbilityNames,
  getAbilitiesByType,
  getAbilitiesBySource,
  getAbilitiesByCategory,
  getAbilitiesByTag,
  getConditionalAbilities,
  getStartupAbilities,
  clearAbilities,
  clearAbilitiesBySource,
  serializeAbility,
  serializeAllAbilities,
} from './registry.mjs';

export {
  checkApprovalRequired,
  hasSessionApproval,
  grantSessionApproval,
  revokeSessionApproval,
  requestApproval,
  handleApprovalResponse,
  cancelApproval,
  getPendingApprovals,
  getApprovalHistory,
} from './approval.mjs';

export {
  askQuestion,
  handleQuestionAnswer,
  cancelQuestion,
  isQuestionPending,
  getPendingQuestionIds,
  askYesNo,
  askNumber,
  askText,
} from './question.mjs';

export {
  executeAbility,
  executeAbilitiesSequential,
  executeAbilitiesParallel,
} from './executor.mjs';

export {
  checkConditionalAbilities,
  formatConditionalInstructions,
  getUnansweredPrompts,
} from './conditional.mjs';

// Loaders
import { loadStartupAbility } from './loaders/startup.mjs';
import { loadBuiltinAbilities } from './loaders/builtin.mjs';
import { loadSystemAbilities } from './loaders/system.mjs';
import { loadUserAbilities, saveUserAbility, updateUserAbility, deleteUserAbility } from './loaders/user.mjs';
import { loadPluginAbilities, loadAllPluginAbilities } from './loaders/plugin.mjs';
import { loadCommandAbilities } from './loaders/commands.mjs';

export {
  loadStartupAbility,
  loadBuiltinAbilities,
  loadSystemAbilities,
  loadUserAbilities,
  saveUserAbility,
  updateUserAbility,
  deleteUserAbility,
  loadPluginAbilities,
  loadAllPluginAbilities,
  loadCommandAbilities,
};

/**
 * Initialize the abilities system.
 * Loads builtin and system abilities.
 *
 * @returns {Promise<void>}
 */
export async function initializeAbilities() {
  console.log('Initializing abilities system...');

  // Load core startup ability (__onstart_.md)
  let startupCount = loadStartupAbility();
  console.log(`Loaded ${startupCount} startup abilities`);

  // Load builtin function abilities
  let builtinCount = loadBuiltinAbilities();
  console.log(`Loaded ${builtinCount} builtin abilities`);

  // Load command abilities (with "Ask Always" permission)
  let commandCount = loadCommandAbilities();
  console.log(`Loaded ${commandCount} command abilities`);

  // Load system process abilities from .md files
  let systemCount = await loadSystemAbilities();
  console.log(`Loaded ${systemCount} system abilities`);

  console.log('Abilities system initialized');
}

/**
 * Load all abilities for a user (call after authentication).
 *
 * @param {number} userId - User ID
 * @param {string} dataKey - User's data encryption key
 * @param {Array} [plugins=[]] - Loaded plugins
 * @returns {number} Total abilities loaded
 */
export function loadAllAbilitiesForUser(userId, dataKey, plugins = []) {
  let total = 0;

  // Load user abilities from database
  total += loadUserAbilities(userId, dataKey);

  // Load plugin abilities
  if (plugins.length > 0) {
    total += loadAllPluginAbilities(plugins);
  }

  return total;
}

/**
 * Get all abilities suitable for API response (serialized).
 *
 * @param {Object} [filters] - Optional filters
 * @param {string} [filters.type] - Filter by type
 * @param {string} [filters.source] - Filter by source
 * @param {string} [filters.category] - Filter by category
 * @returns {Array} Serialized abilities
 */
export function getAbilitiesForApi(filters = {}) {
  let abilities;

  if (filters.type) {
    abilities = _getAbilitiesByType(filters.type);
  } else if (filters.source) {
    abilities = _getAbilitiesBySource(filters.source);
  } else if (filters.category) {
    abilities = _getAbilitiesByCategory(filters.category);
  } else {
    abilities = _getAllAbilities();
  }

  // Serialize (remove execute functions, fix IDs for user abilities)
  return abilities.map((a) => {
    let { execute, ...rest } = a;
    // Convert "user-{id}" back to numeric id for frontend
    if (rest.source === 'user' && typeof rest.id === 'string' && rest.id.startsWith('user-')) {
      rest.id = parseInt(rest.id.replace('user-', ''), 10);
    }
    return rest;
  });
}

export default {
  initializeAbilities,
  loadAllAbilitiesForUser,
  getAbilitiesForApi,
};
