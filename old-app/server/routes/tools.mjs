'use strict';

import { Router } from 'express';
import { getDatabase } from '../database.mjs';
import { requireAuth } from '../middleware/auth.mjs';

const router = Router();

// All routes require authentication
router.use(requireAuth);

/**
 * GET /api/tools
 * List all tools for the current user (including plugin tools).
 */
router.get('/', (req, res) => {
  let db    = getDatabase();
  let tools = db.prepare(`
    SELECT id, name, description, input_schema, created_at, updated_at
    FROM tools
    WHERE user_id = ?
    ORDER BY name
  `).all(req.user.id);

  // TODO: Merge with plugin tools
  // let pluginTools = getPluginTools();

  return res.json({
    tools: tools.map((t) => ({
      id:          t.id,
      name:        t.name,
      description: t.description,
      inputSchema: JSON.parse(t.input_schema),
      source:      'user',
      createdAt:   t.created_at,
      updatedAt:   t.updated_at,
    })),
  });
});

/**
 * POST /api/tools
 * Create a new user tool.
 */
router.post('/', (req, res) => {
  let { name, description, inputSchema, handler } = req.body;

  if (!name || !inputSchema || !handler)
    return res.status(400).json({ error: 'Name, inputSchema, and handler are required' });

  // Validate tool name (alphanumeric and underscores only - matching Anthropic tool naming)
  if (!/^[a-zA-Z0-9_]+$/.test(name))
    return res.status(400).json({ error: 'Tool name can only contain letters, numbers, and underscores' });

  // Validate inputSchema is valid JSON schema
  if (typeof inputSchema !== 'object' || inputSchema.type !== 'object')
    return res.status(400).json({ error: 'inputSchema must be a valid JSON schema with type "object"' });

  let db = getDatabase();

  // Check for duplicate name
  let existing = db.prepare('SELECT id FROM tools WHERE user_id = ? AND name = ?').get(req.user.id, name);

  if (existing)
    return res.status(409).json({ error: `Tool "${name}" already exists` });

  try {
    let result = db.prepare(`
      INSERT INTO tools (user_id, name, description, input_schema, handler)
      VALUES (?, ?, ?, ?, ?)
    `).run(req.user.id, name, description || null, JSON.stringify(inputSchema), handler);

    return res.status(201).json({
      id:          result.lastInsertRowid,
      name:        name,
      description: description || null,
      inputSchema: inputSchema,
      source:      'user',
      createdAt:   new Date().toISOString(),
    });
  } catch (error) {
    console.error('Create tool error:', error);
    return res.status(500).json({ error: 'Failed to create tool' });
  }
});

/**
 * GET /api/tools/:id
 * Get a specific tool.
 */
router.get('/:id', (req, res) => {
  let db   = getDatabase();
  let tool = db.prepare(`
    SELECT id, name, description, input_schema, handler, created_at, updated_at
    FROM tools
    WHERE id = ? AND user_id = ?
  `).get(req.params.id, req.user.id);

  if (!tool)
    return res.status(404).json({ error: 'Tool not found' });

  return res.json({
    id:          tool.id,
    name:        tool.name,
    description: tool.description,
    inputSchema: JSON.parse(tool.input_schema),
    handler:     tool.handler,
    source:      'user',
    createdAt:   tool.created_at,
    updatedAt:   tool.updated_at,
  });
});

/**
 * PUT /api/tools/:id
 * Update a tool.
 */
router.put('/:id', (req, res) => {
  let { name, description, inputSchema, handler } = req.body;

  let db   = getDatabase();
  let tool = db.prepare('SELECT id FROM tools WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);

  if (!tool)
    return res.status(404).json({ error: 'Tool not found' });

  let updates = [];
  let values  = [];

  if (name !== undefined) {
    if (!/^[a-zA-Z0-9_]+$/.test(name))
      return res.status(400).json({ error: 'Tool name can only contain letters, numbers, and underscores' });

    // Check for duplicate name (excluding current tool)
    let existing = db.prepare('SELECT id FROM tools WHERE user_id = ? AND name = ? AND id != ?').get(req.user.id, name, req.params.id);

    if (existing)
      return res.status(409).json({ error: `Tool "${name}" already exists` });

    updates.push('name = ?');
    values.push(name);
  }

  if (description !== undefined) {
    updates.push('description = ?');
    values.push(description || null);
  }

  if (inputSchema !== undefined) {
    if (typeof inputSchema !== 'object' || inputSchema.type !== 'object')
      return res.status(400).json({ error: 'inputSchema must be a valid JSON schema with type "object"' });

    updates.push('input_schema = ?');
    values.push(JSON.stringify(inputSchema));
  }

  if (handler !== undefined) {
    updates.push('handler = ?');
    values.push(handler);
  }

  if (updates.length === 0)
    return res.status(400).json({ error: 'No fields to update' });

  updates.push('updated_at = CURRENT_TIMESTAMP');
  values.push(req.params.id);
  values.push(req.user.id);

  db.prepare(`
    UPDATE tools
    SET ${updates.join(', ')}
    WHERE id = ? AND user_id = ?
  `).run(...values);

  return res.json({ success: true });
});

/**
 * DELETE /api/tools/:id
 * Delete a tool.
 */
router.delete('/:id', (req, res) => {
  let db     = getDatabase();
  let result = db.prepare('DELETE FROM tools WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);

  if (result.changes === 0)
    return res.status(404).json({ error: 'Tool not found' });

  return res.json({ success: true });
});

export default router;
