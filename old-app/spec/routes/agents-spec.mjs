'use strict';

// ============================================================================
// Agents API Tests
// ============================================================================
// Tests for the agents REST API endpoints.
// Tests database operations directly using in-memory SQLite, mirroring
// the SQL queries and logic from server/routes/agents.mjs.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

// ============================================================================
// Test Database Setup
// ============================================================================

let db = null;

function createTestDatabase() {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE agents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'claude',
      api_url TEXT,
      encrypted_api_key TEXT,
      encrypted_config TEXT,
      default_processes TEXT DEFAULT '[]',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, name)
    );

    CREATE TABLE sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Create test users
  db.prepare("INSERT INTO users (id, username) VALUES (1, 'testuser')").run();
  db.prepare("INSERT INTO users (id, username) VALUES (2, 'otheruser')").run();

  // Create test agents for user 1
  db.prepare(`
    INSERT INTO agents (id, user_id, name, type, api_url, encrypted_api_key, encrypted_config, default_processes)
    VALUES (1, 1, 'Alpha Agent', 'claude', 'https://api.anthropic.com', 'enc-key-1', '{"model":"claude-3"}', '["search","code"]')
  `).run();

  db.prepare(`
    INSERT INTO agents (id, user_id, name, type, api_url, encrypted_api_key, encrypted_config, default_processes)
    VALUES (2, 1, 'Beta Agent', 'openai', NULL, NULL, NULL, '[]')
  `).run();

  // Create test agent for user 2 (isolation testing)
  db.prepare(`
    INSERT INTO agents (id, user_id, name, type, default_processes)
    VALUES (3, 2, 'Other Agent', 'claude', '[]')
  `).run();

  return db;
}

// ============================================================================
// Helper Functions
// ============================================================================
// These mirror the logic in server/routes/agents.mjs, operating directly
// on the database instead of going through HTTP + middleware.

const VALID_TYPES = ['claude', 'openai'];

function listAgents(userId) {
  let agents = db.prepare(`
    SELECT id, name, type, api_url, encrypted_config, default_processes, created_at, updated_at
    FROM agents
    WHERE user_id = ?
    ORDER BY name
  `).all(userId);

  return agents.map((agent) => {
    let config = {};
    if (agent.encrypted_config) {
      try {
        config = JSON.parse(agent.encrypted_config);
      } catch (error) {
        // Ignore parse errors
      }
    }

    return {
      id:               agent.id,
      name:             agent.name,
      type:             agent.type,
      apiUrl:           agent.api_url,
      config:           config,
      defaultAbilities: (() => { try { return JSON.parse(agent.default_processes || '[]'); } catch { return []; } })(),
      createdAt:        agent.created_at,
      updatedAt:        agent.updated_at,
    };
  });
}

