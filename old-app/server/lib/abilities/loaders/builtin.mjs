'use strict';

// ============================================================================
// Builtin Ability Loader
// ============================================================================
// Loads built-in abilities. Currently empty — system abilities will come
// from plugins. The loader infrastructure remains for future use.

import { registerAbility, clearAbilitiesBySource } from '../registry.mjs';

/**
 * Built-in conditional abilities.
 * Reserved for future plugin-provided conditional abilities.
 */
const BUILTIN_CONDITIONAL_ABILITIES = [];

/**
 * Built-in function abilities.
 * Reserved for future plugin-provided function abilities.
 *
 * Note: The previous defaults (websearch, bash, ask_user, read_file, write_file,
 * prompt_response_handler) were removed — they were commands/functions, not abilities.
 * System abilities will come from plugins.
 */
const BUILTIN_ABILITIES = [];

/**
 * Load all built-in abilities (both function and conditional).
 *
 * @returns {number} Number of abilities loaded
 */
export function loadBuiltinAbilities() {
  // Clear existing builtin abilities
  clearAbilitiesBySource('builtin');

  let count = 0;

  // Load function abilities
  for (let ability of BUILTIN_ABILITIES) {
    registerAbility({
      ...ability,
      id:        `builtin-${ability.name}`,
      source:    'builtin',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    count++;
    console.log(`Loaded builtin ability: ${ability.name}`);
  }

  // Load conditional abilities
  for (let ability of BUILTIN_CONDITIONAL_ABILITIES) {
    registerAbility({
      ...ability,
      id:        `builtin-${ability.name}`,
      source:    'builtin',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    count++;
    console.log(`Loaded builtin conditional ability: ${ability.name}`);
  }

  return count;
}

export default { loadBuiltinAbilities };
