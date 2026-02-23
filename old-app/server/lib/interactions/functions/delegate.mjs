'use strict';

// ============================================================================
// Delegate Function
// ============================================================================
// Allows a coordinator agent to delegate tasks to member agents in the same
// session. The coordinator sends a delegation request with a target agent ID
// and task description. The system loads the target agent, sends the task,
// and returns the member's response.
//
// Flow:
//   1. Coordinator emits <interaction> with target_property: "delegate"
//   2. System validates the target agent is a session participant (member)
//   3. System loads and initializes the target agent
//   4. System sends the delegation task to the member agent
//   5. Member agent responds
//   6. Response is returned to the coordinator as interaction result
//
// Recursion depth is enforced to prevent infinite delegation loops.

import { InteractionFunction, PERMISSION } from '../function.mjs';
import { getDatabase } from '../../../database.mjs';
import { decryptWithKey } from '../../../encryption.mjs';
import { createAgent } from '../../agents/index.mjs';
import {
  getSessionParticipants,
  isParticipant,
  ParticipantType,
  ParticipantRole,
} from '../../participants/index.mjs';
import {
  createAgentMessageFrame,
  createRequestFrame,
  createResultFrame,
} from '../../frames/broadcast.mjs';
import { loadFramesForContext } from '../../frames/context.mjs';

// Maximum delegation depth to prevent infinite loops
export const MAX_DELEGATION_DEPTH = 10;

/**
 * Delegate Function class.
 * Allows coordinators to delegate tasks to member agents.
 */
export class DelegateFunction extends InteractionFunction {
  /**
   * Register the delegate function with the interaction system.
   *
   * @returns {Object} Registration info
   */
  static register() {
    return {
      name:        'delegate',
      description: 'Delegate a task to a member agent in the current session. The member agent will process the task and return a response.',
      target:      '@system',
      permission:  PERMISSION.ALWAYS,
      schema: {
        type:       'object',
        properties: {
          agentId: {
            type:        'number',
            description: 'The ID of the target agent to delegate to (must be a member participant in this session)',
          },
          task: {
            type:        'string',
            description: 'The task description or instruction for the member agent',
          },
          context: {
            type:        'string',
            description: 'Optional additional context to provide to the member agent',
          },
        },
        required: ['agentId', 'task'],
      },
      examples: [
        {
          description: 'Delegate a research task to another agent',
          payload: {
            agentId: 5,
            task:    'Research the latest developments in quantum computing and summarize the key findings.',
            context: 'Focus on practical applications announced in the last 6 months.',
          },
        },
      ],
    };
  }

  constructor(context = {}) {
    super('delegate', context);
  }

  /**
   * Check if delegation is allowed.
   *
   * @param {Object} payload - The delegation payload
   * @param {Object} context - Execution context
   * @returns {Promise<{allowed: boolean, reason?: string}>}
   */
  async allowed(payload, context = {}) {
    // Must have a session context
    if (!context.sessionId)
      return { allowed: false, reason: 'Delegation requires a session context' };

    // Must have a target agent ID
    if (!payload?.agentId)
      return { allowed: false, reason: 'Target agentId is required' };

    // Must have a task
    if (!payload?.task)
      return { allowed: false, reason: 'Task description is required' };

    return { allowed: true };
  }