function createAgent(userId, { name, type, apiUrl, apiKey, config: agentConfig, defaultAbilities, defaultProcesses }) {
  let abilities = defaultAbilities || defaultProcesses || [];

  if (!name || !type)
    return { status: 400, body: { error: 'Name and type are required' } };

  if (!VALID_TYPES.includes(type))
    return { status: 400, body: { error: `Invalid agent type. Valid types: ${VALID_TYPES.join(', ')}` } };

  if (!Array.isArray(abilities))
    return { status: 400, body: { error: 'defaultAbilities must be an array' } };

  let existing = db.prepare('SELECT id FROM agents WHERE user_id = ? AND name = ?').get(userId, name);
  if (existing)
    return { status: 409, body: { error: `Agent "${name}" already exists` } };

  let encryptedApiKey = apiKey || null;
  let encryptedConfig = agentConfig ? JSON.stringify(agentConfig) : null;
  let abilitiesJson = JSON.stringify(abilities);

  let result = db.prepare(`
    INSERT INTO agents (user_id, name, type, api_url, encrypted_api_key, encrypted_config, default_processes)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(userId, name, type, apiUrl || null, encryptedApiKey, encryptedConfig, abilitiesJson);

  return {
    status: 201,
    body: {
      id:               result.lastInsertRowid,
      name:             name,
      type:             type,
      apiUrl:           apiUrl || null,
      defaultAbilities: abilities,
    },
  };
}

function getAgent(userId, agentId) {
  let agent = db.prepare(`
    SELECT id, name, type, api_url, encrypted_api_key, encrypted_config, default_processes, created_at, updated_at
    FROM agents
    WHERE id = ? AND user_id = ?
  `).get(agentId, userId);

  if (!agent)
    return { status: 404, body: { error: 'Agent not found' } };

  let agentConfig = null;
  if (agent.encrypted_config) {
    try {
      agentConfig = JSON.parse(agent.encrypted_config);
    } catch (error) {
      // Ignore parse errors
    }
  }

  let agentAbilities = [];
  try {
    agentAbilities = JSON.parse(agent.default_processes || '[]');
  } catch (error) {
    // Ignore parse errors
  }

  return {
    status: 200,
    body: {
      id:               agent.id,
      name:             agent.name,
      type:             agent.type,
      apiUrl:           agent.api_url,
      config:           agentConfig,
      defaultAbilities: agentAbilities,
      hasApiKey:        !!agent.encrypted_api_key,
      createdAt:        agent.created_at,
      updatedAt:        agent.updated_at,
    },
  };
}

function updateAgent(userId, agentId, { name, type, apiUrl, apiKey, config: agentConfig, defaultAbilities, defaultProcesses }) {
  let abilities = (defaultAbilities !== undefined) ? defaultAbilities : defaultProcesses;

  let agent = db.prepare('SELECT id FROM agents WHERE id = ? AND user_id = ?').get(agentId, userId);
  if (!agent)
    return { status: 404, body: { error: 'Agent not found' } };

  if (abilities !== undefined && !Array.isArray(abilities))
    return { status: 400, body: { error: 'defaultAbilities must be an array' } };

  let updates = [];
  let values = [];

  if (name !== undefined) {
    let existing = db.prepare('SELECT id FROM agents WHERE user_id = ? AND name = ? AND id != ?').get(userId, name, agentId);
    if (existing)
      return { status: 409, body: { error: `Agent "${name}" already exists` } };

    updates.push('name = ?');
    values.push(name);
  }

  if (type !== undefined) {
    if (!VALID_TYPES.includes(type))
      return { status: 400, body: { error: `Invalid agent type. Valid types: ${VALID_TYPES.join(', ')}` } };

    updates.push('type = ?');
    values.push(type);
  }

  if (apiUrl !== undefined) {
    updates.push('api_url = ?');
    values.push(apiUrl || null);
  }

  if (apiKey !== undefined) {
    let encryptedApiKey = apiKey || null;
    updates.push('encrypted_api_key = ?');
    values.push(encryptedApiKey);
  }

  if (agentConfig !== undefined) {
    let encryptedConfig = agentConfig ? JSON.stringify(agentConfig) : null;
    updates.push('encrypted_config = ?');
    values.push(encryptedConfig);
  }

  if (abilities !== undefined) {
    updates.push('default_processes = ?');
    values.push(JSON.stringify(abilities));
  }

  if (updates.length === 0)
    return { status: 400, body: { error: 'No fields to update' } };

  updates.push('updated_at = CURRENT_TIMESTAMP');
  values.push(agentId);
  values.push(userId);

  db.prepare(`
    UPDATE agents
    SET ${updates.join(', ')}
    WHERE id = ? AND user_id = ?
  `).run(...values);

  return { status: 200, body: { success: true } };
}

function deleteAgent(userId, agentId) {
  let result = db.prepare('DELETE FROM agents WHERE id = ? AND user_id = ?').run(agentId, userId);

  if (result.changes === 0)
    return { status: 404, body: { error: 'Agent not found' } };

  return { status: 200, body: { success: true } };
}

function getAgentConfig(userId, agentId) {
  let agent = db.prepare(`
    SELECT encrypted_config
    FROM agents
    WHERE id = ? AND user_id = ?
  `).get(agentId, userId);

  if (!agent)
    return { status: 404, body: { error: 'Agent not found' } };

  let config = {};
  if (agent.encrypted_config) {
    config = JSON.parse(agent.encrypted_config);
  }

  return { status: 200, body: { config } };
}

function updateAgentConfig(userId, agentId, config) {
  if (config === undefined)
    return { status: 400, body: { error: 'Config is required' } };

  if (typeof config !== 'object' || config === null || Array.isArray(config))
    return { status: 400, body: { error: 'Config must be a JSON object' } };

  let agent = db.prepare('SELECT id FROM agents WHERE id = ? AND user_id = ?').get(agentId, userId);
  if (!agent)
    return { status: 404, body: { error: 'Agent not found' } };

  let encryptedConfig = JSON.stringify(config);

  db.prepare(`
    UPDATE agents
    SET encrypted_config = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND user_id = ?
  `).run(encryptedConfig, agentId, userId);

  return { status: 200, body: { success: true } };
}

// ============================================================================
// Tests
// ============================================================================

describe('Agents API (Database Operations)', () => {
  beforeEach(() => {
    createTestDatabase();
  });

  afterEach(() => {
    if (db) {
      db.close();
      db = null;
    }
  });

  // --------------------------------------------------------------------------
  // List Agents (GET /)
  // --------------------------------------------------------------------------

  describe('List Agents (GET /)', () => {
    it('should return all agents for a user', () => {
      let agents = listAgents(1);
      assert.equal(agents.length, 2);
    });

    it('should return empty array for user with no agents', () => {
      // User 2 has one agent; create a user with none
      db.prepare("INSERT INTO users (id, username) VALUES (99, 'emptyuser')").run();
      let agents = listAgents(99);
      assert.deepEqual(agents, []);
    });

    it('should include agent fields (id, name, type, apiUrl)', () => {
      let agents = listAgents(1);
      let alpha = agents.find((a) => a.name === 'Alpha Agent');

      assert.equal(alpha.id, 1);
      assert.equal(alpha.name, 'Alpha Agent');
      assert.equal(alpha.type, 'claude');
      assert.equal(alpha.apiUrl, 'https://api.anthropic.com');
      assert.ok(alpha.createdAt);
      assert.ok(alpha.updatedAt);
    });

    it('should parse default_processes JSON into defaultAbilities array', () => {
      let agents = listAgents(1);
      let alpha = agents.find((a) => a.name === 'Alpha Agent');

      assert.deepEqual(alpha.defaultAbilities, ['search', 'code']);
    });

    it('should handle malformed default_processes gracefully', () => {
      db.prepare("UPDATE agents SET default_processes = 'not-json' WHERE id = 1").run();

      let agents = listAgents(1);
      let alpha = agents.find((a) => a.name === 'Alpha Agent');

      assert.deepEqual(alpha.defaultAbilities, []);
    });

    it('should only return agents for the requesting user (isolation)', () => {
      let user1Agents = listAgents(1);
      let user2Agents = listAgents(2);

      assert.equal(user1Agents.length, 2);
      assert.equal(user2Agents.length, 1);

      let user1Names = user1Agents.map((a) => a.name);
      assert.ok(!user1Names.includes('Other Agent'));

      assert.equal(user2Agents[0].name, 'Other Agent');
    });

    it('should order agents by name', () => {
      let agents = listAgents(1);

      assert.equal(agents[0].name, 'Alpha Agent');
      assert.equal(agents[1].name, 'Beta Agent');
    });
  });

  // --------------------------------------------------------------------------
  // Create Agent (POST /)
  // --------------------------------------------------------------------------

  describe('Create Agent (POST /)', () => {
    it('should create an agent with name and type', () => {
      let result = createAgent(1, { name: 'test-new-agent', type: 'claude' });

      assert.equal(result.status, 201);
      assert.equal(result.body.name, 'test-new-agent');
      assert.equal(result.body.type, 'claude');

      // Verify in database
      let row = db.prepare('SELECT * FROM agents WHERE name = ?').get('test-new-agent');
      assert.ok(row);
      assert.equal(row.user_id, 1);
    });

    it('should return 400 if name missing', () => {
      let result = createAgent(1, { type: 'claude' });
      assert.equal(result.status, 400);
      assert.match(result.body.error, /Name and type are required/);
    });

    it('should return 400 if type missing', () => {
      let result = createAgent(1, { name: 'test-no-type' });
      assert.equal(result.status, 400);
      assert.match(result.body.error, /Name and type are required/);
    });

    it('should return 400 for invalid type (not claude or openai)', () => {
      let result = createAgent(1, { name: 'test-bad-type', type: 'gemini' });
      assert.equal(result.status, 400);
      assert.match(result.body.error, /Invalid agent type/);
    });

    it('should return 409 for duplicate agent name', () => {
      let result = createAgent(1, { name: 'Alpha Agent', type: 'claude' });
      assert.equal(result.status, 409);
      assert.match(result.body.error, /already exists/);
    });

    it('should store default_processes as JSON', () => {
      let result = createAgent(1, {
        name: 'test-abilities',
        type: 'claude',
        defaultAbilities: ['search', 'calculator'],
      });

      assert.equal(result.status, 201);
      assert.deepEqual(result.body.defaultAbilities, ['search', 'calculator']);

      let row = db.prepare('SELECT default_processes FROM agents WHERE id = ?').get(result.body.id);
      assert.equal(row.default_processes, '["search","calculator"]');
    });

    it('should support apiUrl', () => {
      let result = createAgent(1, {
        name: 'test-url-agent',
        type: 'openai',
        apiUrl: 'https://custom.endpoint.com/v1',
      });

      assert.equal(result.status, 201);
      assert.equal(result.body.apiUrl, 'https://custom.endpoint.com/v1');

      let row = db.prepare('SELECT api_url FROM agents WHERE id = ?').get(result.body.id);
      assert.equal(row.api_url, 'https://custom.endpoint.com/v1');
    });

    it('should return created agent with id', () => {
      let result = createAgent(1, { name: 'test-with-id', type: 'claude' });

      assert.equal(result.status, 201);
      assert.ok(typeof result.body.id === 'number');
      assert.ok(result.body.id > 0);
    });
  });

  // --------------------------------------------------------------------------
  // Get Agent (GET /:id)
  // --------------------------------------------------------------------------

  describe('Get Agent (GET /:id)', () => {
    it('should return agent with all fields', () => {
      let result = getAgent(1, 1);

      assert.equal(result.status, 200);
      assert.equal(result.body.id, 1);
      assert.equal(result.body.name, 'Alpha Agent');
      assert.equal(result.body.type, 'claude');
      assert.equal(result.body.apiUrl, 'https://api.anthropic.com');
      assert.ok(result.body.createdAt);
      assert.ok(result.body.updatedAt);
      assert.deepEqual(result.body.defaultAbilities, ['search', 'code']);
    });

    it('should return hasApiKey boolean (true when key exists)', () => {
      let withKey = getAgent(1, 1);
      assert.equal(withKey.body.hasApiKey, true);

      let withoutKey = getAgent(1, 2);
      assert.equal(withoutKey.body.hasApiKey, false);
    });

    it('should return 404 for non-existent agent', () => {
      let result = getAgent(1, 9999);
      assert.equal(result.status, 404);
      assert.match(result.body.error, /Agent not found/);
    });

    it('should return 404 for agent belonging to different user', () => {
      // Agent 3 belongs to user 2; request as user 1
      let result = getAgent(1, 3);
      assert.equal(result.status, 404);
      assert.match(result.body.error, /Agent not found/);
    });
  });

  // --------------------------------------------------------------------------
  // Update Agent (PUT /:id)
  // --------------------------------------------------------------------------

  describe('Update Agent (PUT /:id)', () => {
    it('should update agent name', () => {
      let result = updateAgent(1, 1, { name: 'Renamed Agent' });
      assert.equal(result.status, 200);
      assert.equal(result.body.success, true);

      let row = db.prepare('SELECT name FROM agents WHERE id = 1').get();
      assert.equal(row.name, 'Renamed Agent');
    });

    it('should update agent type', () => {
      let result = updateAgent(1, 1, { type: 'openai' });
      assert.equal(result.status, 200);

      let row = db.prepare('SELECT type FROM agents WHERE id = 1').get();
      assert.equal(row.type, 'openai');
    });

    it('should validate type on update', () => {
      let result = updateAgent(1, 1, { type: 'gemini' });
      assert.equal(result.status, 400);
      assert.match(result.body.error, /Invalid agent type/);
    });

    it('should return 409 for duplicate name on update (excluding self)', () => {
      // Try to rename agent 1 to "Beta Agent" which is agent 2's name
      let result = updateAgent(1, 1, { name: 'Beta Agent' });
      assert.equal(result.status, 409);
      assert.match(result.body.error, /already exists/);
    });

    it('should allow updating name to same name (self-exclusion)', () => {
      let result = updateAgent(1, 1, { name: 'Alpha Agent' });
      assert.equal(result.status, 200);
      assert.equal(result.body.success, true);
    });

    it('should update apiUrl', () => {
      let result = updateAgent(1, 1, { apiUrl: 'https://new.api.com' });
      assert.equal(result.status, 200);

      let row = db.prepare('SELECT api_url FROM agents WHERE id = 1').get();
      assert.equal(row.api_url, 'https://new.api.com');
    });

    it('should update encrypted_api_key', () => {
      let result = updateAgent(1, 2, { apiKey: 'sk-new-key-123' });
      assert.equal(result.status, 200);

      let row = db.prepare('SELECT encrypted_api_key FROM agents WHERE id = 2').get();
      assert.equal(row.encrypted_api_key, 'sk-new-key-123');
    });

    it('should update encrypted_config', () => {
      let result = updateAgent(1, 1, { config: { model: 'claude-4', temperature: 0.7 } });
      assert.equal(result.status, 200);

      let row = db.prepare('SELECT encrypted_config FROM agents WHERE id = 1').get();
      let parsed = JSON.parse(row.encrypted_config);
      assert.equal(parsed.model, 'claude-4');
      assert.equal(parsed.temperature, 0.7);
    });

    it('should update default_processes', () => {
      let result = updateAgent(1, 1, { defaultAbilities: ['websearch', 'calculator', 'code'] });
      assert.equal(result.status, 200);

      let row = db.prepare('SELECT default_processes FROM agents WHERE id = 1').get();
      let parsed = JSON.parse(row.default_processes);
      assert.deepEqual(parsed, ['websearch', 'calculator', 'code']);
    });

    it('should return 400 with no fields', () => {
      let result = updateAgent(1, 1, {});
      assert.equal(result.status, 400);
      assert.match(result.body.error, /No fields to update/);
    });

    it('should return 404 for non-existent agent', () => {
      let result = updateAgent(1, 9999, { name: 'Ghost' });
      assert.equal(result.status, 404);
      assert.match(result.body.error, /Agent not found/);
    });

    it('should accept both defaultAbilities and defaultProcesses (legacy compat)', () => {
      // Test defaultAbilities
      let result1 = updateAgent(1, 1, { defaultAbilities: ['ability-a'] });
      assert.equal(result1.status, 200);

      let row1 = db.prepare('SELECT default_processes FROM agents WHERE id = 1').get();
      assert.deepEqual(JSON.parse(row1.default_processes), ['ability-a']);

      // Test defaultProcesses (legacy)
      let result2 = updateAgent(1, 1, { defaultProcesses: ['process-b'] });
      assert.equal(result2.status, 200);

      let row2 = db.prepare('SELECT default_processes FROM agents WHERE id = 1').get();
      assert.deepEqual(JSON.parse(row2.default_processes), ['process-b']);
    });

    it('should prefer defaultAbilities over defaultProcesses when both provided', () => {
      let result = updateAgent(1, 1, {
        defaultAbilities: ['from-abilities'],
        defaultProcesses: ['from-processes'],
      });
      assert.equal(result.status, 200);

      let row = db.prepare('SELECT default_processes FROM agents WHERE id = 1').get();
      assert.deepEqual(JSON.parse(row.default_processes), ['from-abilities']);
    });
  });

  // --------------------------------------------------------------------------
  // Delete Agent (DELETE /:id)
  // --------------------------------------------------------------------------

  describe('Delete Agent (DELETE /:id)', () => {
    it('should delete an agent', () => {
      let result = deleteAgent(1, 2);
      assert.equal(result.status, 200);
      assert.equal(result.body.success, true);

      let row = db.prepare('SELECT id FROM agents WHERE id = 2').get();
      assert.equal(row, undefined);
    });

    it('should return 404 for non-existent agent', () => {
      let result = deleteAgent(1, 9999);
      assert.equal(result.status, 404);
      assert.match(result.body.error, /Agent not found/);
    });

    it('should cascade to sessions (FK enabled)', () => {
      // Create a session referencing agent 1
      db.prepare(`
        INSERT INTO sessions (id, user_id, agent_id, name)
        VALUES (10, 1, 1, 'Test Session for Cascade')
      `).run();

      let sessionBefore = db.prepare('SELECT id FROM sessions WHERE id = 10').get();
      assert.ok(sessionBefore);

      deleteAgent(1, 1);

      let sessionAfter = db.prepare('SELECT id FROM sessions WHERE id = 10').get();
      assert.equal(sessionAfter, undefined);
    });
  });

  // --------------------------------------------------------------------------
  // Agent Config (GET/PUT /:id/config)
  // --------------------------------------------------------------------------

  describe('Agent Config', () => {
    it('should get config for an agent', () => {
      let result = getAgentConfig(1, 1);
      assert.equal(result.status, 200);

      // Agent 1 has encrypted_config = '{"model":"claude-3"}'
      assert.deepEqual(result.body.config, { model: 'claude-3' });
    });

    it('should return empty object if no config', () => {
      let result = getAgentConfig(1, 2);
      assert.equal(result.status, 200);
      assert.deepEqual(result.body.config, {});
    });

    it('should return 404 for non-existent agent (get config)', () => {
      let result = getAgentConfig(1, 9999);
      assert.equal(result.status, 404);
      assert.match(result.body.error, /Agent not found/);
    });

    it('should update config for an agent', () => {
      let result = updateAgentConfig(1, 1, { model: 'claude-4', maxTokens: 4096 });
      assert.equal(result.status, 200);
      assert.equal(result.body.success, true);

      // Verify the config was persisted
      let fetched = getAgentConfig(1, 1);
      assert.deepEqual(fetched.body.config, { model: 'claude-4', maxTokens: 4096 });
    });

    it('should return 400 if config not object', () => {
      let result = updateAgentConfig(1, 1, 'not-an-object');
      assert.equal(result.status, 400);
      assert.match(result.body.error, /Config must be a JSON object/);
    });

    it('should return 400 for array config', () => {
      let result = updateAgentConfig(1, 1, ['not', 'valid']);
      assert.equal(result.status, 400);
      assert.match(result.body.error, /Config must be a JSON object/);
    });

    it('should return 400 for null config', () => {
      let result = updateAgentConfig(1, 1, null);
      assert.equal(result.status, 400);
      assert.match(result.body.error, /Config must be a JSON object/);
    });

    it('should return 404 for non-existent agent (update config)', () => {
      let result = updateAgentConfig(1, 9999, { model: 'ghost' });
      assert.equal(result.status, 404);
      assert.match(result.body.error, /Agent not found/);
    });
  });
});
