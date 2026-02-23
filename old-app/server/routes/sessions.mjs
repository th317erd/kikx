'use strict';

import { Router } from 'express';
import { getDatabase } from '../database.mjs';
import { requireAuth } from '../middleware/auth.mjs';
import {
  loadSessionWithAgent,
  createSessionWithParticipants,
  getSessionParticipants,
  addParticipant,
  removeParticipant,
} from '../lib/participants/index.mjs';
import { getAgentAvatar } from '../lib/avatars.mjs';

const router = Router();

// All routes require authentication
router.use(requireAuth);

/**
 * GET /api/sessions
 * List all sessions for the current user.
 * Always returns ALL sessions (including archived) - frontend handles filtering.
 *
 * Query params:
 *   - search: search term to filter by session name or message content
 */
router.get('/', (req, res) => {
  let db          = getDatabase();
  let searchQuery = req.query.search?.trim() || '';

  let params = [req.user.id];
  let whereClause = 's.user_id = ?';

  // Search filter
  if (searchQuery) {
    whereClause += ` AND (
      s.name LIKE ?
      OR EXISTS (
        SELECT 1 FROM frames f
        WHERE f.session_id = s.id AND f.type = 'message' AND f.payload LIKE ?
      )
    )`;
    let searchPattern = `%${searchQuery}%`;
    params.push(searchPattern, searchPattern);
  }

  let sessions = db.prepare(`
    SELECT
      s.id,
      s.name,
      s.system_prompt,
      s.status,
      s.agent_id,
      s.parent_session_id,
      s.created_at,
      s.updated_at,
      (SELECT COUNT(*) FROM frames WHERE session_id = s.id AND type = 'message') as message_count,
      (SELECT payload FROM frames WHERE session_id = s.id AND type = 'message' ORDER BY timestamp DESC LIMIT 1) as last_message
    FROM sessions s
    WHERE ${whereClause}
    ORDER BY s.updated_at DESC
  `).all(...params);

  // Build hierarchy: group child sessions under their parents
  let sessionMap = new Map();
  let rootSessions = [];
  let childSessions = new Map(); // parentId -> [children]

  // First pass: build lookup maps
  for (let s of sessions) {
    sessionMap.set(s.id, s);
    if (s.parent_session_id) {
      if (!childSessions.has(s.parent_session_id))
        childSessions.set(s.parent_session_id, []);
      childSessions.get(s.parent_session_id).push(s);
    } else {
      rootSessions.push(s);
    }
  }

  // Second pass: build ordered list with children following parents
  let orderedSessions = [];

  function addWithChildren(session, depth = 0) {
    session._depth = depth;
    orderedSessions.push(session);

    let children = childSessions.get(session.id) || [];
    // Sort children by updated_at descending
    children.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));

    for (let child of children)
      addWithChildren(child, depth + 1);
  }

  for (let root of rootSessions)
    addWithChildren(root);

  return res.json({
    sessions: orderedSessions.map((s) => {
      // Parse last message to get preview
      let preview = '';
      if (s.last_message) {
        try {
          let content = JSON.parse(s.last_message);
          if (typeof content === 'string') {
            preview = content.substring(0, 100);
          } else if (Array.isArray(content)) {
            let textBlock = content.find((b) => b.type === 'text');
            if (textBlock)
              preview = textBlock.text.substring(0, 100);
          }
        } catch (e) {
          preview = '';
        }
      }

      // Load participants for this session
      let participants = getSessionParticipants(s.id, db);
      let coordinatorParticipant = participants.find((p) => p.participantType === 'agent' && p.role === 'coordinator');
      let agentInfo = null;

      if (coordinatorParticipant) {
        let agent = db.prepare('SELECT id, name, type, avatar_url FROM agents WHERE id = ?').get(coordinatorParticipant.participantId);
        if (agent)
          agentInfo = { id: agent.id, name: agent.name, type: agent.type, avatarUrl: getAgentAvatar(agent) };
      }

      // Fall back to legacy agent_id if no participants
      if (!agentInfo && s.agent_id) {
        let agent = db.prepare('SELECT id, name, type, avatar_url FROM agents WHERE id = ?').get(s.agent_id);
        if (agent)
          agentInfo = { id: agent.id, name: agent.name, type: agent.type, avatarUrl: getAgentAvatar(agent) };
      }

      return {
        id:              s.id,
        name:            s.name,
        systemPrompt:    s.system_prompt,
        status:          s.status,
        parentSessionId: s.parent_session_id,
        depth:           s._depth || 0,
        // Legacy support
        archived:        s.status === 'archived',
        agent:           agentInfo || { id: null, name: null, type: null, avatarUrl: null },
        participants:    participants.map((p) => ({
          id:              p.id,
          participantType: p.participantType,
          participantId:   p.participantId,
          role:            p.role,
          alias:           p.alias,
        })),
        messageCount: s.message_count,
        preview:      preview,
        createdAt:    s.created_at,
        updatedAt:    s.updated_at,
      };
    }),
  });
});

