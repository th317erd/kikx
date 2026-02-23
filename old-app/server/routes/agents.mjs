'use strict';

import { Router } from 'express';
import { getDatabase } from '../database.mjs';
import { encryptWithKey, decryptWithKey } from '../encryption.mjs';
import { requireAuth, getDataKey } from '../middleware/auth.mjs';
import { getAgentAvatar } from '../lib/avatars.mjs';

const router = Router();

// All routes require authentication
router.use(requireAuth);

/**
 * GET /api/agents
 * List all agents for the current user.
 */
router.get('/', (req, res) => {
  let db     = getDatabase();
  let agents = db.prepare(`
    SELECT id, name, type, api_url, avatar_url, encrypted_config, default_processes, created_at, updated_at
    FROM agents
    WHERE user_id = ?
    ORDER BY name
  `).all(req.user.id);

  let dataKey = getDataKey(req);

  return res.json({
    agents: agents.map((a) => {
      // Decrypt config to get model info
      let config = {};
      if (a.encrypted_config) {
        try {
          let decrypted = decryptWithKey(a.encrypted_config, dataKey);
          config = JSON.parse(decrypted);
        } catch (e) {
          // Ignore decryption errors
        }
      }

      return {
        id:               a.id,
        name:             a.name,
        type:             a.type,
        apiUrl:           a.api_url,
        avatarUrl:        getAgentAvatar(a),
        config:           config,
        defaultAbilities: (() => { try { return JSON.parse(a.default_processes || '[]'); } catch { return []; } })(),
        createdAt:        a.created_at,
        updatedAt:        a.updated_at,
      };
    }),
  });
});

/**
 * POST /api/agents
 * Create a new agent.
 */
