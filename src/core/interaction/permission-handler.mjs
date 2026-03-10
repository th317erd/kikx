'use strict';

import XID                    from 'xid-js';
import { parseShellCommands } from '../internal-plugins/shell/command-parser.mjs';

// =============================================================================
// PermissionHandler
// =============================================================================
// Manages the permission lifecycle for tool calls during agent interactions:
//   - Permission hard-break (pause interaction, ask user)
//   - Approve (execute tool, resume with replay)
//   - Deny (store denial, resume with replay)
//
// Extracted from InteractionLoop to reduce file size.
// =============================================================================

function generateID(prefix) {
  return `${prefix}${XID.next()}`;
}

export class PermissionHandler {
  constructor(loop) {
    this._loop = loop;
  }

  // ---------------------------------------------------------------------------
  // hardBreak — pause interaction for permission approval
  // ---------------------------------------------------------------------------

  async hardBreak(sessionID, generator, block, interactionID, params, frameManager) {
    let loop = this._loop;

    // 1. Persist pending-action frame
    let pendingFrameID = generateID('frm_');
    let pendingFrame   = {
      id:            pendingFrameID,
      type:          'pending-action',
      content:       { toolName: block.content.toolName, arguments: block.content.arguments, toolUseID: block.content.toolUseID },
      timestamp:     Date.now(),
      interactionID,
      authorType:    block.authorType || 'agent',
      authorID:      block.authorID || null,
      hidden:        false,
      deleted:       false,
      processed:     false,
    };

    await loop._createFrame(sessionID, pendingFrame, frameManager, {
      authorType: block.authorType || 'agent',
      authorID:   block.authorID || null,
    });

    // 2. Create permission-request frame
    // For shell:execute, include per-command data for the permission UI.
    // Prefer _parsedCommands (enriched with status by checkPermission callback),
    // fall back to fresh parse for contexts without per-command checking.
    let toolArgs       = block.content.arguments || {};
    let parsedCommands = toolArgs._parsedCommands || null;

    if (!parsedCommands && block.content.toolName === 'shell:execute' && toolArgs.command)
      parsedCommands = parseShellCommands(toolArgs.command);

    let requestFrameID = generateID('frm_');
    let requestContent = { toolName: block.content.toolName, arguments: block.content.arguments, pendingFrameID };

    if (parsedCommands && parsedCommands.length > 0)
      requestContent.parsedCommands = parsedCommands;

    let requestFrame = {
      id:            requestFrameID,
      type:          'permission-request',
      content:       requestContent,
      timestamp:     Date.now(),
      interactionID,
      authorType:    'system',
      authorID:      null,
      hidden:        false,
      deleted:       false,
      processed:     false,
    };

    await loop._createFrame(sessionID, requestFrame, frameManager, { authorType: 'system' });
    loop.emit('permission:request', { sessionID, frameID: pendingFrameID, requestFrameID, toolName: block.content.toolName });

    // 3. Destroy the generator
    await generator.return();

    // 4. Store permission-waiting state (includes frameManager for approve/deny)
    loop._permissionWaiting.set(sessionID, {
      pendingFrameID,
      requestFrameID,
      interactionID,
      params,
      frameManager,
    });

    // Clean up active interaction
    loop._active.delete(sessionID);
    loop.emit('interaction:end', { sessionID, interactionID, agentID: null });
  }

  // ---------------------------------------------------------------------------
  // approve — user approved a pending permission request
  // ---------------------------------------------------------------------------

