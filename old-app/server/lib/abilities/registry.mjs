'use strict';

// ============================================================================
// Unified Ability Registry
// ============================================================================
// Central registry for all abilities (processes and functions).
// Abilities can come from: builtin, system, user, or plugin sources.

/**
 * @typedef {Object} AbilityPermissions
 * @property {boolean} autoApprove - Skip approval for this ability
 * @property {'always'|'session'|'never'|'ask'} autoApprovePolicy - When to auto-approve
 * @property {'safe'|'moderate'|'dangerous'} dangerLevel - Risk level indicator
 */

/**
 * @typedef {Object} Ability
 * @property {string} id - Unique identifier
 * @property {string} name - Display name (unique within scope)
 * @property {'function'|'process'} type - Ability type
 * @property {'builtin'|'system'|'user'|'plugin'} source - Where this ability comes from
 * @property {string} [pluginName] - Plugin name if source is 'plugin'
 * @property {string} [content] - Content for process-type abilities
 * @property {Function} [execute] - Execute function for function-type abilities
 * @property {Object} [inputSchema] - JSON Schema for input validation
 * @property {string} description - Human-readable description
 * @property {string} [category] - Category for organization
 * @property {string[]} [tags] - Tags for filtering
 * @property {AbilityPermissions} permissions - Permission settings
 * @property {string} [applies] - Freeform question for conditional auto-application
 * @property {string} [createdAt] - Creation timestamp
 * @property {string} [updatedAt] - Last update timestamp
 */

// In-memory registry
const abilities = new Map();

/**
 * Register an ability in the registry.
 *
 * @param {Ability} ability - The ability to register
 * @throws {Error} If ability with same name already exists
 */
export function registerAbility(ability) {
  if (!ability.name) {
    throw new Error('Ability must have a name');
  }

  if (!ability.type || !['function', 'process'].includes(ability.type)) {
    throw new Error('Ability must have a valid type (function or process)');
  }

  if (!ability.source || !['builtin', 'system', 'user', 'plugin', 'startup'].includes(ability.source)) {
    throw new Error('Ability must have a valid source');
  }

  // Ensure permissions have defaults
  ability.permissions = {
    autoApprove:       false,
    autoApprovePolicy: 'ask',
    dangerLevel:       'safe',
    ...ability.permissions,
  };

  abilities.set(ability.name, ability);
}

/**
 * Get an ability by name.
 *
 * @param {string} name - The ability name
 * @returns {Ability|undefined} The ability or undefined
 */
export function getAbility(name) {
  return abilities.get(name);
}

/**
 * Check if an ability exists.
 *
 * @param {string} name - The ability name
 * @returns {boolean} True if ability exists
 */
export function hasAbility(name) {
  return abilities.has(name);
}

/**
 * Unregister an ability.
 *
 * @param {string} name - The ability name
 * @returns {boolean} True if ability was removed
 */
export function unregisterAbility(name) {
  return abilities.delete(name);
}

/**
 * Get all abilities.
 *
 * @returns {Ability[]} Array of all abilities
 */
export function getAllAbilities() {
  return Array.from(abilities.values());
}

/**
 * Get all ability names.
 *
 * @returns {string[]} Array of ability names
 */
export function getAbilityNames() {
  return Array.from(abilities.keys()).sort();
}

/**
 * Get abilities filtered by type.
 *
 * @param {'function'|'process'} type - The ability type
 * @returns {Ability[]} Filtered abilities
 */
export function getAbilitiesByType(type) {
  return getAllAbilities().filter((a) => a.type === type);
}

/**
 * Get abilities filtered by source.
 *
 * @param {'builtin'|'system'|'user'|'plugin'} source - The source
 * @returns {Ability[]} Filtered abilities
 */
export function getAbilitiesBySource(source) {
  return getAllAbilities().filter((a) => a.source === source);
}

/**
 * Get abilities filtered by category.
 *
 * @param {string} category - The category
 * @returns {Ability[]} Filtered abilities
 */
export function getAbilitiesByCategory(category) {
  return getAllAbilities().filter((a) => a.category === category);
}

/**
 * Get abilities that match a tag.
 *
 * @param {string} tag - The tag to match
 * @returns {Ability[]} Filtered abilities
 */
export function getAbilitiesByTag(tag) {
  return getAllAbilities().filter((a) => a.tags && a.tags.includes(tag));
}

/**
 * Get abilities that have conditional application rules.
 * These abilities have an 'applies' field with a question for the AI to evaluate.
 *
 * @returns {Ability[]} Abilities with 'applies' conditions
 */
export function getConditionalAbilities() {
  return getAllAbilities().filter((a) => a.applies && typeof a.applies === 'string');
}

/**
 * Get startup abilities (names starting with _onstart_).
 * Sorted so abilities with more leading underscores run first.
 *
 * Sorting order:
 *   __onstart_  (builtin, runs first)
 *   _onstart_a
 *   _onstart_b
 *
 * @returns {Ability[]} Startup abilities in execution order
 */
export function getStartupAbilities() {
  let startupAbilities = getAllAbilities().filter(
    (a) => a.name.startsWith('_onstart_') || a.name.startsWith('__onstart_')
  );

  // Sort by name - this naturally puts '__' before '_' due to ASCII ordering
  // Then alphabetically within same prefix
  startupAbilities.sort((a, b) => {
    // Count leading underscores (more underscores = higher priority = earlier)
    let aUnderscores = a.name.match(/^_+/)?.[0].length || 0;
    let bUnderscores = b.name.match(/^_+/)?.[0].length || 0;

    // More underscores comes first (descending)
    if (aUnderscores !== bUnderscores)
      return bUnderscores - aUnderscores;

    // Same number of underscores: alphabetical
    return a.name.localeCompare(b.name);
  });

  return startupAbilities;
}

/**
 * Clear all abilities from the registry.
 * Useful for testing or reloading.
 */
export function clearAbilities() {
  abilities.clear();
}

/**
 * Clear abilities from a specific source.
 *
 * @param {'builtin'|'system'|'user'|'plugin'} source - The source to clear
 */
export function clearAbilitiesBySource(source) {
  for (let [name, ability] of abilities) {
    if (ability.source === source) {
      abilities.delete(name);
    }
  }
}

/**
 * Get a serializable summary of an ability (without execute function).
 *
 * @param {Ability} ability - The ability
 * @returns {Object} Serializable ability data
 */
export function serializeAbility(ability) {
  let { execute, ...serializable } = ability;
  return serializable;
}

/**
 * Get all abilities as serializable objects.
 *
 * @returns {Object[]} Array of serializable abilities
 */
export function serializeAllAbilities() {
  return getAllAbilities().map(serializeAbility);
}

export default {
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
};
