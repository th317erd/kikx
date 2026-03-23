'use strict';

import XID                    from 'xid-js';
import { parseShellCommands } from '../internal-plugins/shell/command-parser.mjs';

// =============================================================================
// PermissionHandler
// =============================================================================
// Manages the permission lifecycle for tool calls during agent interactions:
//   - Permission hard-break (pause interaction, ask user)
//   - Immediate denial for agent-only sessions with no user ancestry
//
// Approve / deny flows are handled by PermissionApprovalPlugin via
// FrameRouter (frame-based state). This handler only retains the
// hard-break path needed for child sessions.
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

  async hardBreak(sessionID, generator, block, interactionID, params, frameManager, permissionContext) {
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

    if (permissionContext)
      requestContent.permissionContext = permissionContext;

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

    // 5. Clean up active interaction
    //    Permission-waiting state is now entirely frame-based (pending-action +
    //    permission-request frames). The FrameRouter + PermissionApprovalPlugin
    //    handle approval/denial by watching for frame updates.
    let agentID   = params.agent && params.agent.id;
    let activeKey = loop._activeKey(sessionID, agentID);

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

}
