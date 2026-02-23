'use strict';

// ============================================================================
// Execute Command Function
// ============================================================================
// Allows agents to invoke slash commands via the interaction system.
// Permission-gated through the permissions engine (Phase 2).
//
// Flow:
//   1. Agent emits <interaction> with target_property: "execute_command"
//   2. System validates the command exists
//   3. System checks permissions (subject: agent, resource: command)
//   4. If allowed, executes the command
//   5. Returns the command result to the agent
//
// 'deny' blocks execution outright. 'prompt' broadcasts an hml-prompt form
// to the channel and awaits user approval before proceeding.

import { InteractionFunction, PERMISSION } from '../function.mjs';
import { getDatabase } from '../../../database.mjs';
import { executeCommand, getCommand, getAllCommands } from '../../commands/index.mjs';
import {
  evaluate,
  SubjectType,
  ResourceType,
  Action,
} from '../../permissions/index.mjs';
import { requestPermissionPrompt } from '../../permissions/prompt.mjs';

/**
 * Execute Command Function class.
 * Allows agents to invoke slash commands through the interaction system.
 */
export class ExecuteCommandFunction extends InteractionFunction {
  /**
   * Register the execute_command function with the interaction system.
   *
   * @returns {Object} Registration info
   */
  static register() {
    return {
      name:        'execute_command',
      description: 'Execute a slash command on behalf of the agent. Commands are permission-gated.',
      target:      '@system',
      permission:  PERMISSION.ALWAYS,
      schema: {
        type:       'object',
        properties: {
          command: {
            type:        'string',
            description: 'The command name (without the leading /)',
          },
          args: {
            type:        'string',
            description: 'Command arguments as a string',
            default:     '',
          },
        },
        required: ['command'],
      },
      examples: [
        {
          description: 'Execute the help command',
          payload: { command: 'help' },
        },
        {
          description: 'Execute the session command with arguments',
          payload: { command: 'session', args: 'info' },
        },
      ],
    };
  }

  constructor(context = {}) {
    super('execute_command', context);
  }

  /**
   * Check if command execution is allowed.
   *
   * @param {Object} payload - The command payload
   * @param {Object} context - Execution context
   * @returns {Promise<{allowed: boolean, reason?: string}>}
   */
  async allowed(payload, context = {}) {
    if (!payload?.command)
      return { allowed: false, reason: 'Command name is required' };

    // Check that the command exists
    let command = getCommand(payload.command);
    if (!command) {
      let available = getAllCommands().map((c) => c.name).join(', ');
      return {
        allowed: false,
        reason:  `Unknown command: ${payload.command}. Available: ${available}`,
      };
    }

    return { allowed: true };
  }

  /**
   * Execute the command.
   *
   * @param {Object} params - Command parameters
   * @param {string} params.command - Command name
   * @param {string} [params.args=''] - Command arguments
   * @returns {Promise<Object>} Command result
   */
  async execute(params) {
    let { command: commandName, args = '' } = params;
    let { sessionId, userId, agentId, dataKey, db: contextDb } = this.context;

    let db = contextDb || getDatabase();

    // -----------------------------------------------------------------------
    // Permission check (subject: agent, resource: command)
    // -----------------------------------------------------------------------
    let permission = evaluate(
      { type: SubjectType.AGENT, id: agentId },
      { type: ResourceType.COMMAND, name: commandName },
      { sessionId, ownerId: userId },
      db,
    );

    if (permission.action === Action.DENY) {
      return {
        status:  'failed',
        error:   `Permission denied: agent is not allowed to execute /${commandName}`,
        command: commandName,
      };
    }

    // If action is 'prompt', broadcast an hml-prompt form to the channel
    // and await user approval before proceeding.
    if (permission.action === Action.PROMPT) {
      let subject  = { type: SubjectType.AGENT, id: agentId };
      let resource = { type: ResourceType.COMMAND, name: commandName };

      let approval = await requestPermissionPrompt(subject, resource, {
        sessionId,
        userId,
        db,
      });

      if (approval.action !== Action.ALLOW) {
        return {
          status:  'failed',
          error:   `Permission denied by user: /${commandName} ${args}`.trim(),
          command: commandName,
        };
      }
    }

    // -----------------------------------------------------------------------
    // Execute the command
    // -----------------------------------------------------------------------

    // Build command execution context
    let commandContext = {
      sessionId: parseInt(sessionId, 10),
      userId:    userId,
      dataKey:   dataKey,
      db:        db,
    };

    // Load session info if available
    try {
      let session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
      if (session)
        commandContext.session = session;
    } catch (error) {
      // Session info is optional for command execution
    }

    let result = await executeCommand(commandName, args, commandContext);

    return {
      status:  (result.success) ? 'completed' : 'failed',
      command: commandName,
      args:    args,
      result:  result,
    };
  }
}

export default ExecuteCommandFunction;
