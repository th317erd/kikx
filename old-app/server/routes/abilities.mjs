'use strict';

import { Router } from 'express';
import { requireAuth, getDataKey } from '../middleware/auth.mjs';
import { encryptWithKey, decryptWithKey } from '../encryption.mjs';
import { getDatabase } from '../database.mjs';
import {
  getAbilitiesForApi,
  getAbility,
  loadUserAbilities,
  saveUserAbility,
  updateUserAbility,
  deleteUserAbility,
  getPendingApprovals,
  getApprovalHistory,
} from '../lib/abilities/index.mjs';

const router = Router();

// All routes require authentication
router.use(requireAuth);

/**
 * GET /api/abilities
 * List all abilities (builtin, system, user, plugin).
 */
router.get('/', (req, res) => {
  let { type, source, category } = req.query;

  try {
    // Ensure user abilities are loaded into registry
    let dataKey = getDataKey(req);
    loadUserAbilities(req.user.id, dataKey);

    let abilities = getAbilitiesForApi({ type, source, category });

    return res.json({
      abilities: abilities,
      count:     abilities.length,
    });
  } catch (error) {
    console.error('Failed to get abilities:', error);
    return res.status(500).json({ error: 'Failed to retrieve abilities' });
  }
});

/**
 * POST /api/abilities
 * Create a new user ability (process or function).
 */
router.post('/', async (req, res) => {
  let { name, type, description, content, category, tags, inputSchema, applies } = req.body;

  // Validate required fields
  if (!name || !type) {
    return res.status(400).json({ error: 'Name and type are required' });
  }

  // Validate name format
  if (!/^[a-z][a-z0-9_]*$/.test(name)) {
    return res.status(400).json({ error: 'Name must start with a letter and contain only lowercase letters, numbers, and underscores' });
  }

  // Prevent _ prefix (reserved for system abilities)
  if (name.startsWith('_')) {
    return res.status(400).json({ error: 'Cannot create abilities with "_" prefix (reserved for system)' });
  }

  // Validate type
  if (!['function', 'process'].includes(type)) {
    return res.status(400).json({ error: 'Type must be "function" or "process"' });
  }

  // Process type requires content
  if (type === 'process' && !content) {
    return res.status(400).json({ error: 'Process abilities require content' });
  }

  let db      = getDatabase();
  let dataKey = getDataKey(req);

  // Check for duplicate name
  let existing = db.prepare(`
    SELECT 1 FROM abilities WHERE user_id = ? AND name = ?
  `).get(req.user.id, name);

  if (existing) {
    return res.status(400).json({ error: 'An ability with this name already exists' });
  }

  try {
    let encryptedContent = (content) ? encryptWithKey(content, dataKey) : null;

    let result = db.prepare(`
      INSERT INTO abilities (
        user_id, name, type, source, description, category, tags,
        encrypted_content, input_schema, applies
      ) VALUES (?, ?, ?, 'user', ?, ?, ?, ?, ?, ?)
    `).run(
      req.user.id,
      name,
      type,
      description || null,
      category || null,
      (tags) ? JSON.stringify(tags) : null,
      encryptedContent,
      (inputSchema) ? JSON.stringify(inputSchema) : null,
      applies || null
    );

    // Reload user abilities
    loadUserAbilities(req.user.id, dataKey);

    return res.status(201).json({
      id:      result.lastInsertRowid,
      name:    name,
      type:    type,
      message: 'Ability created successfully',
    });
  } catch (error) {
    console.error('Failed to create ability:', error);
    return res.status(500).json({ error: 'Failed to create ability' });
  }
});

/**
 * GET /api/abilities/:id
 * Get a specific ability by ID.
 */
router.get('/:id', (req, res) => {
  let db      = getDatabase();
  let dataKey = getDataKey(req);

  let row = db.prepare(`
    SELECT id, name, type, source, description, category, tags,
           encrypted_content, input_schema, applies,
           created_at, updated_at
    FROM abilities
    WHERE id = ? AND user_id = ?
  `).get(req.params.id, req.user.id);

  if (!row) {
    return res.status(404).json({ error: 'Ability not found' });
  }

  try {
    let content = (row.encrypted_content) ? decryptWithKey(row.encrypted_content, dataKey) : null;

    return res.json({
      id:          row.id,
      name:        row.name,
      type:        row.type,
      source:      row.source,
      description: row.description,
      category:    row.category,
      tags:        (row.tags) ? JSON.parse(row.tags) : [],
      content:     content,
      inputSchema: (row.input_schema) ? JSON.parse(row.input_schema) : null,
      applies:     row.applies || null,
      createdAt:   row.created_at,
      updatedAt:   row.updated_at,
    });
  } catch (error) {
    console.error('Failed to get ability:', error);
    return res.status(500).json({ error: 'Failed to retrieve ability' });
  }
});

