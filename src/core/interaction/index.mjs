'use strict';

import { EventEmitter } from 'node:events';
import XID               from 'xid-js';

// =============================================================================
// InteractionLoop
// =============================================================================
// The interaction kernel that drives agent-kernel communication via async
// generators. Manages the lifecycle of interactions: starting, iterating
// agent blocks, handling tool calls, permission hard-breaks, message
// queuing, and cancellation.
//
// Dependencies are obtained from the CascadingContext:
//   - SessionManager, FramePersistence, ContentSanitizer
//
// Event emission:
//   - 'frame'              — new frame created (for transport)
//   - 'interaction:start'  — interaction started
//   - 'interaction:end'    — interaction ended
//   - 'permission:request' — permission approval needed
// =============================================================================

function generateID(prefix) {
  return `${prefix}${XID.next()}`;
}

export class InteractionLoop extends EventEmitter {
  constructor(context) {
    super();

    if (!context)
      throw new Error('InteractionLoop requires a CascadingContext');

    this._context = context;

    // Active interactions: sessionID -> { generator, interactionID, params }
    this._active = new Map();

    // Message queues: sessionID -> string[]
    this._queues = new Map();

    // Permission waiting: sessionID -> { frameID, params }
    this._permissionWaiting = new Map();
  }

  // ---------------------------------------------------------------------------
  // Accessors — resolve dependencies lazily from context
  // ---------------------------------------------------------------------------

  _getSessionManager() {
    return this._context.getProperty('sessionManager');
  }

  _getFramePersistence() {
    return this._context.getProperty('framePersistence');
  }

  _getContentSanitizer() {
    return this._context.getProperty('contentSanitizer');
  }

  // ---------------------------------------------------------------------------
  // startInteraction
  // ---------------------------------------------------------------------------
  // Main entry point. Starts a new interaction for a session.
  //
  // params:
  //   agentPlugin          — AgentInterface instance
  //   agent                — agent record (name, instructions, etc.)
  //   userMessage          — the user's text input
  //   replayFromPermission — if true, skip creating a user-message frame
  //   checkPermission      — async (toolName, args) => boolean
  //   executeTool          — async (toolName, args) => result
  //   authorType           — author type for user message frame (default 'user')
  //   authorID             — author ID for user message frame
  // ---------------------------------------------------------------------------

  async startInteraction(sessionID, params = {}) {
    if (!sessionID)
      throw new Error('sessionID is required');

    // If already running an interaction for this session, queue the message
    if (this._active.has(sessionID)) {
      if (params.userMessage)
        this.queueMessage(sessionID, params.userMessage);

      return null;
    }

    let framePersistence = this._getFramePersistence();
    let interactionID    = generateID('int_');
    let startOrder       = await framePersistence.getNextOrder(sessionID);
    let order            = startOrder;

    // Create user message frame (unless replaying from permission approval)
    if (params.userMessage && !params.replayFromPermission) {
      let userFrameID = generateID('frm_');
      let userFrame   = {
        id:            userFrameID,
        type:          'user-message',
        content:       { text: params.userMessage },
        order:         order++,
        timestamp:     Date.now(),
        interactionID,
        authorType:    params.authorType || 'user',
        authorID:      params.authorID || null,
        hidden:        false,
        deleted:       false,
        processed:     false,
      };

      await framePersistence.saveFrames(sessionID, [userFrame]);
      this.emit('frame', { sessionID, frame: userFrame });
    }

    // Build message history from existing frames for the agent
    let sessionManager = this._getSessionManager();
    let frameManager   = sessionManager.getFrameManager(sessionID);

    // Load persisted frames into the frame manager
    await framePersistence.loadFramesInto(frameManager, sessionID);

    let allFrames = frameManager.toArray();
    let messages  = this._buildMessages(allFrames);

    // Get session record
    let session = await sessionManager.getSession(sessionID);

    // Execute the agent
    let generator = await params.agentPlugin.execute({
      messages,
      agent:   params.agent,
      session,
      context: this._context,
    });

    // Track the active interaction
    this._active.set(sessionID, {
      generator,
      interactionID,
      params,
    });

    this.emit('interaction:start', { sessionID, interactionID });

    // Iterate the generator
    await this._iterateGenerator(sessionID, generator, interactionID, order, params);

    return interactionID;
  }