  async approve(sessionID, frameID) {
    let loop    = this._loop;
    let waiting = loop._permissionWaiting.get(sessionID);

    if (!waiting)
      throw new Error(`No pending permission for session: ${sessionID}`);

    let { Frame } = loop._context.getProperty('models');

    // Load the pending-action frame (always use the stored pending frame ID,
    // not the frameID parameter which may be the permission-request frame)
    let pendingRecord = await Frame.where.id.EQ(waiting.pendingFrameID).first();
    if (!pendingRecord)
      throw new Error(`Pending action frame not found: ${frameID || waiting.pendingFrameID}`);

    let content = pendingRecord.getContent();

    // Execute the tool
    let executeTool = waiting.params.executeTool;
    let toolOutput  = '';

    if (typeof executeTool === 'function')
      toolOutput = await executeTool(content.toolName, content.arguments);

    // Store tool-result frame via FrameManager (use waiting.frameManager if available)
    let approveFrameManager = waiting.frameManager || null;
    let resultFrameID       = generateID('frm_');

    await loop._createFrame(sessionID, {
      id:            resultFrameID,
      type:          'tool-result',
      content:       { output: toolOutput, toolUseID: content.toolUseID },
      timestamp:     Date.now(),
      interactionID: waiting.interactionID,
      authorType:    'system',
      authorID:      null,
      hidden:        false,
      deleted:       false,
      processed:     false,
    }, approveFrameManager, { authorType: 'system' });

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
    loop._permissionWaiting.delete(sessionID);

    // Start NEW interaction with replay flag
    let newParams = {
      ...waiting.params,
      replayFromPermission: true,
    };

    return await loop.startInteraction(sessionID, newParams);
  }

  // ---------------------------------------------------------------------------
  // deny — user denied a pending permission request
  // ---------------------------------------------------------------------------

  async deny(sessionID, frameID) {
    let loop    = this._loop;
    let waiting = loop._permissionWaiting.get(sessionID);

    if (!waiting)
      throw new Error(`No pending permission for session: ${sessionID}`);

    let { Frame } = loop._context.getProperty('models');

    // Mark pending-action frame as processed (always use stored ID, not the
    // frameID parameter which may be the permission-request frame)
    let pendingRecord = await Frame.where.id.EQ(waiting.pendingFrameID).first();
    if (pendingRecord) {
      pendingRecord.processed   = true;
      pendingRecord.processedAt = Date.now();
      await pendingRecord.save();
    }

    // Mark permission-request frame as processed
    if (waiting.requestFrameID) {
      let requestRecord = await Frame.where.id.EQ(waiting.requestFrameID).first();
      if (requestRecord) {
        requestRecord.processed   = true;
        requestRecord.processedAt = Date.now();
        await requestRecord.save();
      }
    }

    // Store denial frame via FrameManager (use waiting.frameManager if available)
    let denyFrameManager = waiting.frameManager || null;

    await loop._createFrame(sessionID, {
      id:            generateID('frm_'),
      type:          'permission-denied',
      content:       { pendingFrameID: waiting.pendingFrameID },
      timestamp:     Date.now(),
      interactionID: waiting.interactionID,
      authorType:    'user',
      authorID:      null,
      hidden:        false,
      deleted:       false,
      processed:     false,
    }, denyFrameManager, { authorType: 'user' });

    // Create a tool-result frame so the agent sees the denial in its context.
    // Without this, the pending-action has no matching tool-result, so
    // buildMessages() excludes both — the agent has no idea the permission
    // was denied and blindly retries the same command.
    let pendingContent = pendingRecord
      ? (typeof pendingRecord.getContent === 'function' ? pendingRecord.getContent() : pendingRecord.content)
      : {};

    if (pendingContent && typeof pendingContent === 'string') {
      try { pendingContent = JSON.parse(pendingContent); }
      catch (_error) { pendingContent = {}; }
    }

    let toolUseID = (pendingContent && pendingContent.toolUseID) || null;
    let toolName  = (pendingContent && pendingContent.toolName) || 'unknown';

    if (toolUseID) {
      await loop._createFrame(sessionID, {
        id:            generateID('frm_'),
        type:          'tool-result',
        content:       { output: `Permission denied: the user denied execution of "${toolName}". Do not retry this exact command unless the user explicitly asks you to.`, toolUseID },
        timestamp:     Date.now(),
        interactionID: waiting.interactionID,
        authorType:    'system',
        authorID:      null,
        hidden:        false,
        deleted:       false,
        processed:     false,
      }, denyFrameManager, { authorType: 'system' });
    }

    // Clear permission-waiting state
    loop._permissionWaiting.delete(sessionID);

    // Start NEW interaction with replay flag so the agent sees the denial
    let newParams = {
      ...waiting.params,
      replayFromPermission: true,
    };

    return await loop.startInteraction(sessionID, newParams);
  }
}