/**
 * POST /api/sessions
 * Create a new session.
 *
 * Accepts either:
 *   - agentId: single agent (backwards compatible)
 *   - agentIds: array of agents (first is coordinator, rest are members)
 */
router.post('/', (req, res) => {
  let { name, agentId, agentIds, systemPrompt, status, parentSessionId } = req.body;

  // Normalize to agentIds array
  let resolvedAgentIds = agentIds || (agentId ? [agentId] : []);

  if (!name || resolvedAgentIds.length === 0)
    return res.status(400).json({ error: 'Name and at least one agentId are required' });

  let db = getDatabase();

  // Verify all agents exist and belong to user
  let agents = [];
  for (let id of resolvedAgentIds) {
    let agent = db.prepare('SELECT id, name, type, avatar_url FROM agents WHERE id = ? AND user_id = ?').get(id, req.user.id);
    if (!agent)
      return res.status(404).json({ error: `Agent ${id} not found` });
    agents.push(agent);
  }

  // Verify parent session exists if provided
  if (parentSessionId) {
    let parent = db.prepare('SELECT id FROM sessions WHERE id = ? AND user_id = ?').get(parentSessionId, req.user.id);
    if (!parent)
      return res.status(404).json({ error: 'Parent session not found' });
  }

  try {
    let session = createSessionWithParticipants({
      userId:          req.user.id,
      name,
      agentIds:        resolvedAgentIds,
      systemPrompt,
      status,
      parentSessionId,
    }, db);

    let primaryAgent = agents[0];

    return res.status(201).json({
      id:              session.id,
      name:            name,
      systemPrompt:    systemPrompt || null,
      status:          status || null,
      parentSessionId: parentSessionId || null,
      depth:           0,
      archived:        status === 'archived',
      agent:           {
        id:   primaryAgent.id,
        name: primaryAgent.name,
        type: primaryAgent.type,
      },
      participants:    session.participants.map((p) => ({
        id:              p.id,
        participantType: p.participantType,
        participantId:   p.participantId,
        role:            p.role,
        alias:           p.alias,
      })),
      messageCount: 0,
      createdAt:    new Date().toISOString(),
      updatedAt:    new Date().toISOString(),
    });
  } catch (error) {
    console.error('Create session error:', error);

    // Handle duplicate session name
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE')
      return res.status(409).json({ error: 'A session with this name already exists' });

    return res.status(500).json({ error: 'Failed to create session' });
  }
});

/**
 * GET /api/sessions/:id
 * Get a specific session with messages.
 */
router.get('/:id', (req, res) => {
  let db      = getDatabase();
  let session = loadSessionWithAgent(parseInt(req.params.id, 10), req.user.id, db);

  if (!session)
    return res.status(404).json({ error: 'Session not found' });

  // Get message frames for backward compatibility
  let frames = db.prepare(`
    SELECT id, type, author_type, payload, timestamp
    FROM frames
    WHERE session_id = ? AND type = 'message'
    ORDER BY timestamp ASC
  `).all(req.params.id);

  // Convert frames to legacy message format
  let messages = frames.map((f) => {
    let payload = JSON.parse(f.payload);
    let role = payload.role || ((f.author_type === 'agent') ? 'assistant' : 'user');
    return {
      id:        f.id,
      role:      role,
      content:   payload.content,
      hidden:    !!payload.hidden,
      type:      f.type,
      createdAt: f.timestamp,
      updatedAt: f.timestamp,
    };
  });

  // Load participants with enriched names/avatars
  let participants = getSessionParticipants(session.id, db);

  let enrichedParticipants = participants.map((p) => {
    let info = { name: null, avatarUrl: null };

    if (p.participantType === 'agent') {
      let agent = db.prepare('SELECT name, type, avatar_url FROM agents WHERE id = ?').get(p.participantId);
      if (agent) {
        info.name      = agent.name;
        info.type      = agent.type;
        info.avatarUrl = getAgentAvatar(agent);
      }
    } else {
      let user = db.prepare('SELECT username, display_name FROM users WHERE id = ?').get(p.participantId);
      if (user)
        info.name = user.display_name || user.username;
    }

    return {
      id:              p.id,
      participantType: p.participantType,
      participantId:   p.participantId,
      role:            p.role,
      alias:           p.alias,
      name:            info.name,
      type:            info.type || null,
      avatarUrl:       info.avatarUrl,
    };
  });

  return res.json({
    id:              session.id,
    name:            session.session_name,
    systemPrompt:    session.system_prompt,
    status:          session.status,
    parentSessionId: session.parent_session_id,
    archived:        session.status === 'archived',
    agent:           {
      id:        session.agent_id,
      name:      session.agent_name,
      type:      session.agent_type,
      avatarUrl: getAgentAvatar({ name: session.agent_name, avatar_url: session.agent_avatar_url }),
    },
    participants: enrichedParticipants,
    cost: {
      inputTokens:  session.input_tokens || 0,
      outputTokens: session.output_tokens || 0,
    },
    messages:  messages,
    createdAt: session.created_at,
    updatedAt: session.updated_at,
  });
});

