'use strict';

import { WebSocketServer } from 'ws';
import { verifyToken } from '../auth.mjs';
import { answerQuestion, cancelQuestion } from './assertions/pending-questions.mjs';
import { handleApprovalResponse, cancelApproval } from './abilities/approval.mjs';
import { handleQuestionAnswer as handleAbilityQuestionAnswer, cancelQuestion as cancelAbilityQuestion } from './abilities/question.mjs';

// Lazy-loaded to avoid circular dependency:
// prompt.mjs → broadcast.mjs → websocket.mjs → prompt.mjs
let _permissionPrompt = null;
function getPermissionPrompt() {
  if (!_permissionPrompt) {
    _permissionPrompt = import('./permissions/prompt.mjs');
  }
  return _permissionPrompt;
}
import { getInteractionBus } from './interactions/bus.mjs';
import { getSessionFunctions, getUserFunctions } from './interactions/registry.mjs';
import { getParticipantsByType } from './participants/index.mjs';

// Connected clients (userId -> Set of WebSocket connections)
const clients = new Map();

// Interaction bus connection (set up during init)
let interactionBusConnected = false;

/**
 * Initialize WebSocket server.
 *
 * @param {http.Server} server - HTTP server to attach to
 */
export function initWebSocket(server) {
  let wss = new WebSocketServer({ server, path: '/ws' });

  // Connect interaction bus to WebSocket (once)
  if (!interactionBusConnected) {
    let bus = getInteractionBus();

    // When interaction bus needs user input, broadcast via WebSocket
    bus.on('user_interaction', (interaction) => {
      if (interaction.session_id) {
        broadcastToSession(interaction.session_id, {
          type:        'interaction_request',
          interaction: interaction,
        });
      } else if (interaction.user_id) {
        broadcastToUser(interaction.user_id, {
          type:        'interaction_request',
          interaction: interaction,
        });
      }
    });

    interactionBusConnected = true;
  }

  wss.on('connection', (ws, req) => {
    // Extract token from query string
    let url   = new URL(req.url, 'http://localhost');
    let token = url.searchParams.get('token');

    if (!token) {
      ws.close(4001, 'Authentication required');
      return;
    }

    // Verify token
    let decoded = verifyToken(token);

    if (!decoded) {
      ws.close(4001, 'Invalid or expired token');
      return;
    }

    let userId = decoded.sub;

    // Add to clients map
    if (!clients.has(userId))
      clients.set(userId, new Set());

    clients.get(userId).add(ws);

    console.log(`WebSocket client connected for user ${userId}`);

    // Get interaction bus for this connection
    let bus = getInteractionBus();

    // Subscribe to interaction events for this user
    let onInteraction = (interaction) => {
      if (interaction.user_id === userId && ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({
          type:        'interaction',
          interaction: interaction,
        }));
      }
    };
    bus.on('interaction', onInteraction);

    // Send current running functions on connect
    let runningFunctions = getUserFunctions(userId, true);

    if (runningFunctions.length > 0) {
      ws.send(JSON.stringify({
        type:      'running_functions',
        functions: runningFunctions.map((f) => f.toJSON()),
      }));
    }

    // Handle incoming messages
    ws.on('message', async (data) => {
      try {
        let message = JSON.parse(data.toString());

        switch (message.type) {
          case 'abort':
          case 'cancel_function':
            if (message.functionId || message.commandId) {
              let funcId = message.functionId || message.commandId;
              let { getFunctionInstance } = require('./interactions/registry.mjs');
              let func = getFunctionInstance(funcId, null, userId);
              let cancelled = (func) ? func.cancel('Cancelled by user') : false;

              ws.send(JSON.stringify({
                type:       'cancel_result',
                functionId: funcId,
                success:    cancelled,
              }));
            }
            break;

          case 'question_answer':
            if (message.assertionId && message.answer !== undefined) {
              let answered = answerQuestion(message.assertionId, message.answer);

              ws.send(JSON.stringify({
                type:        'question_answer_result',
                assertionId: message.assertionId,
                success:     answered,
              }));
            }
            break;

          case 'question_cancel':
            if (message.assertionId) {
              cancelQuestion(message.assertionId);

              ws.send(JSON.stringify({
                type:        'question_cancel_result',
                assertionId: message.assertionId,
                success:     true,
              }));
            }
            break;

          // Ability approval responses
          case 'ability_approval_response':
            if (message.executionId) {
              // Pass security context: authenticated userId + optional request hash
              let approvalResult = handleApprovalResponse(
                message.executionId,
                message.approved,
                message.reason,
                message.rememberForSession,
                {
                  userId:      userId,
                  requestHash: message.requestHash || null,
                }
              );

              ws.send(JSON.stringify({
                type:        'ability_approval_result',
                executionId: message.executionId,
                success:     approvalResult?.success ?? true,
                error:       approvalResult?.error || null,
              }));
            }
            break;

          case 'ability_approval_cancel':
            if (message.executionId) {
              cancelApproval(message.executionId);

              ws.send(JSON.stringify({
                type:        'ability_approval_cancel_result',
                executionId: message.executionId,
                success:     true,
              }));
            }
            break;

          // Permission prompt responses
          case 'permission_prompt_response':
            if (message.promptId && message.answer) {
              let permModule  = await getPermissionPrompt();
              let promptResult = permModule.handlePermissionResponse(
                message.promptId,
                message.answer,
              );

              ws.send(JSON.stringify({
                type:     'permission_prompt_result',
                promptId: message.promptId,
                success:  promptResult.success,
                error:    promptResult.error || null,
              }));
            }
            break;

          case 'permission_prompt_cancel':
            if (message.promptId) {
              let permModule = await getPermissionPrompt();
              permModule.cancelPermissionPrompt(message.promptId);

              ws.send(JSON.stringify({
                type:     'permission_prompt_cancel_result',
                promptId: message.promptId,
                success:  true,
              }));
            }
            break;

          // Ability question answers
          case 'ability_question_answer':
            if (message.questionId && message.answer !== undefined) {
              let answered = handleAbilityQuestionAnswer(message.questionId, message.answer);

              ws.send(JSON.stringify({
                type:       'ability_question_answer_result',
                questionId: message.questionId,
                success:    answered,
              }));
            }
            break;

          case 'ability_question_cancel':
            if (message.questionId) {
              cancelAbilityQuestion(message.questionId);

              ws.send(JSON.stringify({
                type:       'ability_question_cancel_result',
                questionId: message.questionId,
                success:    true,
              }));
            }
            break;

          // Interaction bus responses
          case 'interaction_response':
            if (message.interactionId) {
              let bus      = getInteractionBus();
              let resolved = bus.respond(
                message.interactionId,
                message.payload,
                message.success !== false,
                { userId: userId } // Pass authenticated user for verification
              );

              ws.send(JSON.stringify({
                type:          'interaction_response_result',
                interactionId: message.interactionId,
                success:       resolved,
              }));
            }
            break;
        }
      } catch (e) {
        console.error('WebSocket message parse error:', e);
      }
    });

    // Handle disconnect
    ws.on('close', () => {
      clients.get(userId)?.delete(ws);

      if (clients.get(userId)?.size === 0)
        clients.delete(userId);

      // Remove interaction event listener
      bus.off('interaction', onInteraction);

      console.log(`WebSocket client disconnected for user ${userId}`);
    });

    ws.on('error', (error) => {
      console.error('WebSocket error:', error);
    });
  });

  console.log('WebSocket server initialized on /ws');

  return wss;
}

