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
  // Cross-session awareness:
  //   If the current session has no user (agent-only child session), the
  //   permission-request frame is routed to the nearest ancestor session that
  //   has a user. If no user exists anywhere in the ancestry, the tool call
  //   is denied immediately without waiting.
  //
  //   The pending-action frame always stays in the current (requesting) session.
  // ---------------------------------------------------------------------------

  async hardBreak(sessionID, generator, block, interactionID, params, frameManager) {
    let loop = this._loop;

    // 1. Persist pending-action frame (always in the current session)
    let pendingFrameID = generateID('frm_');
    let pendingFrame   = {
      id:            pendingFrameID,
      type:          'pending-action',
      content:       { toolName: block.content.toolName, arguments: block.content.arguments, toolUseID: block.content.toolUseId || block.content.toolUseID },
      timestamp:     Date.now(),
      interactionID,
      authorType:    block.authorType || 'agent',
      authorID:      block.authorID || null,
      hidden:        false,
      deleted:       false,
      processed:     false,
    };

    let signingContext = (params && params._signingContext) || null;

    await loop._createFrame(sessionID, pendingFrame, frameManager, {
      authorType: block.authorType || 'agent',
      authorID:   block.authorID || null,
    }, signingContext);

    // 2. Determine where to route the permission-request
    //    - If the current session has a user → same session (backward compat)
    //    - If not → walk up ancestry to find nearest user session
    //    - If no user anywhere → deny immediately
    let targetSessionID    = sessionID;
    let targetFrameManager = frameManager;
    let sessionManager     = (typeof loop._getSessionManager === 'function') ? loop._getSessionManager() : null;

    if (sessionManager) {
      let nearestUserSessionID = await sessionManager.getNearestUserAncestor(sessionID);

      if (!nearestUserSessionID) {
        // No user in ancestry — deny immediately
        await this._denyNoUser(sessionID, generator, block, interactionID, params, frameManager, pendingFrameID);
        return;
      }

      if (nearestUserSessionID !== sessionID) {
        // User is in an ancestor session — route permission-request there
        targetSessionID = nearestUserSessionID;

        // Load ancestor's FrameManager for proper order assignment + commit system
        let framePersistence = loop._getFramePersistence();
        targetFrameManager   = sessionManager.getFrameManager(nearestUserSessionID);
        await framePersistence.loadFramesInto(targetFrameManager, nearestUserSessionID);

        let nextDbOrder = await framePersistence.getNextOrder(nearestUserSessionID);
        targetFrameManager.syncOrderCounter(nextDbOrder - 1);
      }
    }

    // 3. Create permission-request frame (in the target session)
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

    await loop._createFrame(targetSessionID, requestFrame, targetFrameManager, { authorType: 'system' }, signingContext);
    loop.emit('permission:request', { sessionID, frameID: pendingFrameID, requestFrameID, toolName: block.content.toolName });

    // 4. Destroy the generator
    await generator.return();

    // 5. Store permission-waiting state (includes frameManager for approve/deny)
    let agentID   = params.agent && params.agent.id;
    let activeKey = loop._activeKey(sessionID, agentID);

    loop._permissionWaiting.set(activeKey, {
      pendingFrameID,
      requestFrameID,
      interactionID,
      params,
      frameManager,
      requestingSessionID: sessionID,
    });

    // Clean up active interaction
    loop._active.delete(activeKey);
    loop.emit('interaction:end', { sessionID, interactionID, agentID: agentID || null });
  }

  // ---------------------------------------------------------------------------
  // _denyNoUser — immediate denial when no user exists in session ancestry
  // ---------------------------------------------------------------------------

  async _denyNoUser(sessionID, generator, block, interactionID, params, frameManager, pendingFrameID) {
    let loop           = this._loop;
    let { Frame }      = loop._context.getProperty('models');
    let signingContext = (params && params._signingContext) || null;

    // Mark pending-action as processed (it was already persisted)
    let pendingRecord = await Frame.where.id.EQ(pendingFrameID).first();
    if (pendingRecord) {
      pendingRecord.processed   = true;
      pendingRecord.processedAt = Date.now();
      await pendingRecord.save();
    }

    // Create tool-result frame with denial message
    let toolName = block.content.toolName || 'unknown';
    await loop._createFrame(sessionID, {
      id:            generateID('frm_'),
      type:          'tool-result',
      content:       {
        output:    `Permission denied: no user session found in ancestry to approve "${toolName}". Tool execution was automatically denied.`,
        toolUseID: block.content.toolUseId || block.content.toolUseID,
      },
      timestamp:     Date.now(),
      interactionID,
      authorType:    'system',
      authorID:      null,
      hidden:        false,
      deleted:       false,
      processed:     false,
    }, frameManager, { authorType: 'system' }, signingContext);

    // Destroy the generator and clean up
    await generator.return();

    let agentID   = params.agent && params.agent.id;
    let activeKey = loop._activeKey(sessionID, agentID);

    loop._active.delete(activeKey);
    loop.emit('interaction:end', { sessionID, interactionID, agentID: agentID || null });
  }

  // ---------------------------------------------------------------------------
  // approve — user approved a pending permission request
  // ---------------------------------------------------------------------------

  async approve(sessionID, frameID) {
    let loop    = this._loop;
    let waiting = this._findWaiting(sessionID);

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
    let signingContext      = (waiting.params && waiting.params._signingContext) || null;

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
    }, approveFrameManager, { authorType: 'system' }, signingContext);

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
    this._deleteWaiting(sessionID);

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
    let waiting = this._findWaiting(sessionID);

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
    let signingContext   = (waiting.params && waiting.params._signingContext) || null;

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
    }, denyFrameManager, { authorType: 'user' }, signingContext);

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
      }, denyFrameManager, { authorType: 'system' }, signingContext);
    }

    // Clear permission-waiting state
    this._deleteWaiting(sessionID);

    // Start NEW interaction with replay flag so the agent sees the denial
    let newParams = {
      ...waiting.params,
      replayFromPermission: true,
    };

    return await loop.startInteraction(sessionID, newParams);
  }

  // ---------------------------------------------------------------------------
  // _findWaiting / _deleteWaiting — composite key lookup helpers
  // ---------------------------------------------------------------------------
  // Permission waiting may be keyed by composite `${sessionID}:${agentID}` or
  // plain `sessionID`. These helpers find/delete by sessionID, checking both.
  // ---------------------------------------------------------------------------

  _findWaiting(sessionID) {
    let map = this._loop._permissionWaiting;

    // Direct match (backward compat: no agent)
    if (map.has(sessionID))
      return map.get(sessionID);

    // Scan composite keys
    let prefix = `${sessionID}:`;
    for (let [key, value] of map) {
      if (key.startsWith(prefix))
        return value;
    }

    return null;
  }

  _deleteWaiting(sessionID) {
    let map = this._loop._permissionWaiting;

    if (map.has(sessionID)) {
      map.delete(sessionID);
      return;
    }

    let prefix = `${sessionID}:`;
    for (let key of map.keys()) {
      if (key.startsWith(prefix)) {
        map.delete(key);
        return;
      }
    }
  }
}