/**
 * PUT /api/sessions/:id
 * Update a session.
 */
router.put('/:id', (req, res) => {
  let { name, systemPrompt, agentId } = req.body;

  let db      = getDatabase();
  let session = db.prepare('SELECT id FROM sessions WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);

  if (!session)
    return res.status(404).json({ error: 'Session not found' });

  let updates = [];
  let values  = [];

  if (name !== undefined) {
    updates.push('name = ?');
    values.push(name);
  }

  if (systemPrompt !== undefined) {
    updates.push('system_prompt = ?');
    values.push(systemPrompt || null);
  }

  if (agentId !== undefined) {
    // Verify agent exists and belongs to user
    let agent = db.prepare('SELECT id FROM agents WHERE id = ? AND user_id = ?').get(agentId, req.user.id);

    if (!agent)
      return res.status(404).json({ error: 'Agent not found' });

    updates.push('agent_id = ?');
    values.push(agentId);
  }

  if (updates.length === 0)
    return res.status(400).json({ error: 'No fields to update' });

  updates.push('updated_at = CURRENT_TIMESTAMP');
  values.push(req.params.id);
  values.push(req.user.id);

  db.prepare(`
    UPDATE sessions
    SET ${updates.join(', ')}
    WHERE id = ? AND user_id = ?
  `).run(...values);

  return res.json({ success: true });
});

/**
 * DELETE /api/sessions/:id
 * Delete a session and all its messages.
 */
router.delete('/:id', (req, res) => {
  let db     = getDatabase();
  let result = db.prepare('DELETE FROM sessions WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);

  if (result.changes === 0)
    return res.status(404).json({ error: 'Session not found' });

  return res.json({ success: true });
});

/**
 * POST /api/sessions/:id/archive
 * Archive a session (soft delete).
 */
router.post('/:id/archive', (req, res) => {
  let db      = getDatabase();
  let session = db.prepare('SELECT id, status FROM sessions WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);

  if (!session)
    return res.status(404).json({ error: 'Session not found' });

  db.prepare(`
    UPDATE sessions
    SET status = 'archived', updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND user_id = ?
  `).run(req.params.id, req.user.id);

  return res.json({ success: true, status: 'archived', archived: true });
});

/**
 * POST /api/sessions/:id/unarchive
 * Unarchive a session (restore to normal).
 */
router.post('/:id/unarchive', (req, res) => {
  let db      = getDatabase();
  let session = db.prepare('SELECT id, status FROM sessions WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);

  if (!session)
    return res.status(404).json({ error: 'Session not found' });

  db.prepare(`
    UPDATE sessions
    SET status = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND user_id = ?
  `).run(req.params.id, req.user.id);

  return res.json({ success: true, status: null, archived: false });
});

/**
 * PUT /api/sessions/:id/status
 * Update session status.
 */
router.put('/:id/status', (req, res) => {
  let { status } = req.body;

  let db      = getDatabase();
  let session = db.prepare('SELECT id FROM sessions WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);

  if (!session)
    return res.status(404).json({ error: 'Session not found' });

  db.prepare(`
    UPDATE sessions
    SET status = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND user_id = ?
  `).run(status || null, req.params.id, req.user.id);

  return res.json({ success: true, status: status || null });
});

/**
 * POST /api/sessions/:id/participants
 * Add a participant to a session.
 */
router.post('/:id/participants', (req, res) => {
  let { participantType, participantId, role } = req.body;

  if (!participantType || !participantId)
    return res.status(400).json({ error: 'participantType and participantId are required' });

  let db      = getDatabase();
  let session = db.prepare('SELECT id FROM sessions WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);

  if (!session)
    return res.status(404).json({ error: 'Session not found' });

  try {
    let participant = addParticipant(
      parseInt(req.params.id, 10),
      participantType,
      participantId,
      role || 'member',
      db
    );

    return res.status(201).json({ participant });
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE')
      return res.status(409).json({ error: 'Participant already exists in this session' });

    return res.status(500).json({ error: 'Failed to add participant' });
  }
});

/**
 * DELETE /api/sessions/:id/participants/:participantType/:participantId
 * Remove a participant from a session.
 */
router.delete('/:id/participants/:participantType/:participantId', (req, res) => {
  let db      = getDatabase();
  let session = db.prepare('SELECT id FROM sessions WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);

  if (!session)
    return res.status(404).json({ error: 'Session not found' });

  let removed = removeParticipant(
    parseInt(req.params.id, 10),
    req.params.participantType,
    parseInt(req.params.participantId, 10),
    db
  );

  if (!removed)
    return res.status(404).json({ error: 'Participant not found' });

  return res.json({ success: true });
});

export default router;
