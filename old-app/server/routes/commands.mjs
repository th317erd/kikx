'use strict';

import { Router } from 'express';
import { getDatabase } from '../database.mjs';
import { requireAuth } from '../middleware/auth.mjs';
import { getStartupAbilities } from '../lib/abilities/registry.mjs';
import { forceCompaction } from '../lib/compaction.mjs';
import { loadSessionWithAgent } from '../lib/participants/index.mjs';

const router = Router();

// All routes require authentication
router.use(requireAuth);

/**
 * GET /api/commands
 * List all commands for the current user (including plugin commands).
 */
router.get('/', (req, res) => {
  let db       = getDatabase();
  let commands = db.prepare(`
    SELECT id, name, description, created_at, updated_at
    FROM commands
    WHERE user_id = ?
    ORDER BY name
  `).all(req.user.id);

  // TODO: Merge with plugin commands
  // let pluginCommands = getPluginCommands();

  return res.json({
    commands: commands.map((c) => ({
      id:          c.id,
      name:        c.name,
      description: c.description,
      source:      'user',
      createdAt:   c.created_at,
      updatedAt:   c.updated_at,
    })),
  });
});

/**
 * POST /api/commands
 * Create a new user command.
 */
router.post('/', (req, res) => {
  let { name, description, handler } = req.body;

  if (!name || !handler)
    return res.status(400).json({ error: 'Name and handler are required' });

  // Validate command name (alphanumeric and hyphens only)
  if (!/^[a-zA-Z0-9-]+$/.test(name))
    return res.status(400).json({ error: 'Command name can only contain letters, numbers, and hyphens' });

  let db = getDatabase();

  // Check for duplicate name
  let existing = db.prepare('SELECT id FROM commands WHERE user_id = ? AND name = ?').get(req.user.id, name);

  if (existing)
    return res.status(409).json({ error: `Command "/${name}" already exists` });

  try {
    let result = db.prepare(`
      INSERT INTO commands (user_id, name, description, handler)
      VALUES (?, ?, ?, ?)
    `).run(req.user.id, name, description || null, handler);

    return res.status(201).json({
      id:          result.lastInsertRowid,
      name:        name,
      description: description || null,
      source:      'user',
      createdAt:   new Date().toISOString(),
    });
  } catch (error) {
    console.error('Create command error:', error);
    return res.status(500).json({ error: 'Failed to create command' });
  }
});

/**
 * GET /api/commands/start
 * Get the startup instructions content for re-injection.
 */
router.get('/start', (req, res) => {
  let startupAbilities = getStartupAbilities();
  let processAbilities = startupAbilities.filter((a) => a.type === 'process' && a.content);

  if (processAbilities.length === 0) {
    return res.status(404).json({
      success: false,
      error:   'No startup abilities found',
    });
  }

  let startupContent = processAbilities
    .map((a) => a.content)
    .join('\n\n---\n\n');

  return res.json({
    success:       true,
    content:       startupContent,
    abilityCount:  processAbilities.length,
    abilityNames:  processAbilities.map((a) => a.name),
  });
});

/**
 * POST /api/commands/compact
 * Force conversation compaction for the current session.
 */
router.post('/compact', async (req, res) => {
  let { sessionId } = req.body;

  if (!sessionId) {
    return res.status(400).json({
      success: false,
      error:   'sessionId is required',
    });
  }

  // Get agent for the session (via participants, falls back to legacy agent_id)
  let db      = getDatabase();
  let session = loadSessionWithAgent(sessionId, req.user.id, db);

  if (!session) {
    return res.status(404).json({
      success: false,
      error:   'Session not found',
    });
  }

  try {
    // Create minimal agent object for compaction
    let agent = {
      id:   session.agent_id,
      type: session.agent_type,
    };

    let result = await forceCompaction(sessionId, req.user.id, agent);

    if (result.success) {
      return res.json({
        success: true,
        message: `Compacted ${result.compactedCount} messages into summary.`,
        details: {
          snapshotId:    result.snapshotId,
          messagesCount: result.compactedCount,
          summaryLength: result.summaryLength,
        },
      });
    } else {
      return res.json({
        success: false,
        error:   result.reason || 'Compaction failed',
      });
    }
  } catch (error) {
    return res.status(500).json({
      success: false,
      error:   `Compaction error: ${error.message}`,
    });
  }
});

/**
 * GET /api/commands/:id
 * Get a specific command.
 */
router.get('/:id', (req, res) => {
  let db      = getDatabase();
  let command = db.prepare(`
    SELECT id, name, description, handler, created_at, updated_at
    FROM commands
    WHERE id = ? AND user_id = ?
  `).get(req.params.id, req.user.id);

  if (!command)
    return res.status(404).json({ error: 'Command not found' });

  return res.json({
    id:          command.id,
    name:        command.name,
    description: command.description,
    handler:     command.handler,
    source:      'user',
    createdAt:   command.created_at,
    updatedAt:   command.updated_at,
  });
});

/**
 * PUT /api/commands/:id
 * Update a command.
 */
router.put('/:id', (req, res) => {
  let { name, description, handler } = req.body;

  let db      = getDatabase();
  let command = db.prepare('SELECT id FROM commands WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);

  if (!command)
    return res.status(404).json({ error: 'Command not found' });

  let updates = [];
  let values  = [];

  if (name !== undefined) {
    if (!/^[a-zA-Z0-9-]+$/.test(name))
      return res.status(400).json({ error: 'Command name can only contain letters, numbers, and hyphens' });

    // Check for duplicate name (excluding current command)
    let existing = db.prepare('SELECT id FROM commands WHERE user_id = ? AND name = ? AND id != ?').get(req.user.id, name, req.params.id);

    if (existing)
      return res.status(409).json({ error: `Command "/${name}" already exists` });

    updates.push('name = ?');
    values.push(name);
  }

  if (description !== undefined) {
    updates.push('description = ?');
    values.push(description || null);
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
    UPDATE commands
    SET ${updates.join(', ')}
    WHERE id = ? AND user_id = ?
  `).run(...values);

  return res.json({ success: true });
});

/**
 * DELETE /api/commands/:id
 * Delete a command.
 */
router.delete('/:id', (req, res) => {
  let db     = getDatabase();
  let result = db.prepare('DELETE FROM commands WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);

  if (result.changes === 0)
    return res.status(404).json({ error: 'Command not found' });

  return res.json({ success: true });
});

export default router;