  /**
   * Execute the delegation.
   *
   * @param {Object} params - Delegation parameters
   * @param {number} params.agentId - Target agent ID
   * @param {string} params.task - Task description
   * @param {string} [params.context] - Additional context
   * @returns {Promise<Object>} Delegation result
   */
  async execute(params) {
    let { agentId: targetAgentId, task, context: additionalContext } = params;
    let {
      sessionId,
      userId,
      dataKey,
      agentId: coordinatorAgentId,
      delegationDepth,
      parentFrameId,
      db: contextDb,
    } = this.context;

    let db = contextDb || getDatabase();

    // -----------------------------------------------------------------------
    // Validate recursion depth
    // -----------------------------------------------------------------------
    let currentDepth = delegationDepth || 0;

    if (currentDepth >= MAX_DELEGATION_DEPTH) {
      return {
        status:  'failed',
        error:   `Maximum delegation depth (${MAX_DELEGATION_DEPTH}) exceeded. Cannot delegate further.`,
      };
    }

    // -----------------------------------------------------------------------
    // Validate target agent is a session participant
    // -----------------------------------------------------------------------
    let sessionIdInt = parseInt(sessionId, 10);

    if (!isParticipant(sessionIdInt, ParticipantType.AGENT, targetAgentId, db)) {
      return {
        status: 'failed',
        error:  `Agent ${targetAgentId} is not a participant in session ${sessionId}`,
      };
    }

    // Prevent self-delegation
    if (targetAgentId === coordinatorAgentId) {
      return {
        status: 'failed',
        error:  'An agent cannot delegate to itself',
      };
    }

    // -----------------------------------------------------------------------
    // Load target agent from database
    // -----------------------------------------------------------------------
    let targetAgent = db.prepare(`
      SELECT id, name, type, api_url, encrypted_api_key, encrypted_config
      FROM agents
      WHERE id = ?
    `).get(targetAgentId);

    if (!targetAgent) {
      return {
        status: 'failed',
        error:  `Agent ${targetAgentId} not found`,
      };
    }

    // -----------------------------------------------------------------------
    // Decrypt agent credentials
    // -----------------------------------------------------------------------
    if (!dataKey) {
      return {
        status: 'failed',
        error:  'Data key not available for agent credential decryption',
      };
    }

    let apiKey = null;
    if (targetAgent.encrypted_api_key) {
      try {
        apiKey = decryptWithKey(targetAgent.encrypted_api_key, dataKey);
      } catch (error) {
        return {
          status: 'failed',
          error:  `Failed to decrypt API key for agent ${targetAgent.name}: ${error.message}`,
        };
      }
    }

    let agentConfig = {};
    if (targetAgent.encrypted_config) {
      try {
        agentConfig = JSON.parse(decryptWithKey(targetAgent.encrypted_config, dataKey));
      } catch (error) {
        console.error(`Failed to decrypt config for agent ${targetAgent.name}:`, error.message);
      }
    }

    // -----------------------------------------------------------------------
    // Create target agent instance
    // -----------------------------------------------------------------------
    let agent;
    try {
      agent = createAgent(targetAgent.type, {
        apiKey: apiKey,
        apiUrl: targetAgent.api_url,
        ...agentConfig,
      });
    } catch (error) {
      return {
        status: 'failed',
        error:  `Failed to create agent instance for ${targetAgent.name}: ${error.message}`,
      };
    }

    // -----------------------------------------------------------------------
    // Build messages for the member agent
    // -----------------------------------------------------------------------

    // Load recent conversation context (limited for members)
    let conversationHistory = loadFramesForContext(sessionIdInt, { maxRecentFrames: 10 });

    // Build the delegation prompt
    let delegationPrompt = buildDelegationPrompt({
      task,
      additionalContext,
      coordinatorAgentId,
      targetAgentName: targetAgent.name,
      delegationDepth: currentDepth + 1,
    });

    let messages = [
      ...conversationHistory,
      { role: 'user', content: delegationPrompt },
    ];

    // -----------------------------------------------------------------------
    // Send task to member agent
    // -----------------------------------------------------------------------
    try {
      // Delegation timeout: 120 seconds to prevent indefinite blocking
      let DELEGATION_TIMEOUT_MS = 120_000;
      let response = await Promise.race([
        agent.sendMessage(messages, {}),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Delegation timed out after 120 seconds')), DELEGATION_TIMEOUT_MS),
        ),
      ]);

      // Extract text content from response
      let responseContent = '';

      if (typeof response.content === 'string') {
        responseContent = response.content;
      } else if (Array.isArray(response.content)) {
        responseContent = response.content
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('');
      }

      // Store delegation response as a frame attributed to the member agent
      createAgentMessageFrame({
        sessionId: sessionIdInt,
        userId:    userId,
        agentId:   targetAgentId,
        content:   responseContent,
        hidden:    false,
      });

      return {
        status:    'completed',
        agentId:   targetAgentId,
        agentName: targetAgent.name,
        response:  responseContent,
        depth:     currentDepth + 1,
      };
    } catch (error) {
      return {
        status: 'failed',
        error:  `Agent ${targetAgent.name} failed to process delegation: ${error.message}`,
      };
    }
  }
}

/**
 * Build a delegation prompt for the member agent.
 *
 * @param {Object} options - Options
 * @param {string} options.task - The task to perform
 * @param {string} [options.additionalContext] - Additional context
 * @param {number} options.coordinatorAgentId - The delegating agent's ID
 * @param {string} options.targetAgentName - The target agent's name
 * @param {number} options.delegationDepth - Current depth
 * @returns {string} The formatted delegation prompt
 */
function buildDelegationPrompt(options) {
  let { task, additionalContext, coordinatorAgentId, targetAgentName, delegationDepth } = options;

  let lines = [
    `[Delegated Task — Depth ${delegationDepth}]`,
    '',
    `You (${targetAgentName}) have been delegated a task by the coordinator agent (ID: ${coordinatorAgentId}).`,
    '',
    `**Task:** ${task}`,
  ];

  if (additionalContext) {
    lines.push('');
    lines.push(`**Additional Context:** ${additionalContext}`);
  }

  lines.push('');
  lines.push('Please complete this task and provide your response. Be concise and focused on the task at hand.');

  return lines.join('\n');
}

export default DelegateFunction;
