'use strict';

import { Router } from 'express';
import { getDatabase } from '../database.mjs';
import { encryptWithKey, decryptWithKey } from '../encryption.mjs';
import { requireAuth, getDataKey } from '../middleware/auth.mjs';
import {
  getSystemProcessNames,
  getSystemProcess,
  getSystemProcessWithMetadata,
  getAllSystemProcesses,
  parseProcessContent,
} from '../lib/processes/index.mjs';

const router = Router();

// All routes require authentication
router.use(requireAuth);

/**
 * GET /api/processes
 * List all processes (system + user) for the current user.
 */
router.get('/', (req, res) => {
  let db = getDatabase();

  // Get user processes (without content for list view)
  let userProcesses = db.prepare(`
    SELECT id, name, description, created_at, updated_at
    FROM processes
    WHERE user_id = ?
    ORDER BY name
  `).all(req.user.id);

  // Get system processes with metadata
  let systemProcesses = getAllSystemProcesses();

  return res.json({
    system: systemProcesses.map((p) => ({
      name:        p.name,
      description: p.description,
      properties:  p.properties,
      type:        'system',
    })),
    user: userProcesses.map((p) => ({
      id:          p.id,
      name:        p.name,
      description: p.description,
      type:        'user',
      createdAt:   p.created_at,
      updatedAt:   p.updated_at,
    })),
  });
});

/**
 * POST /api/processes
 * Create a new user process.
 */
router.post('/', (req, res) => {
  let { name, description, content } = req.body;

  if (!name || !content)
    return res.status(400).json({ error: 'Name and content are required' });

  // Validate name format (alphanumeric + underscores, no spaces)
  if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(name))
    return res.status(400).json({ error: 'Process name must start with a letter and contain only letters, numbers, and underscores' });

  // Disallow _ prefix for user processes (reserved for system)
  if (name.startsWith('_'))
    return res.status(400).json({ error: 'Process name cannot start with "_" (reserved for system)' });

  let db = getDatabase();

  // Check for duplicate name
  let existing = db.prepare('SELECT id FROM processes WHERE user_id = ? AND name = ?').get(req.user.id, name);

  if (existing)
    return res.status(409).json({ error: `Process "${name}" already exists` });

  try {
    let dataKey          = getDataKey(req);
    let encryptedContent = encryptWithKey(content, dataKey);

    let result = db.prepare(`
      INSERT INTO processes (user_id, name, description, encrypted_content)
      VALUES (?, ?, ?, ?)
    `).run(req.user.id, name, description || null, encryptedContent);

    return res.status(201).json({
      id:          result.lastInsertRowid,
      name:        name,
      description: description || null,
      type:        'user',
      createdAt:   new Date().toISOString(),
    });
  } catch (error) {
    console.error('Create process error:', error);
    return res.status(500).json({ error: 'Failed to create process' });
  }
});

/**
 * GET /api/processes/system/:name
 * Get a system process by name.
 */
router.get('/system/:name', (req, res) => {
  let name    = req.params.name;
  let process = getSystemProcessWithMetadata(name);

  if (!process)
    return res.status(404).json({ error: 'System process not found' });

  return res.json({
    name,
    content:     process.content,
    description: process.metadata.description,
    properties:  process.metadata.properties,
    type:        'system',
  });
});

/**
 * GET /api/processes/:id
 * Get a specific user process with decrypted content.
 */
router.get('/:id', (req, res) => {
  let db      = getDatabase();
  let process = db.prepare(`
    SELECT id, name, description, encrypted_content, created_at, updated_at
    FROM processes
    WHERE id = ? AND user_id = ?
  `).get(req.params.id, req.user.id);

  if (!process)
    return res.status(404).json({ error: 'Process not found' });

  try {
    let dataKey    = getDataKey(req);
    let rawContent = decryptWithKey(process.encrypted_content, dataKey);

    // Parse metadata from content
    let { content, metadata } = parseProcessContent(rawContent);

    return res.json({
      id:          process.id,
      name:        process.name,
      description: metadata.description || process.description,
      properties:  metadata.properties,
      content:     content,
      rawContent:  rawContent,  // Include raw for editing
      type:        'user',
      createdAt:   process.created_at,
      updatedAt:   process.updated_at,
    });
  } catch (error) {
    console.error('Get process error:', error);
    return res.status(500).json({ error: 'Failed to get process' });
  }
});

/**
 * PUT /api/processes/:id
 * Update a user process.
 */
router.put('/:id', (req, res) => {
  let { name, description, content } = req.body;

  let db      = getDatabase();
  let process = db.prepare('SELECT id FROM processes WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);

  if (!process)
    return res.status(404).json({ error: 'Process not found' });

  try {
    let dataKey = getDataKey(req);
    let updates = [];
    let values  = [];

    if (name !== undefined) {
      // Validate name format
      if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(name))
        return res.status(400).json({ error: 'Process name must start with a letter and contain only letters, numbers, and underscores' });

      // Disallow _ prefix (reserved for system)
      if (name.startsWith('_'))
        return res.status(400).json({ error: 'Process name cannot start with "_" (reserved for system)' });

      // Check for duplicate name (excluding current process)
      let existing = db.prepare('SELECT id FROM processes WHERE user_id = ? AND name = ? AND id != ?').get(req.user.id, name, req.params.id);

      if (existing)
        return res.status(409).json({ error: `Process "${name}" already exists` });

      updates.push('name = ?');
      values.push(name);
    }

    if (description !== undefined) {
      updates.push('description = ?');
      values.push(description || null);
    }

    if (content !== undefined) {
      let encryptedContent = encryptWithKey(content, dataKey);
      updates.push('encrypted_content = ?');
      values.push(encryptedContent);
    }

    if (updates.length === 0)
      return res.status(400).json({ error: 'No fields to update' });

    updates.push('updated_at = CURRENT_TIMESTAMP');
    values.push(req.params.id);
    values.push(req.user.id);

    db.prepare(`
      UPDATE processes
      SET ${updates.join(', ')}
      WHERE id = ? AND user_id = ?
    `).run(...values);

    return res.json({ success: true });
  } catch (error) {
    console.error('Update process error:', error);
    return res.status(500).json({ error: 'Failed to update process' });
  }
});

/**
 * DELETE /api/processes/:id
 * Delete a user process.
 */
router.delete('/:id', (req, res) => {
  let db     = getDatabase();
  let result = db.prepare('DELETE FROM processes WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);

  if (result.changes === 0)
    return res.status(404).json({ error: 'Process not found' });

  return res.json({ success: true });
});

export default router;
