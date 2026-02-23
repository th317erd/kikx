'use strict';

// ============================================================================
// System Ability Loader
// ============================================================================
// Loads system processes from .md files as abilities.

import { readdir, readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join, basename } from 'path';
import { registerAbility, clearAbilitiesBySource } from '../registry.mjs';
import { parseProcessContent } from '../../processes/index.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

// System processes directory
const PROCESSES_DIR = join(__dirname, '../../processes');

/**
 * Load all system processes from .md files as abilities.
 * Files are named _<basename> (e.g., think.md -> _think)
 *
 * @returns {Promise<number>} Number of abilities loaded
 */
export async function loadSystemAbilities() {
  // Clear existing system abilities
  clearAbilitiesBySource('system');

  let count = 0;

  try {
    let entries = await readdir(PROCESSES_DIR);

    for (let entry of entries) {
      if (!entry.endsWith('.md'))
        continue;

      // Skip files starting with __ (handled by startup loader)
      if (entry.startsWith('__'))
        continue;

      let baseName = basename(entry, '.md');

      // For _onstart_* files, keep the name as-is for proper startup sorting
      // For other files, prefix with _
      let name = baseName.startsWith('_onstart_') ? baseName : '_' + baseName;
      let raw  = await readFile(join(PROCESSES_DIR, entry), 'utf8');
      let { content, metadata } = parseProcessContent(raw);

      registerAbility({
        id:          `system-${name}`,
        name:        name,
        type:        'process',
        source:      'system',
        content:     content,
        description: metadata.description || `System process: ${name}`,
        category:    metadata.properties?.category || 'system',
        tags:        metadata.properties?.tags?.split(',').map((t) => t.trim()) || [],
        permissions: {
          autoApprove:       true,  // System processes auto-approve by default
          autoApprovePolicy: 'always',
          dangerLevel:       'safe',
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      count++;
      console.log(`Loaded system ability: ${name}`);
    }
  } catch (error) {
    console.error('Failed to load system abilities:', error);
  }

  return count;
}

export default { loadSystemAbilities };
