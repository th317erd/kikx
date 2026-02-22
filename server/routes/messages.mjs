'use strict';

// ============================================================================
// Non-Streaming Messages Route (Frame-Based)
// ============================================================================
// Provides non-streaming message handling. For most use cases, prefer the
// streaming endpoint at /messages/stream.

import { randomUUID } from 'crypto';
import { Router } from 'express';
import { getDatabase } from '../database.mjs';
import { requireAuth, getDataKey } from '../middleware/auth.mjs';
import { detectInteractions, executeInteractions, formatInteractionFeedback } from '../lib/interactions/index.mjs';
import { buildContext } from '../lib/pipeline/context.mjs';
import { processMarkup, hasExecutableElements } from '../lib/markup/index.mjs';
import { getStartupAbilities } from '../lib/abilities/registry.mjs';
import { loadFramesForContext } from '../lib/frames/context.mjs';
import {
  createUserMessageFrame,
  createAgentMessageFrame,
  createSystemMessageFrame,
} from '../lib/frames/broadcast.mjs';
import { handleCommandInterception } from '../lib/messaging/command-handler.mjs';
import { setupSessionAgent } from '../lib/messaging/session-setup.mjs';
import { loadSessionWithAgent } from '../lib/participants/index.mjs';
import { beforeUserMessage, afterAgentResponse } from '../lib/plugins/hooks.mjs';
import { stripInteractionTags } from '../lib/messaging/content-utils.mjs';
import { decomposeMessage } from '../lib/frames/decompose.mjs';
import { getFrames, FrameType } from '../lib/frames/index.mjs';

const router = Router();

// All routes require authentication
router.use(requireAuth);

/**
 * GET /api/sessions/:sessionId/messages
 * Get all messages for a session.
 */
router.get('/:sessionId/messages', (req, res) => {
  let db      = getDatabase();
  let session = db.prepare('SELECT id FROM sessions WHERE id = ? AND user_id = ?').get(req.params.sessionId, req.user.id);

  if (!session)
    return res.status(404).json({ error: 'Session not found' });

  // Get message frames and convert to legacy format
  let frames = db.prepare(`
    SELECT id, type, author_type, payload, timestamp
    FROM frames
    WHERE session_id = ? AND type = 'message'
    ORDER BY timestamp ASC
  `).all(req.params.sessionId);

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
    };
  });

  return res.json({ messages });
});

/**
 * POST /api/sessions/:sessionId/messages
 * Send a message and get the agent's response (non-streaming).
 *
 * If `hidden: true` is passed in the body, the message is stored as a hidden
 * system message and no agent response is generated. This is used by commands
 * like /reload to inject instructions without triggering a response.
 */
