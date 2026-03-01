'use strict';

// ============================================================================
// Streaming Messages Route
// ============================================================================
// Provides real-time streaming of agent responses with progressive HML parsing.
// Uses Server-Sent Events (SSE) for efficient one-way streaming.
//
// First-message flow:
// 1. User sends first message -> server detects empty session
// 2. Server loads onstart abilities and sends to agent (non-streaming)
// 3. Server waits for agent acknowledgment
// 4. Server stores onstart + ack as hidden messages, broadcasts via WebSocket
// 5. Server proceeds with user's actual message via streaming

import { randomUUID } from 'crypto';
import { Router } from 'express';
import { getDatabase } from '../database.mjs';
import { requireAuth, getDataKey } from '../middleware/auth.mjs';
import { buildContext } from '../lib/pipeline/context.mjs';
import { createStreamParser } from '../lib/markup/stream-parser.mjs';
import { executePipeline } from '../lib/pipeline/index.mjs';
import { getStartupAbilities } from '../lib/abilities/registry.mjs';
import { checkConditionalAbilities, formatConditionalInstructions } from '../lib/abilities/index.mjs';
import { evaluate as evaluatePermission, Action as PermissionAction } from '../lib/permissions/index.mjs';
import { requestPermissionPrompt, isPermissionPrompt, createPermitBag, checkPermitBag, recordPermitBagGrant } from '../lib/permissions/prompt.mjs';
import { broadcastToSession } from '../lib/websocket.mjs';
import { detectInteractions, executeInteractions, formatInteractionFeedback, searchWeb } from '../lib/interactions/index.mjs';
import { checkCompaction } from '../lib/compaction.mjs';
import { loadFramesForContext } from '../lib/frames/context.mjs';
import {
  createUserMessageFrame,
  createAgentMessageFrame,
  createSystemMessageFrame,
} from '../lib/frames/broadcast.mjs';
import { handleCommandInterception } from '../lib/messaging/command-handler.mjs';
import { setupSessionAgent } from '../lib/messaging/session-setup.mjs';
import { loadSessionWithAgent, loadAgentForSession, getSessionParticipants } from '../lib/participants/index.mjs';
import { findMentionedAgent } from '../lib/mentions.mjs';
import { beforeUserMessage, afterAgentResponse } from '../lib/plugins/hooks.mjs';
import {
  stripInteractionTags,
  replaceInteractionTagsWithNote,
  getFriendlyErrorMessage,
  getFunctionBannerConfig,
  elementToAssertion,
} from '../lib/messaging/content-utils.mjs';
import { decomposeMessage } from '../lib/frames/decompose.mjs';


const router = Router();

// Debug logging helper
const DEBUG = process.env.DEBUG === 'true' || process.env.DEBUG === '1';

function debug(...args) {
  if (DEBUG)
    console.log('[Stream]', ...args);
}

// All routes require authentication
router.use(requireAuth);

/**
 * Process onstart abilities for a new session.
 * Makes a non-streaming call to the agent and returns the acknowledgment.
 *
 * @param {object} agent - Agent instance
 * @param {string} startupContent - The startup abilities content
 * @returns {Promise<string>} The agent's acknowledgment response
 */
async function processOnstartAbilities(agent, startupContent) {
  debug('Processing onstart abilities', { contentLength: startupContent.length });

  let messages = [
    { role: 'user', content: `[System Initialization]\n\n${startupContent}` },
  ];

  try {
    let response = await agent.sendMessage(messages, {});

    // Extract text content from response
    let ackContent = '';

    if (typeof response.content === 'string') {
      ackContent = response.content;
    } else if (Array.isArray(response.content)) {
      ackContent = response.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('');
    }

    debug('Onstart acknowledgment received', { length: ackContent.length });

    return ackContent || 'Understood. Ready to assist.';
  } catch (error) {
    debug('Onstart processing error:', error.message);
    throw error;
  }
}

/**
 * POST /api/sessions/:sessionId/messages/stream
 * Send a message and stream the agent's response via SSE.
 *
 * Events emitted:
 * - message_start: Stream beginning
 * - text: Plain text chunk
 * - element_start: HML element opening tag detected
 * - element_update: HML element content accumulating
 * - element_complete: HML element closing tag found
 * - element_result: Executable element finished executing
 * - message_complete: Full response received
 * - error: Error occurred
 */