  // ---------------------------------------------------------------------------
  // _iterateGenerator — the kernel loop
  // ---------------------------------------------------------------------------

  async _iterateGenerator(sessionID, generator, interactionID, startOrder, params) {
    let framePersistence = this._getFramePersistence();
    let sanitizer        = this._getContentSanitizer();
    let order            = startOrder;
    let result;

    try {
      while (true) {
        let { value: block, done } = await generator.next(result);
        result = undefined;

        if (done || !block)
          break;

        if (block.type === 'done')
          break;

        // Assign metadata to the block
        let frameID   = generateID('frm_');
        let timestamp = Date.now();

        if (block.type === 'message') {
          // Sanitize HTML content
          let html = block.content && block.content.html;
          if (html && sanitizer)
            html = sanitizer.sanitize(html);

          let frame = {
            id:            frameID,
            type:          'message',
            content:       { html },
            order:         order++,
            timestamp,
            interactionID,
            authorType:    block.authorType || 'agent',
            authorID:      block.authorID || null,
            hidden:        false,
            deleted:       false,
            processed:     false,
          };

          await framePersistence.saveFrames(sessionID, [frame]);
          this.emit('frame', { sessionID, frame });
        } else if (block.type === 'tool-call') {
          // Check if permission is needed
          let checkPermission = params.checkPermission;
          let needsPermission = false;

          if (typeof checkPermission === 'function')
            needsPermission = await checkPermission(block.content.toolName, block.content.arguments);

          if (needsPermission) {
            // Permission hard-break
            await this._permissionHardBreak(sessionID, generator, block, interactionID, order, params);
            return; // interaction ends here
          }

          // No permission needed — execute the tool
          let toolCallFrame = {
            id:            frameID,
            type:          'tool-call',
            content:       { toolName: block.content.toolName, arguments: block.content.arguments },
            order:         order++,
            timestamp,
            interactionID,
            authorType:    block.authorType || 'agent',
            authorID:      block.authorID || null,
            hidden:        false,
            deleted:       false,
            processed:     false,
          };

          await framePersistence.saveFrames(sessionID, [toolCallFrame]);
          this.emit('frame', { sessionID, frame: toolCallFrame });

          let executeTool = params.executeTool;
          let toolOutput  = '';

          if (typeof executeTool === 'function')
            toolOutput = await executeTool(block.content.toolName, block.content.arguments);

          // Save tool-result frame
          let resultFrameID = generateID('frm_');
          let toolResultFrame = {
            id:            resultFrameID,
            type:          'tool-result',
            content:       { output: toolOutput },
            order:         order++,
            timestamp:     Date.now(),
            interactionID,
            authorType:    'system',
            authorID:      null,
            hidden:        false,
            deleted:       false,
            processed:     false,
          };

          await framePersistence.saveFrames(sessionID, [toolResultFrame]);
          this.emit('frame', { sessionID, frame: toolResultFrame });

          // Pass result back to generator
          result = { type: 'tool-result', content: { output: toolOutput } };
        } else if (block.type === 'reflection') {
          let frame = {
            id:            frameID,
            type:          'reflection',
            content:       block.content,
            order:         order++,
            timestamp,
            interactionID,
            authorType:    block.authorType || 'agent',
            authorID:      block.authorID || null,
            hidden:        true,
            deleted:       false,
            processed:     false,
          };

          await framePersistence.saveFrames(sessionID, [frame]);
          this.emit('frame', { sessionID, frame });
        }
      }
    } catch (error) {
      // Store error frame
      let errorFrame = {
        id:            generateID('frm_'),
        type:          'error',
        content:       { message: error.message },
        order:         order++,
        timestamp:     Date.now(),
        interactionID,
        authorType:    'system',
        authorID:      null,
        hidden:        false,
        deleted:       false,
        processed:     false,
      };

      await framePersistence.saveFrames(sessionID, [errorFrame]);
      this.emit('frame', { sessionID, frame: errorFrame });
    } finally {
      // Clean up active interaction
      this._active.delete(sessionID);
      this.emit('interaction:end', { sessionID, interactionID });

      // Drain queue if there are pending messages
      await this._drainQueue(sessionID, params);
    }
  }

