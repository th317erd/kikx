'use strict';

import { getDatabase } from '../../database.mjs';
import { decryptWithKey } from '../../encryption.mjs';
import { loadSessionWithAgent, getSessionParticipants } from '../participants/index.mjs';

/**
 * Build a rich context object for pipeline execution.
 *
 * This context is passed to ALL handlers, plugins, and assertions.
 * It contains user, session, agent, and model information.
 *
 * @param {object} options - Context building options
 * @param {object} options.req - Express request object (with user attached)
 * @param {string} options.sessionId - Current session ID
 * @param {string} options.dataKey - User's data encryption key
 * @param {string} [options.messageId] - Optional message ID for WebSocket updates
 * @param {AbortSignal} [options.signal] - Optional abort signal
 * @returns {object} Rich context object
 */
export function buildContext(options) {
  let { req, sessionId, dataKey, messageId, signal } = options;

  let db = getDatabase();

  // Get session with full agent info (via participants, falls back to legacy agent_id)
  let session = loadSessionWithAgent(sessionId, req.user.id, db);

  if (!session)
    throw new Error('Session not found');

  if (!session.agent_id)
    throw new Error('Session has no agent configured');

  // Decrypt agent config
  let agentConfig = {};

  if (session.encrypted_config) {
    try {
      let decrypted = decryptWithKey(session.encrypted_config, dataKey);
      agentConfig   = JSON.parse(decrypted);
    } catch (error) {
      console.error(`Failed to decrypt/parse agent config for session ${sessionId}:`, error.message);
      agentConfig = {};
    }
  }

  // Parse default processes
  let defaultProcesses = [];
  try {
    defaultProcesses = JSON.parse(session.default_processes || '[]');
  } catch (error) {
    console.error(`Failed to parse default_processes for session ${sessionId}:`, error.message);
  }

  // Build model info from agent config
  let model = {
    name:      agentConfig.model || getDefaultModel(session.agent_type),
    maxTokens: agentConfig.maxTokens || 4096,
  };

  // Copy additional model params if present
  if (agentConfig.temperature !== undefined)
    model.temperature = agentConfig.temperature;

  if (agentConfig.topP !== undefined)
    model.topP = agentConfig.topP;

  if (agentConfig.topK !== undefined)
    model.topK = agentConfig.topK;

  // Load session participants for coordination awareness
  let participants = getSessionParticipants(parseInt(sessionId, 10), db);

  // Enrich agent participants with names from the agents table
  let enrichedParticipants = participants.map((participant) => {
    let enriched = { ...participant };

    if (participant.participantType === 'agent') {
      let agentRow = db.prepare('SELECT name, type FROM agents WHERE id = ?').get(participant.participantId);
      if (agentRow) {
        enriched.name = agentRow.name;
        enriched.agentType = agentRow.type;
      }
    } else if (participant.participantType === 'user') {
      let userRow = db.prepare('SELECT username FROM users WHERE id = ?').get(participant.participantId);
      if (userRow)
        enriched.name = userRow.username;
    }

    return enriched;
  });

  return {
    // User & Auth
    userId:    req.user.id,
    username:  req.user.username,
    sessionId: sessionId,
    dataKey:   dataKey,

    // Agent Configuration
    agent: {
      id:               session.agent_id,
      name:             session.agent_name,
      type:             session.agent_type,
      apiUrl:           session.agent_api_url,
      config:           agentConfig,
      defaultProcesses: defaultProcesses,
    },

    // Current Model Info
    model: model,

    // Session State
    session: {
      id:           session.id,
      name:         session.session_name,
      systemPrompt: session.system_prompt,
    },

    // Session Participants (for coordination)
    participants: enrichedParticipants,

    // Delegation depth tracking (for recursion prevention)
    delegationDepth: 0,

    // Abort Signal
    signal: signal || null,

    // Pipeline State (updated during execution)
    pipeline: {
      index:    0,
      handlers: [],
    },

    // Message tracking (for WebSocket updates)
    messageId: messageId || null,
  };
}

/**
 * Get the default model for an agent type.
 *
 * @param {string} agentType - Agent type (e.g., 'claude', 'openai')
 * @returns {string} Default model name
 */
function getDefaultModel(agentType) {
  switch (agentType) {
    case 'claude':
      return 'claude-sonnet-4-20250514';
    case 'openai':
      return 'gpt-4';
    default:
      return 'unknown';
  }
}

/**
 * Clone a context with updated fields.
 *
 * @param {object} context - Original context
 * @param {object} updates - Fields to update
 * @returns {object} New context with updates
 */
export function updateContext(context, updates) {
  return {
    ...context,
    ...updates,
    // Deep clone nested objects that might be updated
    pipeline: updates.pipeline
      ? { ...context.pipeline, ...updates.pipeline }
      : context.pipeline,
  };
}

export default {
  buildContext,
  updateContext,
};