router.post('/:sessionId/messages/stream', async (req, res) => {
  debug('Stream request received', { sessionId: req.params.sessionId, userId: req.user?.id });

  let { content } = req.body;

  if (!content || typeof content !== 'string') {
    debug('Invalid content:', { content });
    return res.status(400).json({ error: 'Message content required' });
  }

  debug('Content received:', { length: content.length, preview: content.slice(0, 100) });

  let db = getDatabase();

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
    debug('Command result:', commandResult.result);
    return res.json(commandResult.result);
  }
  // =========================================================================
  // END COMMAND INTERCEPTION - Continue with normal message processing
  // =========================================================================

  // Run BEFORE_USER_MESSAGE hook (plugins can modify content)
  let hookContext = {
    sessionId: parseInt(req.params.sessionId, 10),
    userId:    req.user.id,
  };

  try {
    content = await beforeUserMessage(content, hookContext);
  } catch (error) {
    debug('beforeUserMessage hook error:', error.message);
  }

  // Load session with coordinator agent from participants
  let session = loadSessionWithAgent(parseInt(req.params.sessionId, 10), req.user.id, db);

  if (!session) {
    debug('Session not found');
    return res.status(404).json({ error: 'Session not found' });
  }

  if (!session.agent_id) {
    debug('Session has no agent');
    return res.status(400).json({ error: 'Session has no agent configured' });
  }

  // @mention routing: if the message @mentions a member agent, route to that agent
  let participants = getSessionParticipants(session.id, db);
  let enriched     = participants
    .filter((p) => p.participantType === 'agent')
    .map((p) => {
      let agent = db.prepare('SELECT name FROM agents WHERE id = ?').get(p.participantId);
      return { ...p, name: agent?.name || null };
    });

  let mentioned = findMentionedAgent(content, enriched);
  if (mentioned && mentioned.agentId !== session.agent_id) {
    let agentOverride = loadAgentForSession(session.id, mentioned.agentId, db);
    if (agentOverride) {
      debug('@mention routing override', { from: session.agent_name, to: agentOverride.agent_name });
      Object.assign(session, agentOverride);
    }
  }

  debug('Session found', { id: session.id, agentType: session.agent_type, agentName: session.agent_name });

  // Set up SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
  // Note: Don't set Transfer-Encoding manually - Node.js handles chunked encoding automatically

  // Disable all timeouts to prevent premature connection closure for SSE
  req.setTimeout(0);
  res.setTimeout(0);
  if (req.socket)
    req.socket.setTimeout(0);

  // Disable Nagle's algorithm for immediate sending
  if (res.socket) {
    res.socket.setNoDelay(true);
    res.socket.setKeepAlive(true, 30000);
    res.socket.setTimeout(0);
  }

  // Add error handlers to detect issues
  res.on('error', (error) => {
    debug('Response error:', error.message);
  });

  if (res.socket) {
    res.socket.on('error', (error) => {
      debug('Socket error:', error.message);
    });
    res.socket.on('end', () => {
      debug('Socket end event');
    });
    res.socket.on('timeout', () => {
      debug('Socket timeout');
    });
  }

  res.flushHeaders();

  // Send initial comment to establish connection
  res.write(':ok\n\n');
  if (res.flush)
    res.flush();

  debug('SSE headers sent and flushed');

  // Wrap res.end to detect unexpected calls
  let originalEnd = res.end.bind(res);
  res.end = (...args) => {
    debug('res.end called', new Error('Stack trace').stack);
    return originalEnd(...args);
  };

  // Create our own AbortController to isolate from Express quirks
  let abortController = new AbortController();

  // Set up periodic keep-alive to prevent proxy timeouts
  let keepAliveInterval = setInterval(() => {
    if (!aborted) {
      res.write(':heartbeat\n\n');
      if (res.flush)
        res.flush();
    }
  }, 15000); // Every 15 seconds

  // Helper to send SSE events
  function sendEvent(event, data) {
    if (aborted) {
      debug('sendEvent called but already aborted, skipping:', event);
      return false;
    }

    let payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    let writeResult = res.write(payload);
    debug('sendEvent write result:', { event, writeResult, payloadLength: payload.length });

    // Flush to ensure data is sent immediately (important for SSE)
    if (typeof res.flush === 'function') {
      res.flush();
    } else if (res.socket && !res.socket.destroyed) {
      // Force flush by writing empty string and using socket
      res.socket.uncork?.();
    }

    // Also broadcast to WebSocket for other connected clients
    broadcastToSession(parseInt(req.params.sessionId, 10), {
      type:      `stream_${event}`,
      sessionId: req.params.sessionId,
      ...data,
    });

    return writeResult;
  }

  // Handle client disconnect
  // NOTE: We use res.on('close') instead of req.on('close') because
  // express.json() middleware causes req.on('close') to fire prematurely
  // after it finishes consuming the request body, even though the SSE
  // response stream is still active. res.on('close') correctly fires
  // only when the client actually disconnects or the response ends.
  let aborted = false;
  res.on('close', () => {
    // Only set aborted if we didn't end the response ourselves
    if (!res.writableEnded) {
      debug('Client disconnected (res close before writableEnded)');
      aborted = true;
      abortController.abort();
      clearInterval(keepAliveInterval);
    } else {
      debug('Response ended normally (res close after writableEnded)');
    }
  });

  try {
    let dataKey = getDataKey(req);

    // Set up agent with decrypted credentials, processes, and content injection
    debug('Creating agent', { type: session.agent_type, hasApiUrl: !!session.agent_api_url });
    let { agent, processedContent } = setupSessionAgent({
      session,
      userId:  req.user.id,
      dataKey,
      content,
    });
    debug('Agent created successfully');

    // Check if there are existing frames in the session
    let existingFrameCount = db.prepare(`
      SELECT COUNT(*) as count FROM frames
      WHERE session_id = ? AND type = 'message'
    `).get(req.params.sessionId)?.count || 0;

    // Build messages array for agent
    let messages = [];

    // =========================================================================
    // FIRST MESSAGE FLOW: Process onstart abilities before user's message
    // =========================================================================
    if (existingFrameCount === 0) {
      debug('First message in session, checking for onstart abilities');

      let startupAbilities = getStartupAbilities();
      let startupContent   = startupAbilities
        .filter((a) => a.type === 'process' && a.content)
        .map((a) => a.content)
        .join('\n\n---\n\n');

      if (startupContent) {
        debug('Processing onstart abilities', { abilityCount: startupAbilities.length });

        // Check if already aborted
        if (aborted) {
          debug('Aborted before onstart processing');
          clearInterval(keepAliveInterval);
          res.end();
          return;
        }

        // Send event to indicate we're processing onstart
        sendEvent('onstart_processing', {
          sessionId: req.params.sessionId,
          message:   'Processing initialization...',
        });

        try {
          // Send heartbeats during onstart processing to keep connection alive
          let onstartHeartbeat = setInterval(() => {
            if (!aborted) {
              debug('Sending onstart heartbeat');
              res.write(':heartbeat\n\n');
            }
          }, 1000);

          // Make non-streaming call to agent for onstart acknowledgment
          let ackContent;
          try {
            ackContent = await processOnstartAbilities(agent, startupContent);
          } finally {
            clearInterval(onstartHeartbeat);
          }

          // Check if aborted during onstart processing
          if (aborted) {
            debug('Aborted during onstart processing');
            clearInterval(keepAliveInterval);
            res.end();
            return;
          }

          // Store onstart user message as hidden system frame
          let onstartUserContent = `[System Initialization]\n\n${startupContent}`;
          createSystemMessageFrame({
            sessionId: parseInt(req.params.sessionId, 10),
            userId:    req.user.id,
            content:   onstartUserContent,
            hidden:    true,
          });

          // Store agent acknowledgment as hidden agent frame
          createAgentMessageFrame({
            sessionId: parseInt(req.params.sessionId, 10),
            userId:    req.user.id,
            agentId:   session.agent_id,
            content:   ackContent,
            hidden:    true,
          });

          // Add to messages array for context
          messages.push({ role: 'user', content: onstartUserContent });
          messages.push({ role: 'assistant', content: ackContent });

          sendEvent('onstart_complete', {
            sessionId: req.params.sessionId,
            message:   'Initialization complete',
          });
        } catch (onstartError) {
          debug('Onstart error:', onstartError.message);
          sendEvent('onstart_error', {
            sessionId: req.params.sessionId,
            error:     onstartError.message,
          });
          // Continue anyway - the user's message can still be processed
        }
      }
    } else {
      // Load messages using frame-based context (handles compaction automatically)
      messages = loadFramesForContext(parseInt(req.params.sessionId, 10), { maxRecentFrames: 20 });
      debug('Loaded messages from frames', { count: messages.length });
    }

    // =========================================================================
    // USER MESSAGE: Store and stream response
    // =========================================================================

    // =========================================================================
    // Detect if this is a permission prompt answer before storing/sending.
    // Permission prompt answers are system interactions — they should be
    // stored as hidden and should NOT trigger an agent response turn.
    // =========================================================================
    let isPermissionPromptAnswer = false;
    let userInteractionBlock     = null;

    if (content.includes('<interaction')) {
      userInteractionBlock = detectInteractions(content);
      if (userInteractionBlock && userInteractionBlock.interactions.length > 0) {
        for (let interaction of userInteractionBlock.interactions) {
          if (interaction.target_property === 'update_prompt' &&
              interaction.payload?.promptId &&
              isPermissionPrompt(interaction.payload.promptId)) {
            isPermissionPromptAnswer = true;
            break;
          }
        }
      }
    }

    // Store user message as frame (strip interaction tags for display - they're processed separately)
    // Keep raw content for interaction processing below
    let displayContent = stripInteractionTags(content);
    try {
      createUserMessageFrame({
        sessionId: parseInt(req.params.sessionId, 10),
        userId:    req.user.id,
        content:   displayContent,
        hidden:    isPermissionPromptAnswer,  // Hidden if it's a prompt answer
        targetIds: mentioned ? [`agent:${mentioned.agentId}`] : undefined,
      });
    } catch (frameError) {
      console.error('[Stream] Failed to create user message frame:', frameError.message);
      // Continue — message can still be processed even if frame storage fails
    }

    try {
      db.prepare('UPDATE sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.params.sessionId);
    } catch (dbError) {
      console.error('[Stream] Failed to update session timestamp:', dbError.message);
    }

    // Process any interactions in the user message (e.g., prompt updates)
    // User interactions are "secure" because they come directly from an authenticated user
    console.log('[Stream] User message content preview:', content.substring(0, 200));
    console.log('[Stream] User message has <interaction>:', content.includes('<interaction'));
    if (userInteractionBlock && userInteractionBlock.interactions.length > 0) {
      // Include senderId to mark these as authorized user interactions
      // This is secure because:
      // 1. This code path is only reached for user messages (not agent responses)
      // 2. req.user.id comes from authenticated session middleware
      // 3. detectInteractions() strips any sender_id that might have been in the message
      let interactionContext = {
        sessionId: req.params.sessionId,
        userId:    req.user.id,
        senderId:  req.user.id,  // Mark as authorized user interaction
        agentId:   session.agent_id,
        db,
      };
      console.log('[Stream] Executing user message interactions (authorized):', userInteractionBlock.interactions.length);
      let results = await executeInteractions(userInteractionBlock, interactionContext);
      console.log('[Stream] User interaction results:', JSON.stringify(results, null, 2));
    }

    // If this was a permission prompt answer, skip the agent turn entirely.
    // The interaction has been processed (the pending promise resolved), and
    // there's no need for the agent to respond to "Answering 1 prompt: allow_once".
    if (isPermissionPromptAnswer) {
      debug('Permission prompt answer — skipping agent turn');
      clearInterval(keepAliveInterval);
      sendEvent('message_complete', {
        messageId:  randomUUID(),
        sessionId:  req.params.sessionId,
        skipped:    true,
        reason:     'permission_prompt_answer',
      });
      res.end();
      return;
    }

    // =========================================================================
    // CONDITIONAL ABILITIES: Check if any abilities should activate
    // =========================================================================
    let conditionalResult = await checkConditionalAbilities({
      userMessage: content,
      sessionID:   parseInt(req.params.sessionId, 10),
    });

    if (conditionalResult.matched) {
      debug('Conditional abilities matched:', conditionalResult.instructions.length);

      // Format and inject instructions into the user message
      let conditionalInstructions = formatConditionalInstructions(conditionalResult.instructions);
      processedContent = `${processedContent}\n\n${conditionalInstructions}`;

      debug('Injected conditional instructions:', conditionalInstructions.slice(0, 200));
    }

    // Add user message to context (with process injection and conditional instructions)
    // Replace <interaction> tags with a note - the AI needs to know the interaction was
    // handled via IPC so it doesn't try to duplicate it (e.g., sending update_prompt again)
    let cleanedContent = replaceInteractionTagsWithNote(processedContent);
    messages.push({ role: 'user', content: cleanedContent });

    // Calculate estimated tokens for display
    let totalChars = 0;
    for (let message of messages) {
      let content = (typeof message.content === 'string') ? message.content : JSON.stringify(message.content);
      totalChars += content.length;
    }
    // Add system prompt length if present
    if (session.system_prompt) {
      totalChars += session.system_prompt.length;
    }
    // Rough estimate: ~4 chars per token for English
    let estimatedTokens = Math.ceil(totalChars / 4);

    // Send stream start event with token estimate
    let messageId = randomUUID();  // UUID for correlating SSE events during streaming
    let persistedMessageID = null;  // Database row ID, set when message is stored
    debug('Sending message_start event', { messageId, estimatedTokens });
    sendEvent('message_start', {
      messageId,
      sessionId:       req.params.sessionId,
      agentName:       session.agent_name,
      estimatedTokens: estimatedTokens,
      messageCount:    messages.length,
    });

    // Create streaming HML parser
    let parser           = createStreamParser();
    let fullContent      = '';
    let executedElements = [];
    let chunkCount       = 0;
    let permitBag        = createPermitBag();

    // Set up parser event handlers
    parser.on('text', (data) => {
      if (!aborted)
        sendEvent('text', { messageId, ...data });
    });

    // Track pending websearch elements by ID for matching start/complete
    let pendingWebsearches = new Map();

    parser.on('element_start', (data) => {
      if (aborted)
        return;

      // For websearch, send interaction_started immediately when opening tag detected
      if (data.type === 'websearch' && data.executable) {
        let interactionId = `websearch-${data.id}`;
        pendingWebsearches.set(data.id, { interactionId, startTime: Date.now() });

        console.log(`[Stream] Websearch opening tag detected, sending interaction_started`);

        // Get banner config from the websearch function's registration
        let bannerConfig = getFunctionBannerConfig('websearch');

        sendEvent('interaction_started', {
          messageId,
          interactionId:  interactionId,
          targetId:       '@system',
          targetProperty: 'websearch',
          payload:        { query: '...' }, // Query not known yet
          banner:         bannerConfig,     // Include banner config for frontend
        });

        // Force flush: write padding and drain the socket
        // The AI sends <websearch>query</websearch> in one chunk, so we need
        // to ensure this event reaches the client before element_complete fires
        res.write(':flush\n\n');
        if (res.socket && !res.socket.destroyed) {
          res.socket.uncork?.();
          // Explicitly drain by writing directly to socket
          res.socket.write('', 'utf8');
        }

        console.log(`[Stream] Flushed interaction_started for websearch`);
        return; // Don't send element_start for websearch - we use interaction events instead
      }

      sendEvent('element_start', { messageId, ...data });
    });

    parser.on('element_update', (data) => {
      if (aborted)
        return;
      // Skip element_update for websearch - we use interaction events instead
      if (data.type === 'websearch')
        return;
      sendEvent('element_update', { messageId, ...data });
    });

    parser.on('element_complete', async (data) => {
      console.log('[Stream] element_complete fired:', data.type, data.executable, data.content?.slice(0, 50));
      if (aborted)
        return;

      // Handle websearch specially - interaction_started was already sent in element_start
      if (data.type === 'websearch' && data.executable) {
        let query = data.content?.trim();
        let pending = pendingWebsearches.get(data.id);

        if (query && pending) {
          let t0 = pending.startTime;
          console.log(`[Stream] Websearch closing tag, query: "${query}", elapsed since start: ${Date.now() - t0}ms`);

          // Update the banner with the actual query (we sent "..." at element_start)
          sendEvent('interaction_update', {
            messageId,
            interactionId:  pending.interactionId,
            targetProperty: 'websearch',
            payload:        { query },
          });
          console.log(`[Stream] T+${Date.now() - t0}ms: interaction_update sent with query`);

          // Yield to event loop to allow events to flush to client
          // This is needed because AI sends <websearch>query</websearch> in one chunk
          await new Promise(resolve => setImmediate(resolve));
          console.log(`[Stream] T+${Date.now() - t0}ms: Yielded event loop`);

          // Permission gate: ALL execution flows through the permission engine.
          // The permission might auto-grant (if a rule exists), but execution
          // only happens AFTER the permission engine has decided.
          let sessionIdInt = parseInt(req.params.sessionId, 10);
          let permSubject  = { type: 'agent', id: session.agent_id, name: session.agent_name || `Agent #${session.agent_id}` };
          let permResource = { type: 'tool', name: 'websearch' };
          let permContext   = { sessionId: sessionIdInt, ownerId: req.user.id };
          let db = getDatabase();

          // Check permit bag first — if already granted this request, skip permission engine
          let bagGrant = checkPermitBag(permitBag, permSubject, permResource);
          if (bagGrant) {
            console.log(`[Stream] T+${Date.now() - t0}ms: Websearch permitted by permit bag`);
          } else {
            let permResult;
            try {
              permResult = evaluatePermission(permSubject, permResource, permContext, db);
            } catch (permError) {
              console.error('[Stream] Permission evaluation error for websearch:', permError.message);
              permResult = { action: PermissionAction.DENY };
            }

            console.log(`[Stream] T+${Date.now() - t0}ms: Permission check for websearch: ${permResult.action}`);

            if (permResult.action === PermissionAction.DENY) {
              sendEvent('interaction_result', {
                messageId,
                interactionId:  pending.interactionId,
                targetProperty: 'websearch',
                status:         'denied',
                result:         { error: 'Websearch denied by permission rule' },
              });
              pendingWebsearches.delete(data.id);
              return;
            }

            if (permResult.action === PermissionAction.PROMPT) {
              console.log(`[Stream] T+${Date.now() - t0}ms: Requesting permission for websearch`);
              let promptResult = await requestPermissionPrompt(permSubject, permResource, {
                sessionId: sessionIdInt,
                userId:    req.user.id,
                db:        db,
              }, 0, { query });

              if (promptResult.action === PermissionAction.DENY) {
                console.log(`[Stream] T+${Date.now() - t0}ms: Websearch denied by user`);
                sendEvent('interaction_result', {
                  messageId,
                  interactionId:  pending.interactionId,
                  targetProperty: 'websearch',
                  status:         'denied',
                  result:         { error: `Websearch denied: ${promptResult.reason || 'User denied'}` },
                });
                pendingWebsearches.delete(data.id);
                return;
              }
              console.log(`[Stream] T+${Date.now() - t0}ms: Websearch permitted by user`);

              // Record grant in permit bag so interaction loop doesn't re-prompt
              recordPermitBagGrant(permitBag, permSubject, permResource);
            }
          }

          // Permission granted (allow rule, or user approved) — execute websearch
          let result = await searchWeb(query);
          console.log(`[Stream] T+${Date.now() - t0}ms: searchWeb completed`);

          // Send interaction_result
          sendEvent('interaction_result', {
            messageId,
            interactionId:  pending.interactionId,
            targetProperty: 'websearch',
            status:         'completed',
            result:         result,
          });
          console.log(`[Stream] T+${Date.now() - t0}ms: interaction_result event sent`);

          executedElements.push({
            element: data,
            result:  result,
          });

          pendingWebsearches.delete(data.id);
        }
        return; // Don't send element_complete for websearch
      }

      sendEvent('element_complete', { messageId, ...data });

      // Execute if executable (websearch already handled above)
      if (data.executable) {
        try {
          // For other executable elements, use pipeline
          let context = buildContext({
            req,
            sessionId: req.params.sessionId,
            dataKey:   dataKey,
            messageId: messageId,
          });

          // Convert element to assertion format
          let assertion = elementToAssertion(data);

          if (assertion) {
            sendEvent('element_executing', {
              messageId,
              id:   data.id,
              type: data.type,
            });

            let pipelineResult = await executePipeline({
              mode:       'sequential',
              assertions: [assertion],
            }, context);

            let result = pipelineResult.results?.[0] || null;

            sendEvent('element_result', {
              messageId,
              id:     data.id,
              type:   data.type,
              result: result,
            });

            executedElements.push({
              element: data,
              result:  result,
            });
          }
        } catch (error) {
          sendEvent('element_error', {
            messageId,
            id:    data.id,
            type:  data.type,
            error: error.message,
          });
        }
      }
    });

    parser.on('element_error', (data) => {
      if (!aborted)
        sendEvent('element_error', { messageId, ...data });
    });

    // Stream from agent
    debug('Starting agent stream', { messageCount: messages.length, aborted });

    // Check if already aborted before starting
    if (aborted) {
      debug('Request already aborted before stream started');
      clearInterval(keepAliveInterval);
      res.end();
      return;
    }

    // Send a progress event to keep connection alive while waiting for API
    sendEvent('stream_connecting', {
      messageId,
      status: 'connecting_to_ai',
    });

    // Send an immediate heartbeat before the async API call
    debug('Sending pre-API heartbeat');
    res.write(':pre-api\n\n');

    // Heartbeat to keep connection alive during API call (API connection may take 1-2 seconds)
    let apiHeartbeat = setInterval(() => {
      debug('API heartbeat tick', { aborted });
      if (!aborted) {
        res.write(':heartbeat\n\n');
      }
    }, 1000); // Every second

    debug('Entering agent stream');

    try {
      for await (let chunk of agent.sendMessageStream(messages, { signal: abortController.signal })) {
        // Clear heartbeat once we start receiving chunks
        if (apiHeartbeat) {
          clearInterval(apiHeartbeat);
          apiHeartbeat = null;
        }
        if (aborted) {
          debug('Aborted, breaking stream loop');
          break;
        }

        chunkCount++;

        if (chunk.type === 'text') {
          debug(`Chunk #${chunkCount}: text`, { length: chunk.text.length });
          fullContent += chunk.text;
          parser.write(chunk.text);
        } else if (chunk.type === 'tool_use_start') {
          debug(`Chunk #${chunkCount}: tool_use_start`, chunk);
          sendEvent('tool_use_start', { messageId, ...chunk });
        } else if (chunk.type === 'tool_use_input') {
          debug(`Chunk #${chunkCount}: tool_use_input`);
          sendEvent('tool_use_input', { messageId, ...chunk });
        } else if (chunk.type === 'tool_result') {
          debug(`Chunk #${chunkCount}: tool_result`);
          sendEvent('tool_result', { messageId, ...chunk });
        } else if (chunk.type === 'usage') {
          debug(`Chunk #${chunkCount}: usage`, chunk);

          // Include cache statistics in event
          sendEvent('usage', {
            messageId,
            input_tokens:                 chunk.input_tokens,
            output_tokens:                chunk.output_tokens,
            cache_creation_input_tokens:  chunk.cache_creation_input_tokens || 0,
            cache_read_input_tokens:      chunk.cache_read_input_tokens || 0,
          });

          // Calculate cost in cents with cache pricing
          // Sonnet 4 pricing: $3/1M input, $15/1M output
          // Cache reads: 10% of input price ($0.30/1M)
          // Cache writes: 125% of input price ($3.75/1M)
          let inputTokens      = chunk.input_tokens || 0;
          let outputTokens     = chunk.output_tokens || 0;
          let cacheReadTokens  = chunk.cache_read_input_tokens || 0;
          let cacheWriteTokens = chunk.cache_creation_input_tokens || 0;

          // Regular input tokens (not from cache)
          let regularInputTokens = inputTokens;
          let inputCost = regularInputTokens * (0.003 / 1000);  // $3 per 1M input tokens

          // Cache read tokens (90% discount)
          let cacheReadCost = cacheReadTokens * (0.0003 / 1000);  // $0.30 per 1M (10% of $3)

          // Cache write tokens (25% premium)
          let cacheWriteCost = cacheWriteTokens * (0.00375 / 1000);  // $3.75 per 1M (125% of $3)

          // Output tokens
          let outputCost = outputTokens * (0.015 / 1000);  // $15 per 1M output tokens

          let totalCost = inputCost + cacheReadCost + cacheWriteCost + outputCost;
          let costCents = Math.round(totalCost * 100);

          // Log cache savings
          if (cacheReadTokens > 0) {
            let savedCost = cacheReadTokens * (0.003 / 1000) * 0.9;  // 90% savings
            debug('Cache savings:', { cacheReadTokens, savedCents: Math.round(savedCost * 100) });
          }

          // Record charge in token_charges table
          // Note: message_id is NULL during streaming since the message isn't stored yet
          // The messageId variable is a UUID for SSE correlation, not a database ID
          db.prepare(`
            INSERT INTO token_charges (agent_id, session_id, message_id, input_tokens, output_tokens, cost_cents, charge_type)
            VALUES (?, ?, NULL, ?, ?, ?, 'usage')
          `).run(session.agent_id, req.params.sessionId, inputTokens + cacheReadTokens + cacheWriteTokens, outputTokens, costCents);

          // Also update session totals for backwards compatibility
          db.prepare(`
            UPDATE sessions
            SET input_tokens = input_tokens + ?,
                output_tokens = output_tokens + ?
            WHERE id = ?
          `).run(inputTokens + cacheReadTokens + cacheWriteTokens, outputTokens, req.params.sessionId);
        } else if (chunk.type === 'done') {
          debug(`Chunk #${chunkCount}: done`, { stopReason: chunk.stopReason });
          // End the parser
          parser.end();
        } else {
          debug(`Chunk #${chunkCount}: unknown type`, chunk);
        }
      }
      debug('Agent stream loop complete', { chunkCount, fullContentLength: fullContent.length });
    } catch (streamError) {
      console.error('Stream error from agent:', streamError);
      debug('Stream error:', streamError.message, streamError.stack);

      // Convert raw error to user-friendly message
      let errorMessage = getFriendlyErrorMessage(streamError.message);
      debug('Storing error message as frame');
      createAgentMessageFrame({
        sessionId: parseInt(req.params.sessionId, 10),
        userId:    req.user.id,
        agentId:   session.agent_id,
        content:   errorMessage,
        hidden:    false,
      });

      // Send error event to frontend
      sendEvent('error', {
        messageId,
        error: errorMessage,
      });

      // Mark that we've handled the error (don't send message_complete)
      aborted = true;
    } finally {
      // Clean up API heartbeat if still running
      if (apiHeartbeat) {
        clearInterval(apiHeartbeat);
        apiHeartbeat = null;
      }
    }

    // Always end the parser (handles any remaining buffered content)
    debug('Ending parser');
    parser.end();

    // =========================================================================
    // INTERACTION HANDLING: Detect and execute <interaction> tags
    // Implements an agentic loop that continues until Claude gives a final
    // response without interactions (or max iterations reached).
    // =========================================================================
    console.log('[Stream] Checking for interactions, aborted:', aborted, 'contentLength:', fullContent?.length);
    console.log('[Stream] Content preview:', fullContent?.slice(0, 500));
    console.log('[Stream] Has <interaction tag:', fullContent?.includes('<interaction'));
    console.log('[Stream] Has <websearch> tag:', fullContent?.includes('<websearch>'));
    if (!aborted && fullContent) {
      let interactionBlock = detectInteractions(fullContent);
      console.log('[Stream] detectInteractions result:', interactionBlock ? `found ${interactionBlock.interactions?.length} interactions` : 'none');

      if (interactionBlock) {
        // Build context for interaction execution
        let interactionContext = {
          sessionId: req.params.sessionId,
          userId:    req.user.id,
          agentId:   session.agent_id,
          agent:     { name: session.agent_name },
          dataKey:   dataKey,
          db:        getDatabase(),
          permitBag: permitBag,
        };

        // Agentic loop - continue until no more interactions or max iterations
        let maxIterations    = 15;
        let iteration        = 0;
        let currentContent   = fullContent;
        let currentBlock     = interactionBlock;
        // Track only the final response (not accumulated segments)
        // The initial response with interactions is stored as hidden, only the final is shown
        let finalContent     = null;

        while (currentBlock && iteration < maxIterations) {
          iteration++;

          // Filter out websearch interactions that were already executed by the stream parser
          if (executedElements.length > 0) {
            let executedQueries = new Set(
              executedElements
                .filter(e => e.element?.type === 'websearch')
                .map(e => e.element?.content?.trim())
            );

            if (executedQueries.size > 0) {
              currentBlock.interactions = currentBlock.interactions.filter(i => {
                if (i.target_property === 'websearch' && executedQueries.has(i.payload?.query)) {
                  console.log('[Stream] Skipping websearch interaction — already executed by stream parser');
                  return false;
                }
                return true;
              });

              if (currentBlock.interactions.length === 0) {
                currentBlock = null;
                continue;
              }
            }
          }

          debug(`Interaction loop iteration ${iteration}`, { count: currentBlock.interactions.length });
          debug(`Current content (first 200 chars):`, currentContent.slice(0, 200));

          // Send event to show interaction is being processed
          sendEvent('interaction_detected', {
            messageId,
            count:     currentBlock.interactions.length,
            iteration: iteration,
          });

          // Send interaction_started events RIGHT BEFORE execution
          // This ensures the "Pending" banner appears immediately when the action starts
          // Only functions with a banner config in their register() method will show banners
          for (let interaction of currentBlock.interactions) {
            // Get banner config from function's register() method (if it has one)
            let bannerConfig = getFunctionBannerConfig(interaction.target_property);
            console.log('[Stream] Sending interaction_started:', interaction.interaction_id, interaction.target_property, 'hasBanner:', !!bannerConfig);
            sendEvent('interaction_started', {
              messageId,
              interactionId:  interaction.interaction_id,
              targetId:       interaction.target_id,
              targetProperty: interaction.target_property,
              payload:        interaction.payload,
              banner:         bannerConfig,  // Include banner config (may be null)
            });
          }

          // Force flush to ensure events are sent immediately before blocking on execution
          res.write(':executing\n\n');
          if (res.flush) res.flush();

          // Decompose intermediate agent response into content + interaction segments.
          // Store each content segment as its own hidden frame.
          // Interaction segments are NOT stored here — they become REQUEST/RESULT
          // frames when executeInteractions() runs.
          let segments     = decomposeMessage(currentContent, 'assistant');
          let firstFrameId = null;

          for (let segment of segments) {
            if (segment.type === 'content') {
              let frame = createAgentMessageFrame({
                sessionId:     parseInt(req.params.sessionId, 10),
                userId:        req.user.id,
                agentId:       session.agent_id,
                content:       segment.text,
                hidden:        true,
                skipBroadcast: true,
              });
              if (!firstFrameId) firstFrameId = frame.id;
            }
          }

          // Fallback: if decomposition produced no content frames (all interactions),
          // create a minimal hidden frame so we still have a parentFrameId for REQUEST/RESULT linking
          if (!firstFrameId) {
            let fallbackFrame = createAgentMessageFrame({
              sessionId:     parseInt(req.params.sessionId, 10),
              userId:        req.user.id,
              agentId:       session.agent_id,
              content:       stripInteractionTags(currentContent) || '[interaction]',
              hidden:        true,
              skipBroadcast: true,
            });
            firstFrameId = fallbackFrame.id;
          }

          // Execute interactions with parent frame ID for REQUEST/RESULT frame creation
          interactionContext.parentFrameId = firstFrameId;
          let results = await executeInteractions(currentBlock, interactionContext);
          debug('Interaction results', { count: results.results.length });

          // Send interaction results to frontend
          for (let result of results.results) {
            sendEvent('interaction_result', {
              messageId,
              interactionId:  result.interaction_id,
              targetProperty: result.target_property,
              status:         result.status,
              result:         (result.status === 'completed') ? result.result : null,
              error:          (result.status === 'failed') ? result.error : null,
              reason:         (result.status === 'denied') ? result.reason : null,
            });
          }

          // Format results as feedback
          let feedback = formatInteractionFeedback(results);

          // Store feedback as hidden system frame
          createSystemMessageFrame({
            sessionId: parseInt(req.params.sessionId, 10),
            userId:    req.user.id,
            content:   feedback,
            hidden:    true,
          });

          // Add to message history (strip interaction tags so Claude sees clean context)
          // This prevents Claude from being confused by seeing its own <interaction> tags
          let cleanContentForHistory = stripInteractionTags(currentContent);
          messages.push({ role: 'assistant', content: cleanContentForHistory });
          messages.push({ role: 'user', content: feedback });

          debug('Getting next response from agent after interaction');
          sendEvent('interaction_continuing', { messageId, iteration });

          // Get next response from agent (with rate limit retry)
          let maxRetries   = 3;
          let retryCount   = 0;
          let gotResponse  = false;

          while (!gotResponse && retryCount < maxRetries) {
            try {
              let nextResponse = await agent.sendMessage(messages, {});
              let nextContent  = '';

              if (typeof nextResponse.content === 'string') {
                nextContent = nextResponse.content;
              } else if (Array.isArray(nextResponse.content)) {
                nextContent = nextResponse.content
                  .filter((block) => block.type === 'text')
                  .map((block) => block.text)
                  .join('');
              }

              debug('Next response received', { length: nextContent.length, iteration });
              debug('Next response content (first 300 chars):', nextContent.slice(0, 300));

              // Keep track of the clean content for final display
              // Only the last response (after all interactions complete) will be shown
              let cleanSegment = stripInteractionTags(nextContent);
              if (cleanSegment.trim()) {
                finalContent = cleanSegment;
              }

              // Check if this response also has interactions
              currentContent = nextContent;
              currentBlock   = detectInteractions(nextContent);
              debug('Has more interactions:', !!currentBlock);

              // If no more interactions, we're done
              if (!currentBlock) {
                debug('No more interactions, loop complete');
              }

              gotResponse = true;
            } catch (error) {
              // Check if it's a rate limit error (429)
              let isRateLimit = error.message?.includes('429') || error.message?.includes('rate_limit');

              if (isRateLimit && retryCount < maxRetries - 1) {
                retryCount++;
                let waitSeconds = 30;
                debug('Rate limit hit, waiting before retry', { retryCount, waitSeconds });
                // Just wait silently - frontend keeps showing "Processing..." spinner
                await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));
                debug('Retry wait complete, attempting again');
              } else {
                debug('Error getting next response:', error.message);
                let friendlyError = getFriendlyErrorMessage(error.message);
                sendEvent('interaction_error', { messageId, error: friendlyError });
                currentBlock = null; // Exit loop on error
                gotResponse  = true; // Exit retry loop
              }
            }
          }
        }

        if (iteration >= maxIterations) {
          debug('Max interaction iterations reached');
          sendEvent('interaction_max_reached', { messageId, iterations: iteration });
        }

        // Use the final response content (after all interactions complete)
        // If no follow-up response was received, fall back to stripped initial content
        let cleanFinalContent = finalContent || stripInteractionTags(fullContent);

        // Strip any leaked interaction feedback format ([@target:method] interaction_id=...)
        // This can happen if Claude echoes the feedback in its response
        cleanFinalContent = cleanFinalContent.replace(/\[@[^\]]+\]\s*interaction_id='[^']+'\s*(status:|completed:|failed:|denied:)[^\n]*(\n\{[\s\S]*?\n\})?/g, '').trim();

        // Clean up extra whitespace
        cleanFinalContent = cleanFinalContent.replace(/\n{3,}/g, '\n\n').trim();

        // Decompose the final clean response and store each content segment
        // as a visible frame. This gives API consumers finer-grained frames.
        if (cleanFinalContent.trim()) {
          let finalSegments = decomposeMessage(cleanFinalContent, 'assistant');
          for (let segment of finalSegments) {
            if (segment.type === 'content') {
              let storedFrame = createAgentMessageFrame({
                sessionId:     parseInt(req.params.sessionId, 10),
                userId:        req.user.id,
                agentId:       session.agent_id,
                content:       segment.text,
                hidden:        false,
              });
              if (!persistedMessageID) persistedMessageID = storedFrame.id;
            }
          }

          // Fallback: if no content segments (shouldn't happen after cleaning),
          // store the full content as one frame
          if (!persistedMessageID) {
            let storedFrame = createAgentMessageFrame({
              sessionId:     parseInt(req.params.sessionId, 10),
              userId:        req.user.id,
              agentId:       session.agent_id,
              content:       cleanFinalContent,
              hidden:        false,
            });
            persistedMessageID = storedFrame.id;
          }
          debug('Stored interaction response with frame ID:', persistedMessageID);
        }

        // Update fullContent for the message_complete event
        fullContent = cleanFinalContent;

        // Send the final content to frontend
        sendEvent('interaction_complete', {
          messageId,
          content:    cleanFinalContent,
          iterations: iteration,
        });

      } else {
        // Run AFTER_AGENT_RESPONSE hook (plugins can modify final content)
        try {
          let hookResult = await afterAgentResponse(
            { content: fullContent, agentId: session.agent_id },
            { sessionId: parseInt(req.params.sessionId, 10), userId: req.user.id },
          );
          if (hookResult && typeof hookResult.content === 'string')
            fullContent = hookResult.content;
        } catch (error) {
          debug('afterAgentResponse hook error:', error.message);
        }

        // No interactions - store as frame
        debug('Storing assistant response as frame', { length: fullContent.length });
        let storedFrame = createAgentMessageFrame({
          sessionId:     parseInt(req.params.sessionId, 10),
          userId:        req.user.id,
          agentId:       session.agent_id,
          content:       fullContent,
          hidden:        false,
          // Broadcast via WebSocket so kikx-chat receives the frame
        });
        persistedMessageID = storedFrame.id;
        debug('Stored message with frame ID:', persistedMessageID);
      }
    } else if (!aborted && !fullContent) {
      // No content received - store an error message so user knows what happened
      console.warn('[Stream] Warning: Agent returned no content', {
        sessionId:  req.params.sessionId,
        messageId:  messageId,
        chunkCount: chunkCount,
      });
      debug('Agent returned no content - storing error message');

      let errorMessage = 'The agent did not return a response. This may indicate an API issue or rate limiting.';
      createAgentMessageFrame({
        sessionId: parseInt(req.params.sessionId, 10),
        userId:    req.user.id,
        agentId:   session.agent_id,
        content:   errorMessage,
        hidden:    false,
      });

      sendEvent('error', {
        messageId,
        error: errorMessage,
      });

      // Mark as handled so we don't send message_complete
      aborted = true;
    } else {
      debug('Not storing response', { aborted, hasContent: !!fullContent });
    }

    // Always send message_complete so frontend can finalize
    if (!aborted) {
      // If no content, include a warning
      if (!fullContent) {
        debug('Sending message_complete with empty content warning');
        sendEvent('message_complete', {
          messageId,
          content:          '',
          executedElements: executedElements.length,
          warning:          'Agent returned no content',
        });
      } else {
        debug('Sending message_complete', { contentLength: fullContent.length, executedElements: executedElements.length, persistedMessageID });
        sendEvent('message_complete', {
          messageId,
          persistedMessageID,  // The actual database row ID for persistence
          content:          fullContent,
          executedElements: executedElements.length,
        });
      }
    }

    // Check if compaction is needed (debounced)
    if (!aborted && fullContent) {
      checkCompaction(req.params.sessionId, req.user.id, agent).then((result) => {
        if (result.success) {
          debug('Compaction completed', result);
        } else if (result.debounced) {
          debug('Compaction debounced');
        }
      }).catch((error) => {
        console.error('[Stream] Compaction check error:', error);
      });
    }

    // End SSE stream - add small delay to ensure all events are flushed to client
    debug('Ending SSE stream');
    clearInterval(keepAliveInterval);

    // Small delay to ensure final events are transmitted before connection closes
    await new Promise((resolve) => setTimeout(resolve, 100));

    res.end();
  } catch (error) {
    console.error('Stream error:', error);
    debug('Outer catch error:', error.message, error.stack);
    clearInterval(keepAliveInterval);

    // Store error message as frame so it persists
    let errorMessage = getFriendlyErrorMessage(error.message);
    try {
      createAgentMessageFrame({
        sessionId: parseInt(req.params.sessionId, 10),
        userId:    req.user.id,
        agentId:   session?.agent_id,  // session may not be defined in outer catch
        content:   errorMessage,
        hidden:    false,
      });
    } catch (frameError) {
      console.error('Failed to store error frame:', frameError);
    }

    sendEvent('error', { error: errorMessage });
    res.end();
  }
});

export default router;