/**
 * Broadcast a message to all connected clients for a user.
 *
 * @param {number} userId - User ID
 * @param {object} message - Message to send
 */
export function broadcastToUser(userId, message) {
  let userClients = clients.get(userId);

  if (!userClients)
    return;

  let payload = JSON.stringify(message);

  for (let ws of userClients) {
    if (ws.readyState === ws.OPEN)
      ws.send(payload);
  }
}

/**
 * Broadcast a message to all connected user participants in a session.
 *
 * Looks up all user-type participants for the given session and broadcasts
 * to each of their connected WebSocket clients. This is the primary
 * broadcast function — ALL session events go to ALL participants.
 *
 * @param {number} sessionId - Session ID
 * @param {object} message - Message to send
 */
export function broadcastToSession(sessionId, message) {
  let participants = getParticipantsByType(sessionId, 'user');
  let payload = JSON.stringify(message);

  for (let participant of participants) {
    let userClients = clients.get(participant.participantId);

    if (!userClients)
      continue;

    for (let ws of userClients) {
      if (ws.readyState === ws.OPEN)
        ws.send(payload);
    }
  }
}

/**
 * Get the number of connected clients for a user.
 *
 * @param {number} userId - User ID
 * @returns {number} Number of connected clients
 */
export function getClientCount(userId) {
  return clients.get(userId)?.size || 0;
}

export default {
  initWebSocket,
  broadcastToUser,
  broadcastToSession,
  getClientCount,
};