  // ---------------------------------------------------------------------------
  // _permissionHardBreak
  // ---------------------------------------------------------------------------
  // When an agent hits a tool that needs permission approval:
  //   1. Persist pending-action frame (tool name, arguments, context)
  //   2. Create permission-request frame
  //   3. Destroy the generator
  //   4. Mark interaction as waiting for permission
  // ---------------------------------------------------------------------------

  async _permissionHardBreak(sessionID, generator, block, interactionID, order, params) {
    let framePersistence = this._getFramePersistence();

    // 1. Persist pending-action frame
    let pendingFrameID = generateID('frm_');
    let pendingFrame   = {
      id:            pendingFrameID,
      type:          'pending-action',
      content:       { toolName: block.content.toolName, arguments: block.content.arguments },
      order:         order++,
      timestamp:     Date.now(),
      interactionID,
      authorType:    block.authorType || 'agent',
      authorID:      block.authorID || null,
      hidden:        false,
      deleted:       false,
      processed:     false,
    };

    await framePersistence.saveFrames(sessionID, [pendingFrame]);
    this.emit('frame', { sessionID, frame: pendingFrame });

    // 2. Create permission-request frame
    let requestFrameID = generateID('frm_');
    let requestFrame   = {
      id:            requestFrameID,
      type:          'permission-request',
      content:       { toolName: block.content.toolName, arguments: block.content.arguments, pendingFrameID },
      order:         order++,
      timestamp:     Date.now(),
      interactionID,
      authorType:    'system',
      authorID:      null,
      hidden:        false,
      deleted:       false,
      processed:     false,
    };

    await framePersistence.saveFrames(sessionID, [requestFrame]);
    this.emit('frame', { sessionID, frame: requestFrame });
    this.emit('permission:request', { sessionID, frameID: pendingFrameID, requestFrameID, toolName: block.content.toolName });

    // 3. Destroy the generator
    await generator.return();

    // 4. Store permission-waiting state
    this._permissionWaiting.set(sessionID, {
      pendingFrameID,
      requestFrameID,
      interactionID,
      params,
    });

    // Clean up active interaction
    this._active.delete(sessionID);
    this.emit('interaction:end', { sessionID, interactionID });
  }

  // ---------------------------------------------------------------------------
  // cancelInteraction
  // ---------------------------------------------------------------------------
  // Cancels the currently running interaction for a session.
  // Returns queued messages (if any) so the caller can place them in the input.
  // ---------------------------------------------------------------------------

  async cancelInteraction(sessionID) {
    let active = this._active.get(sessionID);
    if (!active)
      return null;

    // Destroy the generator
    await active.generator.return();

    // Clean up
    this._active.delete(sessionID);
    this.emit('interaction:end', { sessionID, interactionID: active.interactionID });

    // Return and clear queued messages
    let queued = this._queues.get(sessionID) || [];
    this._queues.delete(sessionID);

    return queued.length > 0 ? queued.join('\n\n') : null;
  }

  // ---------------------------------------------------------------------------
  // approvePermission
  // ---------------------------------------------------------------------------
  // After the user approves a permission request:
  //   1. Load the pending-action frame
  //   2. Execute the tool
  //   3. Store result frame
  //   4. Mark frames as processed
  //   5. Start NEW interaction with replayFromPermission flag
  // ---------------------------------------------------------------------------

  async approvePermission(sessionID, frameID) {
    let waiting = this._permissionWaiting.get(sessionID);
    if (!waiting)
      throw new Error(`No pending permission for session: ${sessionID}`);

    let framePersistence = this._getFramePersistence();
    let { Frame }        = this._context.getProperty('models');

    // Load the pending-action frame
    let pendingRecord = await Frame.where.id.EQ(frameID || waiting.pendingFrameID).first();
    if (!pendingRecord)
      throw new Error(`Pending action frame not found: ${frameID || waiting.pendingFrameID}`);

    let content = pendingRecord.getContent();

    // Execute the tool
    let executeTool = waiting.params.executeTool;
    let toolOutput  = '';

    if (typeof executeTool === 'function')
      toolOutput = await executeTool(content.toolName, content.arguments);

    // Store tool-result frame
    let nextOrder     = await framePersistence.getNextOrder(sessionID);
    let resultFrameID = generateID('frm_');
    let resultFrame   = {
      id:            resultFrameID,
      type:          'tool-result',
      content:       { output: toolOutput },
      order:         nextOrder,
      timestamp:     Date.now(),
      interactionID: waiting.interactionID,
      authorType:    'system',
      authorID:      null,
      hidden:        false,
      deleted:       false,
      processed:     false,
    };

    await framePersistence.saveFrames(sessionID, [resultFrame]);
    this.emit('frame', { sessionID, frame: resultFrame });

    // Mark pending-action and permission-request as processed
    pendingRecord.processed   = true;
    pendingRecord.processedAt = Date.now();
    await pendingRecord.save();

    if (waiting.requestFrameID) {
      let requestRecord = await Frame.where.id.EQ(waiting.requestFrameID).first();
      if (requestRecord) {
        requestRecord.processed   = true;
        requestRecord.processedAt = Date.now();
        await requestRecord.save();
      }
    }

    // Clear permission-waiting state
    this._permissionWaiting.delete(sessionID);

    // Start NEW interaction with replay flag
    let newParams = {
      ...waiting.params,
      replayFromPermission: true,
    };

    return await this.startInteraction(sessionID, newParams);
  }