router.post('/', (req, res) => {
  // Accept both defaultAbilities (new) and defaultProcesses (legacy)
  let { name, type, apiUrl, apiKey, avatarUrl, config: agentConfig, defaultAbilities, defaultProcesses } = req.body;
  let abilities = defaultAbilities || defaultProcesses || [];

  if (!name || !type)
    return res.status(400).json({ error: 'Name and type are required' });

  // Validate type
  let validTypes = ['claude', 'openai'];  // Will be expanded with agent registry

  if (!validTypes.includes(type))
    return res.status(400).json({ error: `Invalid agent type. Valid types: ${validTypes.join(', ')}` });

  // Validate defaultAbilities if provided
  if (!Array.isArray(abilities))
    return res.status(400).json({ error: 'defaultAbilities must be an array' });

  let db = getDatabase();

  // Check for duplicate name
  let existing = db.prepare('SELECT id FROM agents WHERE user_id = ? AND name = ?').get(req.user.id, name);

  if (existing)
    return res.status(409).json({ error: `Agent "${name}" already exists` });

  try {
    let dataKey = getDataKey(req);

    // Encrypt sensitive fields
    let encryptedApiKey = (apiKey) ? encryptWithKey(apiKey, dataKey) : null;
    let encryptedConfig = (agentConfig) ? encryptWithKey(JSON.stringify(agentConfig), dataKey) : null;
    let abilitiesJson   = JSON.stringify(abilities);

    let result = db.prepare(`
      INSERT INTO agents (user_id, name, type, api_url, avatar_url, encrypted_api_key, encrypted_config, default_processes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(req.user.id, name, type, apiUrl || null, avatarUrl || null, encryptedApiKey, encryptedConfig, abilitiesJson);

    let createdAgent = { name, avatar_url: avatarUrl || null };

    return res.status(201).json({
      id:               result.lastInsertRowid,
      name:             name,
      type:             type,
      apiUrl:           apiUrl || null,
      avatarUrl:        getAgentAvatar(createdAgent),
      defaultAbilities: abilities,
      createdAt:        new Date().toISOString(),
    });
  } catch (error) {
    console.error('Create agent error:', error);
    return res.status(500).json({ error: 'Failed to create agent' });
  }
});

/**
 * GET /api/agents/:id
 * Get a specific agent.
 */
router.get('/:id', (req, res) => {
  let db    = getDatabase();
  let agent = db.prepare(`
    SELECT id, name, type, api_url, avatar_url, encrypted_api_key, encrypted_config, default_processes, created_at, updated_at
    FROM agents
    WHERE id = ? AND user_id = ?
  `).get(req.params.id, req.user.id);

  if (!agent)
    return res.status(404).json({ error: 'Agent not found' });

  try {
    let dataKey = getDataKey(req);

    // Decrypt config (but not API key - never expose it)
    let agentConfig = null;

    if (agent.encrypted_config) {
      try {
        let decrypted = decryptWithKey(agent.encrypted_config, dataKey);
        agentConfig   = JSON.parse(decrypted);
      } catch (error) {
        console.error(`Failed to decrypt/parse agent config for agent ${agentId}:`, error.message);
      }
    }

    let agentAbilities = [];
    try {
      agentAbilities = JSON.parse(agent.default_processes || '[]');
    } catch (error) {
      console.error(`Failed to parse default_processes for agent ${agentId}:`, error.message);
    }

    return res.json({
      id:               agent.id,
      name:             agent.name,
      type:             agent.type,
      apiUrl:           agent.api_url,
      avatarUrl:        getAgentAvatar(agent),
      config:           agentConfig,
      defaultAbilities: agentAbilities,
      hasApiKey:        !!agent.encrypted_api_key,
      createdAt:        agent.created_at,
      updatedAt:        agent.updated_at,
    });
  } catch (error) {
    console.error('Get agent error:', error);
    return res.status(500).json({ error: 'Failed to get agent' });
  }
});

/**
 * PUT /api/agents/:id
 * Update an agent.
 */
router.put('/:id', (req, res) => {
  // Accept both defaultAbilities (new) and defaultProcesses (legacy)
  let { name, type, apiUrl, apiKey, avatarUrl, config: agentConfig, defaultAbilities, defaultProcesses } = req.body;
  let abilities = (defaultAbilities !== undefined) ? defaultAbilities : defaultProcesses;

  let db    = getDatabase();
  let agent = db.prepare('SELECT id FROM agents WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);

  if (!agent)
    return res.status(404).json({ error: 'Agent not found' });

  // Validate defaultAbilities if provided
  if (abilities !== undefined && !Array.isArray(abilities))
    return res.status(400).json({ error: 'defaultAbilities must be an array' });

  try {
    let dataKey = getDataKey(req);
    let updates = [];
    let values  = [];

    if (name !== undefined) {
      // Check for duplicate name (excluding current agent)
      let existing = db.prepare('SELECT id FROM agents WHERE user_id = ? AND name = ? AND id != ?').get(req.user.id, name, req.params.id);

      if (existing)
        return res.status(409).json({ error: `Agent "${name}" already exists` });

      updates.push('name = ?');
      values.push(name);
    }

    if (type !== undefined) {
      let validTypes = ['claude', 'openai'];

      if (!validTypes.includes(type))
        return res.status(400).json({ error: `Invalid agent type. Valid types: ${validTypes.join(', ')}` });

      updates.push('type = ?');
      values.push(type);
    }

    if (apiUrl !== undefined) {
      updates.push('api_url = ?');
      values.push(apiUrl || null);
    }

    if (apiKey !== undefined) {
      let encryptedApiKey = (apiKey) ? encryptWithKey(apiKey, dataKey) : null;
      updates.push('encrypted_api_key = ?');
      values.push(encryptedApiKey);
    }

    if (agentConfig !== undefined) {
      let encryptedConfig = (agentConfig) ? encryptWithKey(JSON.stringify(agentConfig), dataKey) : null;
      updates.push('encrypted_config = ?');
      values.push(encryptedConfig);
    }

    if (avatarUrl !== undefined) {
      updates.push('avatar_url = ?');
      values.push(avatarUrl || null);
    }

    if (abilities !== undefined) {
      updates.push('default_processes = ?');
      values.push(JSON.stringify(abilities));
    }

    if (updates.length === 0)
      return res.status(400).json({ error: 'No fields to update' });

    updates.push('updated_at = CURRENT_TIMESTAMP');
    values.push(req.params.id);
    values.push(req.user.id);

    db.prepare(`
      UPDATE agents
      SET ${updates.join(', ')}
      WHERE id = ? AND user_id = ?
    `).run(...values);

    return res.json({ success: true });
  } catch (error) {
    console.error('Update agent error:', error);
    return res.status(500).json({ error: 'Failed to update agent' });
  }
});

/**
 * DELETE /api/agents/:id
 * Delete an agent.
 */
router.delete('/:id', (req, res) => {
  let db     = getDatabase();
  let result = db.prepare('DELETE FROM agents WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);

  if (result.changes === 0)
    return res.status(404).json({ error: 'Agent not found' });

  return res.json({ success: true });
});

/**
 * GET /api/agents/:id/config
 * Get the decrypted config for an agent.
 */
router.get('/:id/config', (req, res) => {
  let db    = getDatabase();
  let agent = db.prepare(`
    SELECT encrypted_config
    FROM agents
    WHERE id = ? AND user_id = ?
  `).get(req.params.id, req.user.id);

  if (!agent)
    return res.status(404).json({ error: 'Agent not found' });

  try {
    let dataKey = getDataKey(req);
    let config  = {};

    if (agent.encrypted_config) {
      let decrypted = decryptWithKey(agent.encrypted_config, dataKey);
      config = JSON.parse(decrypted);
    }

    return res.json({ config });
  } catch (error) {
    console.error('Get agent config error:', error);
    return res.status(500).json({ error: 'Failed to get agent config' });
  }
});

/**
 * PUT /api/agents/:id/config
 * Update the config for an agent.
 */
router.put('/:id/config', (req, res) => {
  let { config } = req.body;

  if (config === undefined)
    return res.status(400).json({ error: 'Config is required' });

  // Validate config is an object
  if (typeof config !== 'object' || config === null || Array.isArray(config))
    return res.status(400).json({ error: 'Config must be a JSON object' });

  let db    = getDatabase();
  let agent = db.prepare('SELECT id FROM agents WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);

  if (!agent)
    return res.status(404).json({ error: 'Agent not found' });

  try {
    let dataKey         = getDataKey(req);
    let encryptedConfig = encryptWithKey(JSON.stringify(config), dataKey);

    db.prepare(`
      UPDATE agents
      SET encrypted_config = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND user_id = ?
    `).run(encryptedConfig, req.params.id, req.user.id);

    return res.json({ success: true });
  } catch (error) {
    console.error('Update agent config error:', error);
    return res.status(500).json({ error: 'Failed to update agent config' });
  }
});

export default router;