/**
 * PUT /api/abilities/:id
 * Update a user ability.
 */
router.put('/:id', (req, res) => {
  let { name, description, content, category, tags, inputSchema, applies } = req.body;
  let db      = getDatabase();
  let dataKey = getDataKey(req);

  // Check ownership
  let existing = db.prepare(`
    SELECT id, name FROM abilities WHERE id = ? AND user_id = ?
  `).get(req.params.id, req.user.id);

  if (!existing) {
    return res.status(404).json({ error: 'Ability not found' });
  }

  // Validate new name if provided
  if (name && name !== existing.name) {
    if (!/^[a-z][a-z0-9_]*$/.test(name)) {
      return res.status(400).json({ error: 'Invalid name format' });
    }
    if (name.startsWith('_')) {
      return res.status(400).json({ error: 'Cannot use "_" prefix (reserved for system)' });
    }

    let duplicate = db.prepare(`
      SELECT 1 FROM abilities WHERE user_id = ? AND name = ? AND id != ?
    `).get(req.user.id, name, req.params.id);

    if (duplicate) {
      return res.status(400).json({ error: 'Name already in use' });
    }
  }

  try {
    let fields = [];
    let values = [];

    if (name !== undefined) {
      fields.push('name = ?');
      values.push(name);
    }
    if (description !== undefined) {
      fields.push('description = ?');
      values.push(description);
    }
    if (content !== undefined) {
      fields.push('encrypted_content = ?');
      values.push(encryptWithKey(content, dataKey));
    }
    if (category !== undefined) {
      fields.push('category = ?');
      values.push(category);
    }
    if (tags !== undefined) {
      fields.push('tags = ?');
      values.push(JSON.stringify(tags));
    }
    if (inputSchema !== undefined) {
      fields.push('input_schema = ?');
      values.push(JSON.stringify(inputSchema));
    }

    if (applies !== undefined) {
      fields.push('applies = ?');
      values.push(applies || null);
    }

    if (fields.length > 0) {
      fields.push('updated_at = CURRENT_TIMESTAMP');
      values.push(req.params.id, req.user.id);

      db.prepare(`
        UPDATE abilities SET ${fields.join(', ')} WHERE id = ? AND user_id = ?
      `).run(...values);
    }

    // Reload user abilities
    loadUserAbilities(req.user.id, dataKey);

    return res.json({ success: true });
  } catch (error) {
    console.error('Failed to update ability:', error);
    return res.status(500).json({ error: 'Failed to update ability' });
  }
});

/**
 * DELETE /api/abilities/:id
 * Delete a user ability.
 */
router.delete('/:id', (req, res) => {
  let db      = getDatabase();
  let dataKey = getDataKey(req);

  let result = db.prepare(`
    DELETE FROM abilities WHERE id = ? AND user_id = ?
  `).run(req.params.id, req.user.id);

  if (result.changes === 0) {
    return res.status(404).json({ error: 'Ability not found' });
  }

  // Reload user abilities
  loadUserAbilities(req.user.id, dataKey);

  return res.json({ success: true });
});

/**
 * GET /api/abilities/approvals/pending
 * Get pending approval requests for the user.
 */
router.get('/approvals/pending', (req, res) => {
  try {
    let pending = getPendingApprovals(req.user.id);
    return res.json({ approvals: pending });
  } catch (error) {
    console.error('Failed to get pending approvals:', error);
    return res.status(500).json({ error: 'Failed to retrieve pending approvals' });
  }
});

/**
 * GET /api/abilities/approvals/history
 * Get approval history for the user.
 */
router.get('/approvals/history', (req, res) => {
  let limit = parseInt(req.query.limit, 10) || 50;

  try {
    let history = getApprovalHistory(req.user.id, limit);
    return res.json({ history });
  } catch (error) {
    console.error('Failed to get approval history:', error);
    return res.status(500).json({ error: 'Failed to retrieve approval history' });
  }
});

export default router;