router.post('/:sessionId/messages', async (req, res) => {
  let { content, hidden } = req.body;

  if (!content || typeof content !== 'string')
    return res.status(400).json({ error: 'Message content required' });

  // =========================================================================
  // COMMAND INTERCEPTION: Check if this is a command before involving agent
  // =========================================================================
  let commandResult = await handleCommandInterception({
    content,
    sessionId: parseInt(req.params.sessionId, 10),
    userId:    req.user.id,
    dataKey:   (req.user && req.user.secret) ? req.user.secret.dataKey : null,
  });

  if (commandResult.handled) {
    if (commandResult.error && !commandResult.result) {
      return res.status(commandResult.status || 500).json({ error: commandResult.error });
    }
    return res.json(commandResult.result);
  }
  // =========================================================================
  // END COMMAND INTERCEPTION
  // =========================================================================

  // Run BEFORE_USER_MESSAGE hook (plugins can modify content)
  try {
    content = await beforeUserMessage(content, {
      sessionId: parseInt(req.params.sessionId, 10),
      userId:    req.user.id,
    });
  } catch (error) {
    console.error('[Messages] beforeUserMessage hook error:', error.message);
  }

  // If hidden flag is set, store as hidden and optionally show acknowledgment
  if (hidden) {
    let db = getDatabase();
    let sessionId = parseInt(req.params.sessionId, 10);

    // Verify session exists and belongs to user
    let session = db.prepare('SELECT id FROM sessions WHERE id = ? AND user_id = ?').get(sessionId, req.user.id);

    if (!session)
      return res.status(404).json({ error: 'Session not found' });

    // Store as hidden system message (agent can see this in context)
    createSystemMessageFrame({
      sessionId: sessionId,
      userId:    req.user.id,
      content:   content,
      hidden:    true,
    });

    // Create visible acknowledgment if requested
    if (req.body.showAcknowledgment) {
      createAgentMessageFrame({
        sessionId: sessionId,
        userId:    req.user.id,
        agentId:   null,
        content:   '<p><em>System instructions have been refreshed.</em></p>',
        hidden:    false,
        skipSanitize: true,
      });
    }

    // Update session timestamp
    db.prepare('UPDATE sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(sessionId);

    return res.json({
      success: true,
      message: 'Hidden message stored',
    });
  }

  let db = getDatabase();
  let sessionId = parseInt(req.params.sessionId, 10);

  // Load session with coordinator agent from participants
  let session = loadSessionWithAgent(sessionId, req.user.id, db);

  if (!session)
    return res.status(404).json({ error: 'Session not found' });

  if (!session.agent_id)
    return res.status(400).json({ error: 'Session has no agent configured' });

  try {
    let dataKey = getDataKey(req);

    // Set up agent with decrypted credentials, processes, and content injection
    let { agent, processedContent } = setupSessionAgent({
      session,
      userId:  req.user.id,
      dataKey,
      content,
    });

    // Check if this is the first message
    let frameCount = db.prepare(`
      SELECT COUNT(*) as count FROM frames
      WHERE session_id = ? AND type = 'message'
    `).get(sessionId)?.count || 0;

    let messages = [];

    // If this is the first message, inject startup abilities
    if (frameCount === 0) {
      let startupAbilities = getStartupAbilities();

      if (startupAbilities.length > 0) {
        let startupContent = startupAbilities
          .filter((a) => a.type === 'process' && a.content)
          .map((a) => a.content)
          .join('\n\n---\n\n');

        if (startupContent) {
          let onstartUserContent = `[System Initialization]\n\n${startupContent}`;

          // Store startup messages as hidden frames
          createSystemMessageFrame({
            sessionId: sessionId,
            userId:    req.user.id,
            content:   onstartUserContent,
            hidden:    true,
          });

          messages.push({ role: 'user', content: onstartUserContent });

          // Also add a placeholder assistant acknowledgment
          let ackContent = 'Understood. I\'ve processed the initialization instructions. Ready to assist.';
          createAgentMessageFrame({
            sessionId: sessionId,
            userId:    req.user.id,
            agentId:   session.agent_id,
            content:   ackContent,
            hidden:    true,
          });

          messages.push({ role: 'assistant', content: ackContent });
        }
      }
    } else {
      // Load existing messages from frames
      messages = loadFramesForContext(sessionId, { maxRecentFrames: 20 });
    }

    // Store user message as frame
    createUserMessageFrame({
      sessionId: sessionId,
      userId:    req.user.id,
      content:   content,
      hidden:    false,
    });

    // Update session timestamp
    db.prepare('UPDATE sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(sessionId);

    // Add user message to history (with processes injected for AI)
    messages.push({ role: 'user', content: processedContent });

    // Wrap the agent response + interaction loop in a timeout.
    // If a permission prompt blocks for >30s, return HTTP 202 so REST
    // clients can poll frames and respond via POST /frames/:id/respond.
    const RESPONSE_TIMEOUT = 30000;
    const TIMEOUT_SENTINEL = Symbol('timeout');

    let agentWork = (async () => {
      let response = await agent.sendMessage(messages);

      // Interaction execution loop
      let maxIterations = 10;
      let iterations    = 0;

      while (iterations < maxIterations) {
        iterations++;

        let interactionBlock = detectInteractions(response.content);

        if (!interactionBlock)
          break;

        // Decompose intermediate agent response into content + interaction segments.
        // Store each content segment as its own hidden frame.
        let responseText = (typeof response.content === 'string')
          ? response.content
          : (Array.isArray(response.content)
            ? response.content.filter((b) => b.type === 'text').map((b) => b.text).join('')
            : String(response.content));

        let segments     = decomposeMessage(responseText, 'assistant');
        let firstFrameId = null;

        for (let segment of segments) {
          if (segment.type === 'content') {
            let frame = createAgentMessageFrame({
              sessionId: sessionId,
              userId:    req.user.id,
              agentId:   session.agent_id,
              content:   segment.text,
              hidden:    true,
            });
            if (!firstFrameId) firstFrameId = frame.id;
          }
        }

        // Fallback: if no content frames, create a minimal hidden frame for parentFrameId
        if (!firstFrameId) {
          let fallbackFrame = createAgentMessageFrame({
            sessionId: sessionId,
            userId:    req.user.id,
            agentId:   session.agent_id,
            content:   stripInteractionTags(responseText) || '[interaction]',
            hidden:    true,
          });
          firstFrameId = fallbackFrame.id;
        }

        // Build context for agent-originated interactions
        // NOTE: No senderId — these are agent interactions, not user-authorized
        // BUG FIX: Added db and parentFrameId so REQUEST/RESULT frames are created
        let interactionContext = {
          sessionId:     sessionId,
          userId:        req.user.id,
          agentId:       session.agent_id,
          dataKey:       dataKey,
          db:            db,
          parentFrameId: firstFrameId,
        };

        let results = await executeInteractions(interactionBlock, interactionContext);

        // Format results as feedback
        let feedback = formatInteractionFeedback(results);

        // Store feedback as hidden frame
        createSystemMessageFrame({
          sessionId: sessionId,
          userId:    req.user.id,
          content:   feedback,
          hidden:    true,
        });

        // Add to message history and continue
        messages.push({ role: 'assistant', content: response.content });
        messages.push({ role: 'user', content: feedback });

        // Get next response
        response = await agent.sendMessage(messages);
      }

      return { response, iterations };
    })();

    let timeoutPromise = new Promise((resolve) => {
      setTimeout(() => resolve(TIMEOUT_SENTINEL), RESPONSE_TIMEOUT);
    });

    let raceResult = await Promise.race([agentWork, timeoutPromise]);

    // Timeout — check for pending permission request frames
    if (raceResult === TIMEOUT_SENTINEL) {
      let pendingRequestFrames = getFrames(sessionId, {
        types: [FrameType.REQUEST],
      }, db).filter((f) => {
        let payload = (typeof f.payload === 'string') ? JSON.parse(f.payload) : f.payload;
        return payload.action === 'permission_request' && payload.status === 'pending';
      });

      if (pendingRequestFrames.length > 0) {
        // There are pending permission requests — return 202 so the client
        // can respond via POST /api/sessions/:id/frames/:frameId/respond
        return res.status(202).json({
          status:  'pending_permission',
          frameId: pendingRequestFrames[0].id,
          message: `Respond via POST /api/sessions/${sessionId}/frames/${pendingRequestFrames[0].id}/respond`,
        });
      }

      // No pending permissions — genuine timeout
      return res.status(504).json({ error: 'Agent response timed out' });
    }

    let { response, iterations } = raceResult;

    // Extract text content from response (Claude API returns array of content blocks)
    let finalContent = response.content;
    if (Array.isArray(finalContent)) {
      finalContent = finalContent
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('');
    }

    if (typeof finalContent === 'string' && hasExecutableElements(finalContent)) {
      let hmlContext = buildContext({
        req,
        sessionId: sessionId,
        dataKey:   dataKey,
        messageId: randomUUID(),
      });

      let markupResult = await processMarkup(finalContent, hmlContext);

      if (markupResult.modified)
        finalContent = markupResult.text;
    }

    // Run AFTER_AGENT_RESPONSE hook (plugins can modify final content)
    try {
      let hookResult = await afterAgentResponse(
        { content: finalContent, agentId: session.agent_id },
        { sessionId, userId: req.user.id },
      );
      if (hookResult && typeof hookResult.content === 'string')
        finalContent = hookResult.content;
    } catch (error) {
      console.error('[Messages] afterAgentResponse hook error:', error.message);
    }

    // Decompose and store final assistant response as visible frame(s)
    let finalSegments = decomposeMessage(finalContent, 'assistant');
    let storedAnyFinal = false;

    for (let segment of finalSegments) {
      if (segment.type === 'content') {
        createAgentMessageFrame({
          sessionId: sessionId,
          userId:    req.user.id,
          agentId:   session.agent_id,
          content:   segment.text,
          hidden:    false,
        });
        storedAnyFinal = true;
      }
    }

    // Fallback: store full content if decomposition produced nothing
    if (!storedAnyFinal) {
      createAgentMessageFrame({
        sessionId: sessionId,
        userId:    req.user.id,
        agentId:   session.agent_id,
        content:   finalContent,
        hidden:    false,
      });
    }

    return res.json({
      content:        finalContent,
      toolCalls:      response.toolCalls || [],
      stopReason:     response.stopReason,
      interactionLog: (iterations > 1) ? `Executed ${iterations - 1} interaction cycles` : null,
    });
  } catch (error) {
    console.error('Message error:', error);
    return res.status(500).json({ error: 'Failed to process message' });
  }
});

export default router;
