'use strict';

// ============================================================================
// User Ability Loader
// ============================================================================
// Loads user-defined abilities from the database.

import { getDatabase } from '../../../database.mjs';
import { decryptWithKey, encryptWithKey } from '../../../encryption.mjs';
import { registerAbility, clearAbilitiesBySource, unregisterAbility } from '../registry.mjs';
import { parseProcessContent } from '../../processes/index.mjs';

/**
 * Load user abilities from the database.
 * Abilities are stored encrypted and decrypted on load.
 *
 * @param {number} userId - User ID
 * @param {string} dataKey - User's data encryption key
 * @returns {number} Number of abilities loaded
 */
export function loadUserAbilities(userId, dataKey) {
  let db = getDatabase();
  let count = 0;

  // First, clear user abilities for this user
  // (we track by name prefix or could add userId to ability)
  // For now, clear all user abilities and reload
  clearAbilitiesBySource('user');

  // Load from abilities table
  let abilities = db.prepare(`
    SELECT id, name, type, description, category, tags,
           encrypted_content, input_schema, applies,
           created_at, updated_at
    FROM abilities
    WHERE user_id = ? AND source = 'user'
  `).all(userId);

  for (let row of abilities) {
    try {
      let content = null;
      if (row.encrypted_content)
        content = decryptWithKey(row.encrypted_content, dataKey);

      registerAbility({
        id:          `user-${row.id}`,
        name:        row.name,
        type:        row.type,
        source:      'user',
        content:     content,
        description: row.description || '',
        category:    row.category || 'user',
        tags:        (row.tags) ? JSON.parse(row.tags) : [],
        inputSchema: (row.input_schema) ? JSON.parse(row.input_schema) : null,
        applies:     row.applies || null,
        createdAt:   row.created_at,
        updatedAt:   row.updated_at,
      });

      count++;
    } catch (error) {
      console.error(`Failed to load user ability ${row.name}:`, error.message);
    }
  }

  // Also load legacy processes from processes table
  let processes = db.prepare(`
    SELECT id, name, description, encrypted_content, created_at, updated_at
    FROM processes
    WHERE user_id = ?
  `).all(userId);

  for (let row of processes) {
    try {
      // Skip if already loaded from abilities table
      let abilityName = row.name;
      if (abilities.find((a) => a.name === abilityName))
        continue;

      let content = decryptWithKey(row.encrypted_content, dataKey);
      let { content: parsedContent, metadata } = parseProcessContent(content);

      registerAbility({
        id:          `user-process-${row.id}`,
        name:        row.name,
        type:        'process',
        source:      'user',
        content:     parsedContent,
        description: row.description || metadata.description || '',
        category:    metadata.properties?.category || 'user',
        tags:        metadata.properties?.tags?.split(',').map((t) => t.trim()) || [],
        createdAt:   row.created_at,
        updatedAt:   row.updated_at,
      });

      count++;
    } catch (error) {
      console.error(`Failed to load user process ${row.name}:`, error.message);
    }
  }

  if (count > 0)
    console.log(`Loaded ${count} user abilities for user ${userId}`);

  return count;
}

/**
 * Save a user ability to the database.
 *
 * @param {number} userId - User ID
 * @param {string} dataKey - User's data encryption key
 * @param {Object} ability - Ability data
 * @returns {number} New ability ID
 */
export function saveUserAbility(userId, dataKey, ability) {
  let db = getDatabase();

  let encryptedContent = ability.content
    ? encryptWithKey(ability.content, dataKey)
    : null;

  let result = db.prepare(`
    INSERT INTO abilities (
      user_id, name, type, source, description, category, tags,
      encrypted_content, input_schema, applies
    ) VALUES (?, ?, ?, 'user', ?, ?, ?, ?, ?, ?)
  `).run(
    userId,
    ability.name,
    ability.type,
    ability.description || null,
    ability.category || null,
    (ability.tags) ? JSON.stringify(ability.tags) : null,
    encryptedContent,
    (ability.inputSchema) ? JSON.stringify(ability.inputSchema) : null,
    ability.applies || null
  );

  return result.lastInsertRowid;
}

/**
 * Update a user ability in the database.
 *
 * @param {number} userId - User ID
 * @param {number} abilityId - Ability ID
 * @param {string} dataKey - User's data encryption key
 * @param {Object} updates - Fields to update
 * @returns {boolean} Success
 */
export function updateUserAbility(userId, abilityId, dataKey, updates) {
  let db = getDatabase();

  let fields = [];
  let values = [];

  if (updates.name !== undefined) {
    fields.push('name = ?');
    values.push(updates.name);
  }

  if (updates.description !== undefined) {
    fields.push('description = ?');
    values.push(updates.description);
  }

  if (updates.category !== undefined) {
    fields.push('category = ?');
    values.push(updates.category);
  }

  if (updates.tags !== undefined) {
    fields.push('tags = ?');
    values.push(JSON.stringify(updates.tags));
  }

  if (updates.content !== undefined) {
    fields.push('encrypted_content = ?');
    values.push(encryptWithKey(updates.content, dataKey));
  }

  if (updates.inputSchema !== undefined) {
    fields.push('input_schema = ?');
    values.push(JSON.stringify(updates.inputSchema));
  }

  if (updates.applies !== undefined) {
    fields.push('applies = ?');
    values.push(updates.applies || null);
  }

  if (fields.length === 0)
    return true;

  fields.push('updated_at = CURRENT_TIMESTAMP');

  let sql = `UPDATE abilities SET ${fields.join(', ')} WHERE id = ? AND user_id = ?`;
  values.push(abilityId, userId);

  let result = db.prepare(sql).run(...values);
  return result.changes > 0;
}

/**
 * Delete a user ability from the database.
 *
 * @param {number} userId - User ID
 * @param {number} abilityId - Ability ID
 * @returns {boolean} Success
 */
export function deleteUserAbility(userId, abilityId) {
  let db = getDatabase();

  let result = db.prepare(`
    DELETE FROM abilities WHERE id = ? AND user_id = ?
  `).run(abilityId, userId);

  return result.changes > 0;
}

export default {
  loadUserAbilities,
  saveUserAbility,
  updateUserAbility,
  deleteUserAbility,
};
