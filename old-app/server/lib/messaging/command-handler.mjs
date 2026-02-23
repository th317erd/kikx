'use strict';

// ============================================================================
// Command Handler
// ============================================================================
// Encapsulates command interception logic shared between
// messages.mjs and messages-stream.mjs routes.

import { getDatabase } from '../../database.mjs';
import {
  createUserMessageFrame,
  createAgentMessageFrame,
} from '../frames/broadcast.mjs';
import { isCommand, parseCommand, executeCommand } from '../commands/index.mjs';
import { loadSessionWithAgent } from '../participants/index.mjs';
import { evaluate, SubjectType, ResourceType, Action } from '../permissions/index.mjs';
import { beforeCommand, afterCommand } from '../plugins/hooks.mjs';

/**
 * Check if content is a command and execute it if so.
 *
 * Creates user message frame and agent response frame for the command,
 * then returns a result object indicating what happened.
 *
 * @param {object} options
 * @param {string} options.content - The message content
 * @param {number} options.sessionId - Session ID
 * @param {number} options.userId - User ID
 * @param {string} [options.dataKey] - Decryption key from auth middleware (needed for agent-requiring commands like /compact)
 * @returns {{ handled: boolean, result?: object, error?: string, status?: number }}
 */
export async function handleCommandInterception({ content, sessionId, userId, dataKey }) {
  if (!isCommand(content)) {
    return { handled: false };
  }

  let parsed = parseCommand(content);
  let db     = getDatabase();

  // Get session info for command context (via participants, falls back to legacy agent_id)
  let session = loadSessionWithAgent(sessionId, userId, db);

  if (!session) {
    return { handled: true, error: 'Session not found', status: 404 };
  }

  let context = {
    sessionId: sessionId,
    userId:    userId,
    session:   session,
    agentId:   session.agent_id,
    dataKey:   dataKey,
    db:        db,
  };

  try {
    // Store user's command message as a frame FIRST (before executing command)
    // This ensures the user message has an earlier timestamp than any response frames
    createUserMessageFrame({
      sessionId: context.sessionId,
      userId:    context.userId,
      content:   content,
      hidden:    false,
    });

    // Permission check: evaluate whether this subject can execute this command
    let permission;
    try {
      permission = evaluate(
        { type: SubjectType.USER, id: userId },
        { type: ResourceType.COMMAND, name: parsed.name },
        { sessionId, ownerId: userId },
        db,
      );
    } catch (permError) {
      // Fail-safe to deny on permission engine error
      console.error(`[Security] Permission evaluation error for command '${parsed.name}':`, permError.message);
      permission = { action: Action.DENY, rule: null };
    }

    if (permission.action === Action.DENY) {
      createAgentMessageFrame({
        sessionId:    context.sessionId,
        userId:       context.userId,
        agentId:      null,
        content:      `**Permission denied:** You are not allowed to execute \`/${parsed.name}\`.`,
        hidden:       false,
        skipSanitize: true,
      });

      return {
        handled: true,
        result:  {
          success: false,
          command: parsed.name,
          error:   'Permission denied',
        },
      };
    }

    // Permission prompt: user-initiated commands auto-allow on 'prompt'
    // (users don't need to approve their own commands — only agents do)
    // The 'prompt' action only blocks in the interaction detector for agent actions.

    // Run BEFORE_COMMAND hook (allows plugins to modify or block commands)
    let commandData = await beforeCommand(
      { command: parsed.name, args: parsed.args },
      context,
    );

    let result = await executeCommand(commandData.command, commandData.args, context);

    // Run AFTER_COMMAND hook (allows plugins to process results)
    await afterCommand(
      { command: commandData.command, args: commandData.args, result },
      context,
    );

    // If command has content to display, create a response frame
    if (!result.noResponse) {
      let responseContent = result.success
        ? result.content || 'Command executed.'
        : `**Error:** ${result.error}`;

      createAgentMessageFrame({
        sessionId:    context.sessionId,
        userId:       context.userId,
        agentId:      null,  // System response, not from agent
        content:      responseContent,
        hidden:       false,
        skipSanitize: true,
      });
    }

    return {
      handled: true,
      result: {
        success:       result.success,
        command:       parsed.name,
        content:       result.content,
        error:         result.error,
        streamingMode: result.streamingMode,
        showModal:     result.showModal,
        sendToAgent:   result.sendToAgent,
        agentContent:  result.agentContent,
      },
    };
  } catch (error) {
    console.error('[Commands] Command execution error:', error);
    return {
      handled: true,
      error:   `Command failed: ${error.message}`,
      status:  500,
      result:  {
        success: false,
        command: parsed.name,
        error:   `Command failed: ${error.message}`,
      },
    };
  }
}
