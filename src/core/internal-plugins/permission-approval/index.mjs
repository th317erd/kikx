'use strict';

import XID                    from 'xid-js';
import { BasePluginClass } from '../../routing/base-plugin-class.mjs';

// =============================================================================
// Permission Approval Plugin
// =============================================================================
// FrameRouter plugin that handles permission-request frame approval/denial.
// When a permission-request frame is updated (processed=true), this plugin:
//
//   - On approval (processed=true, no denied marker):
//     1. Looks up the tool class from pluginRegistry
//     2. Re-executes the tool with stored arguments
//     3. Creates a tool-result frame with the output
//     4. Updates state.step to 'completed'
//     5. Starts a new interaction so the agent sees the result
//
//   - On denial (processed=true, denied=true):
//     1. Creates a tool-result frame with denial message
//     2. Updates state.step to 'denied'
//     3. Starts a new interaction so the agent sees the denial
//
//   - Skips if step is already 'completed' or 'denied'
//   - Skips if frame is not yet processed (initial creation)
//
// The plugin resolves pluginRegistry and interactionLoop lazily from the
// closure-captured global context (same pattern as SchedulingPlugin).
// =============================================================================

function generateID(prefix) {
  return `${prefix}${XID.next()}`;
}

export function setup(provide) {
  provide(({ registry, context }) => {

    class PermissionApprovalPlugin extends BasePluginClass {
      async process(next, done) {
        let frame = this.context.newFrame;

        if (!frame)
          return await next(this.context);

        // Read state — if step is already completed or denied, skip
        let step = this.state.step;
        if (step === 'completed' || step === 'denied')
          return await next(this.context);

        // Only act when frame has been processed (approved or denied by user)
        if (!frame.processed)
          return await next(this.context);

        // Only act when step is 'awaiting-approval'
        if (step !== 'awaiting-approval')
          return await next(this.context);

        // Resolve dependencies from global context
        let pluginRegistry  = context.getProperty('pluginRegistry');
        let interactionLoop = context.getProperty('interactionLoop');

        if (!pluginRegistry || !interactionLoop) {
          this.logger.warn('[PermissionApproval] Missing pluginRegistry or interactionLoop — skipping');
          return await next(this.context);
        }

        // Validate required state fields
        let toolName      = this.state.toolName;
        let toolArguments = this.state.toolArguments;
        let toolUseID     = this.state.toolUseID;
        let sessionID     = this.state.sessionID;

        if (!toolName || !sessionID) {
          this.logger.warn('[PermissionApproval] Missing toolName or sessionID in state — skipping');
          return await next(this.context);
        }

        // Check if this is a denial (content.denied is used because the Frame
        // class preserves content as an object but drops unknown top-level props)
        let content  = frame.content || {};
        let isDenied = !!content.denied;

        if (isDenied) {
          await this._handleDenial(interactionLoop, sessionID, toolName, toolUseID);
        } else {
          await this._handleApproval(interactionLoop, pluginRegistry, sessionID, toolName, toolArguments, toolUseID);
        }

        return await next(this.context);
      }

      async _handleApproval(interactionLoop, pluginRegistry, sessionID, toolName, toolArguments, toolUseID) {
        let ToolClass = pluginRegistry.getTool(toolName);

        if (!ToolClass) {
          // Tool not found — create error frame
          let errorOutput = `Error: tool "${toolName}" not found in registry. Cannot re-execute after approval.`;
          await this._createToolResultFrame(interactionLoop, sessionID, errorOutput, toolUseID);
          this.state.step = 'completed';
          return;
        }

        // Re-execute the tool
        let toolOutput;
        try {
          let toolInstance = new ToolClass(context);
          toolOutput = await toolInstance.execute(toolArguments || {});
        } catch (execError) {
          toolOutput = `Error executing tool after approval: ${execError.message}`;
        }

        // Normalize output
        if (toolOutput && typeof toolOutput === 'object' && toolOutput.content)
          toolOutput = toolOutput.content;
        if (typeof toolOutput !== 'string')
          toolOutput = JSON.stringify(toolOutput);

        // Create tool-result frame
        await this._createToolResultFrame(interactionLoop, sessionID, toolOutput, toolUseID);

        // Update state
        this.state.step = 'completed';

        // Start new interaction so agent sees the result
        try {
          await interactionLoop.startInteraction(sessionID, {
            replayFromPermission: true,
          });
        } catch (startError) {
          this.logger.error('[PermissionApproval] Failed to start interaction after approval:', startError);
        }
      }

      async _handleDenial(interactionLoop, sessionID, toolName, toolUseID) {
        let denialOutput = `Permission denied: the user denied execution of "${toolName}". Do not retry this exact command unless the user explicitly asks you to.`;

        await this._createToolResultFrame(interactionLoop, sessionID, denialOutput, toolUseID);

        // Update state
        this.state.step = 'denied';

        // Start new interaction so agent sees the denial
        try {
          await interactionLoop.startInteraction(sessionID, {
            replayFromPermission: true,
          });
        } catch (startError) {
          this.logger.error('[PermissionApproval] Failed to start interaction after denial:', startError);
        }
      }

      async _createToolResultFrame(interactionLoop, sessionID, output, toolUseID) {
        let frameData = {
          id:            generateID('frm_'),
          type:          'ToolResult',
          content:       { output: output, toolUseID: toolUseID || null },
          timestamp:     Date.now(),
          interactionID: this.state.interactionID || null,
          authorType:    'system',
          authorID:      null,
          hidden:        false,
          deleted:       false,
          processed:     false,
        };

        try {
          await interactionLoop._createFrame(sessionID, frameData, this.context.frames);
        } catch (createError) {
          this.logger.error('[PermissionApproval] Failed to create tool-result frame:', createError);
        }
      }
    }

    registry.registerSelector('type:PermissionRequest', PermissionApprovalPlugin);
  });
}