  // ---------------------------------------------------------------------------
  // denyPermission
  // ---------------------------------------------------------------------------
  // User denies a permission request:
  //   1. Mark pending-action frame as processed
  //   2. Store denial frame
  // ---------------------------------------------------------------------------

  async denyPermission(sessionID, frameID) {
    let waiting = this._permissionWaiting.get(sessionID);
    if (!waiting)
      throw new Error(`No pending permission for session: ${sessionID}`);

    let framePersistence = this._getFramePersistence();
    let { Frame }        = this._context.getProperty('models');

    // Mark pending-action frame as processed
    let pendingRecord = await Frame.where.id.EQ(frameID || waiting.pendingFrameID).first();
    if (pendingRecord) {
      pendingRecord.processed   = true;
      pendingRecord.processedAt = Date.now();
      await pendingRecord.save();
    }

    // Store denial frame
    let nextOrder   = await framePersistence.getNextOrder(sessionID);
    let denialFrame = {
      id:            generateID('frm_'),
      type:          'permission-denied',
      content:       { pendingFrameID: frameID || waiting.pendingFrameID },
      order:         nextOrder,
      timestamp:     Date.now(),
      interactionID: waiting.interactionID,
      authorType:    'user',
      authorID:      null,
      hidden:        false,
      deleted:       false,
      processed:     false,
    };

    await framePersistence.saveFrames(sessionID, [denialFrame]);
    this.emit('frame', { sessionID, frame: denialFrame });

    // Clear permission-waiting state
    this._permissionWaiting.delete(sessionID);
  }

  // ---------------------------------------------------------------------------
  // Message Queue
  // ---------------------------------------------------------------------------

  queueMessage(sessionID, text) {
    if (!this._queues.has(sessionID))
      this._queues.set(sessionID, []);

    this._queues.get(sessionID).push(text);
  }

  async _drainQueue(sessionID, params) {
    let queue = this._queues.get(sessionID);
    if (!queue || queue.length === 0)
      return;

    // Concatenate all queued messages
    let combinedMessage = queue.join('\n\n');
    this._queues.delete(sessionID);

    // Start a new interaction with the combined message
    let newParams = {
      ...params,
      userMessage:          combinedMessage,
      replayFromPermission: false,
    };

    await this.startInteraction(sessionID, newParams);
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  _buildMessages(frames) {
    let messages = [];

    for (let frame of frames) {
      let type = frame.type;

      if (type === 'user-message') {
        let content = frame.content || {};
        messages.push({ role: 'user', content: content.text || '' });
      } else if (type === 'message') {
        let content = frame.content || {};
        messages.push({ role: 'assistant', content: content.html || '' });
      } else if (type === 'tool-call') {
        let content = frame.content || {};
        messages.push({ role: 'assistant', type: 'tool-call', content });
      } else if (type === 'tool-result') {
        let content = frame.content || {};
        messages.push({ role: 'tool', content: content.output || '' });
      }
      // Skip reflection, pending-action, permission-request, etc.
    }

    return messages;
  }

  // ---------------------------------------------------------------------------
  // State Queries
  // ---------------------------------------------------------------------------

  isActive(sessionID) {
    return this._active.has(sessionID);
  }

  isWaitingForPermission(sessionID) {
    return this._permissionWaiting.has(sessionID);
  }

  getQueuedMessages(sessionID) {
    return this._queues.get(sessionID) || [];
  }
}
