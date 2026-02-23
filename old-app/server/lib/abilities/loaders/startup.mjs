'use strict';

// ============================================================================
// Startup Ability Loader
// ============================================================================
// Loads the core __onstart_ ability from __onstart_.md
//
// Startup abilities use a special naming convention:
//   __onstart_* - Double underscore, highest priority (runs first)
//   _onstart_*  - Single underscore, standard priority
//
// The __onstart_.md file contains core instructions that run before
// any user or plugin startup abilities.

import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { registerAbility, clearAbilitiesBySource } from '../registry.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

// Path to the __onstart_.md file
const ONSTART_FILE = join(__dirname, '..', '..', 'processes', '__onstart_.md');

/**
 * Load the core __onstart_ startup ability.
 *
 * @returns {number} Number of abilities loaded (0 or 1)
 */
export function loadStartupAbility() {
  // Clear any existing startup abilities from this source
  // (we use 'startup' as a distinct source for the core startup ability)
  clearAbilitiesBySource('startup');

  if (!existsSync(ONSTART_FILE)) {
    console.warn(`Startup ability file not found: ${ONSTART_FILE}`);
    return 0;
  }

  try {
    let content = readFileSync(ONSTART_FILE, 'utf8');

    registerAbility({
      id:          'startup-__onstart_',
      name:        '__onstart_',
      type:        'process',
      source:      'startup',
      description: 'Core startup instructions for AI agents',
      category:    'startup',
      tags:        ['startup', 'system', 'instructions', 'core'],
      content:     content,
      permissions: {
        autoApprove:       true,
        autoApprovePolicy: 'always',
        dangerLevel:       'safe',
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    console.log('Loaded startup ability: __onstart_');
    return 1;
  } catch (error) {
    console.error('Failed to load startup ability:', error.message);
    return 0;
  }
}

export default { loadStartupAbility };
