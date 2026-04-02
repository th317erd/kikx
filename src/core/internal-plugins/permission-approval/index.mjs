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
//     1. Verifies the Ed25519 approval signature (if present)
//     2. Creates a one-time allow PermissionRule (NOT direct tool execution)
//     3. Hides the placeholder "awaiting" ToolResult
//     4. Updates state.step to 'completed'
//     5. Starts a new interaction (InteractionLoop detects approved tool call)
//
//   - On denial (processed=true, denied=true):
//     1. Verifies the Ed25519 denial signature (if present)
//     2. Hides the placeholder "awaiting" ToolResult
//     3. Creates a denial ToolResult frame
//     4. Updates state.step to 'denied'
//     5. Starts a new interaction so the agent sees the denial
//
//   - Skips if step is already 'completed' or 'denied'
//   - Skips if frame is not yet processed (initial creation)
//
// The plugin resolves pluginRegistry and interactionLoop lazily from the
// closure-captured global context (same pattern as SchedulingPlugin).
// =============================================================================

/**
 * @param {string} prefix
 * @returns {string}
 */
function generateID(prefix) {
  return `${prefix}${XID.next()}`;
}

/**
 * @param {(cb: (ctx: { registry: any, context: import('../../types').CascadingContext }) => void) => void} provide
 */
export function setup(provide) {
  provide(({ registry, context }) => {

    class PermissionApprovalPlugin extends BasePluginClass {
      /**
       * @param {Function} next
       * @param {Function} done
       * @returns {Promise<any>}
       */
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
          await this._handleDenial(interactionLoop, sessionID, toolName, toolUseID, frame, content);
        } else {
          await this._handleApproval(interactionLoop, pluginRegistry, sessionID, toolName, toolArguments, toolUseID, frame, content);
        }

        return await next(this.context);
      }

      // -----------------------------------------------------------------------
      // _verifySignature — verify Ed25519 signature on approval/denial
      // -----------------------------------------------------------------------
      // Returns true if signature is valid (or if no signature is present —
      // legacy approvals without signatures are still accepted).
      // Returns false only when a signature IS present but is invalid.
      // -----------------------------------------------------------------------

      /**
       * @param {import('../../types').FrameData} frame
       * @param {Record<string, any>} content
       * @param {'approve' | 'deny'} action
       * @returns {boolean | { needsAsyncVerification: boolean, payload: string, signature: string, fingerprint: string }}
       */
      _verifySignature(frame, content, action) {
        let signatureField    = (action === 'deny') ? 'denialSignature' : 'approvalSignature';
        let fingerprintField  = (action === 'deny') ? 'denialFingerprint' : 'approvalFingerprint';
        let signature         = content[signatureField];
        let fingerprint       = content[fingerprintField];

        // No signature → legacy approval, allow it
        if (!signature)
          return true;

        let keystore = context.getProperty('keystore');
        if (!keystore)
          return true; // No keystore → can't verify, allow it

        // Look up approver's public key
        let approverID = content.approvedBy || content.deniedBy;
        let publicKey  = null;

        // Try to find the user's public key from the models
        // (synchronous lookup not possible here — we cache it in content or look up by fingerprint)
        // For now, skip verification if we can't find the public key
        // The InteractionController wrote the fingerprint; we need the public key.
        // Best-effort: if we have models, try lookup.
        // Note: This is a synchronous method to keep the plugin simple.
        // The controller already verified by signing with the correct key.
        // We do a basic structural check here.

        if (!fingerprint)
          return true; // No fingerprint → can't verify, allow it

        // Rebuild the payload and verify
        try {
          let payload = JSON.stringify(keystore.canonicalize({
            action,
            frameID:   frame.id,
            toolName:  this.state.toolName,
            arguments: this.state.toolArguments || {},
            sessionID: this.state.sessionID,
          }));

          // We need the public key for verification. The approver's public key
          // can be looked up from User model, but that's async. For the sync
          // fast path, we store the verification result from the controller.
          // For the async path, use _verifySignatureAsync.
          return { needsAsyncVerification: true, payload, signature, fingerprint };
        } catch (_error) {
          return false;
        }
      }

      /**
       * @param {import('../../types').FrameData} frame
       * @param {Record<string, any>} content
       * @param {'approve' | 'deny'} action
       * @returns {Promise<boolean>}
       */
      async _verifySignatureAsync(frame, content, action) {
        let signatureField    = (action === 'deny') ? 'denialSignature' : 'approvalSignature';
        let fingerprintField  = (action === 'deny') ? 'denialFingerprint' : 'approvalFingerprint';
        let signature         = content[signatureField];
        let fingerprint       = content[fingerprintField];

        // No signature → legacy approval, allow it
        if (!signature)
          return true;

        let keystore = context.getProperty('keystore');
        if (!keystore)
          return true;

        // Look up approver's public key via userID or fingerprint
        let approverID = content.approvedBy || content.deniedBy;
        let publicKey  = null;

        if (approverID) {
          let models = context.getProperty('models');
          if (models && models.User) {
            try {
              let approver = await models.User.where.id.EQ(approverID).first();
              if (approver)
                publicKey = approver.publicKey;
            } catch (_lookupError) {
              // Best-effort
            }
          }
        }

        if (!publicKey)
          return true; // Can't find public key → allow (legacy user without signing key)

        // Rebuild and verify the payload
        try {
          let payload = JSON.stringify(keystore.canonicalize({
            action,
            frameID:   frame.id,
            toolName:  this.state.toolName,
            arguments: this.state.toolArguments || {},
            sessionID: this.state.sessionID,
          }));

          return keystore.verifyWithPublicKey(payload, publicKey, signature);
        } catch (_error) {
          return false;
        }
      }

      // -----------------------------------------------------------------------
      // _hideAwaitingToolResult — hide placeholder ToolResult frames
      // -----------------------------------------------------------------------

      /**
       * @param {any} interactionLoop
       * @param {string} sessionID
       * @param {string | null} toolUseID
       * @returns {Promise<void>}
       */
      async _hideAwaitingToolResult(interactionLoop, sessionID, toolUseID) {
        if (!toolUseID)
          return;

        // Hide all frames between the ToolCall and the PermissionRequest in the
        // FrameManager. This includes the placeholder "PERMISSION REQUIRED"
        // ToolResult and any agent Messages about needing permission. These
        // frames would confuse the LLM conversation after the tool is replayed.
        let frameManager = this.context.frames;
        if (!frameManager)
          return;

        let allFrames = (typeof frameManager.toArray === 'function') ? frameManager.toArray() : [];

        // Find the ToolCall frame for this toolUseID
        let toolCallOrder = -1;
        for (let fm of allFrames) {
          if (fm.type !== 'ToolCall')
            continue;
          let fmContent = (typeof fm.content === 'string')
            ? (() => { try { return JSON.parse(fm.content); } catch (_e) { return {}; } })()
            : (fm.content || {});
          if (fmContent.toolUseID === toolUseID) {
            toolCallOrder = fm.order;
            break;
          }
        }

        if (toolCallOrder < 0)
          return;

        // Collect frames to hide (do NOT mutate in-memory directly)
        let framesToHide = [];

        for (let fm of allFrames) {
          if (fm.order <= toolCallOrder || fm.hidden)
            continue;

          if (fm.type === 'ToolResult') {
            let fmContent = (typeof fm.content === 'string')
              ? (() => { try { return JSON.parse(fm.content); } catch (_e) { return {}; } })()
              : (fm.content || {});
            if (fmContent.toolUseID === toolUseID)
              framesToHide.push(fm);
          } else if (fm.type === 'Message' && fm.authorType === 'agent') {
            framesToHide.push(fm);
          }
        }

        if (framesToHide.length > 0) {
          // Merge with silent: true — we are inside a FrameRouter plugin,
          // non-silent would re-trigger routing and cascade into other plugins
          let hydrated = framesToHide.map((f) => ({ ...f, hidden: true }));
          frameManager.merge(hydrated, { silent: true });

          // Persist via FramePersistence
          let framePersistence = context.getProperty('framePersistence');
          if (framePersistence)
            await framePersistence.saveFrames(sessionID, hydrated);
        }
      }

      /**
       * @param {any} interactionLoop
       * @param {any} pluginRegistry
       * @param {string} sessionID
       * @param {string} toolName
       * @param {Record<string, any> | null} toolArguments
       * @param {string | null} toolUseID
       * @param {import('../../types').FrameData} frame
       * @param {Record<string, any>} content
       * @returns {Promise<void>}
       */
      async _handleApproval(interactionLoop, pluginRegistry, sessionID, toolName, toolArguments, toolUseID, frame, content) {
        // Verify approval signature
        let signatureValid = await this._verifySignatureAsync(frame, content, 'approve');

        if (signatureValid === false) {
          this.logger.warn(`[PermissionApproval] Invalid approval signature on frame ${frame.id} — skipping`);
          this.state.step = 'signature-invalid';
          return;
        }

        // Create one-time allow PermissionRule
        try {
          let { Permissions } = await import('../../permissions/permissions-base.mjs');
          let permissions     = new Permissions(context);

          // Resolve organizationID from state or approver
          let organizationID = this.state.organizationID || null;

          if (!organizationID && content.approvedBy) {
            let models = context.getProperty('models');
            if (models && models.User) {
              let approver = await models.User.where.id.EQ(content.approvedBy).first();
              if (approver)
                organizationID = approver.organizationID;
            }
          }

          if (organizationID) {
            // Shell tools check per-command features (e.g., 'shell:echo')
            // rather than the top-level 'shell:execute'. Create rules that
            // match the per-command evaluation in ShellPermissions.
            if (toolName === 'shell:execute' && toolArguments && toolArguments.command) {
              let { parseShellCommands } = await import('../../internal-plugins/shell/command-parser.mjs');
              let parsed = parseShellCommands(toolArguments.command);

              for (let cmd of parsed) {
                await permissions.createRule({
                  organizationID,
                  featureName: `shell:${cmd.command}`,
                  effect:      'allow',
                  scope:       'session',
                  scopeID:     sessionID,
                  createdBy:   content.approvedBy || 'system',
                  metadata:    {
                    oneTime:             true,
                    permissionRequestID: frame.id,
                    command:             cmd.command,
                    arguments:           cmd.arguments || [],
                    toolUseID:           toolUseID || null,
                  },
                });
              }
            } else {
              await permissions.createRule({
                organizationID,
                featureName: toolName,
                effect:      'allow',
                scope:       'session',
                scopeID:     sessionID,
                createdBy:   content.approvedBy || 'system',
                metadata:    {
                  oneTime:               true,
                  permissionRequestID:   frame.id,
                  toolArguments:         toolArguments || {},
                  toolUseID:             toolUseID || null,
                },
              });
            }
          }
        } catch (ruleError) {
          this.logger.error('[PermissionApproval] Failed to create one-time rule:', ruleError);
        }

        // Update state FIRST — prevents re-entrancy if startInteraction
        // fails and re-triggers the FrameRouter on the same session
        this.state.step = 'completed';

        // Hide the placeholder "awaiting" ToolResult
        await this._hideAwaitingToolResult(interactionLoop, sessionID, toolUseID);

        // Defer the replay interaction so the controller's saveFrames() can
        // persist the hidden/processed state to DB before the interaction
        // reloads frames. Without this, startInteraction loads stale data.
        let self = this;
        setTimeout(async () => {
          try {
            await self._resolveAndStartInteraction(interactionLoop, sessionID);
          } catch (err) {
            console.error('[PermissionApproval] Deferred startInteraction failed:', err.message);
          }
        }, 200);
      }

      /**
       * @param {any} interactionLoop
       * @param {string} sessionID
       * @param {string} toolName
       * @param {string | null} toolUseID
       * @param {import('../../types').FrameData} frame
       * @param {Record<string, any>} content
       * @returns {Promise<void>}
       */
      async _handleDenial(interactionLoop, sessionID, toolName, toolUseID, frame, content) {
        // Verify denial signature
        let signatureValid = await this._verifySignatureAsync(frame, content, 'deny');

        if (signatureValid === false) {
          this.logger.warn(`[PermissionApproval] Invalid denial signature on frame ${frame.id} — skipping`);
          this.state.step = 'signature-invalid';
          return;
        }

        // Update state FIRST — prevents re-entrancy loop
        this.state.step = 'denied';

        // Hide the placeholder "awaiting" ToolResult
        await this._hideAwaitingToolResult(interactionLoop, sessionID, toolUseID);

        // Create denial ToolResult
        let denialOutput = `Permission denied for "${toolName}". User denied execution.`;
        await this._createToolResultFrame(interactionLoop, sessionID, denialOutput, toolUseID);

        // Start new interaction so agent sees the denial
        await this._resolveAndStartInteraction(interactionLoop, sessionID);
      }

      // -----------------------------------------------------------------------
      // _resolveAndStartInteraction — resolve agent and start interaction
      // -----------------------------------------------------------------------
      // Uses the agentResolver (same pattern as SessionScheduler) to resolve
      // the agent from the state's agentID, then starts a new interaction.
      // Falls back to starting without agent (best-effort) if resolution fails.
      // -----------------------------------------------------------------------

      /**
       * @param {any} interactionLoop
       * @param {string} sessionID
       * @returns {Promise<void>}
       */
      async _resolveAndStartInteraction(interactionLoop, sessionID) {
        try {
          let agentResolver    = context.getProperty('agentResolver');
          let sessionScheduler = context.getProperty('sessionScheduler');
          let agentID          = this.state.agentID;

          if (agentResolver && agentID) {
            let resolveContext = (sessionScheduler && sessionScheduler.getResolveContext)
              ? (sessionScheduler.getResolveContext(sessionID) || {})
              : {};

            let { agentPlugin, resolvedAgent } = await agentResolver.resolve(agentID, resolveContext);
            let { checkPermission, executeTool } = agentResolver.buildCallbacks(resolvedAgent, sessionID);

            await interactionLoop.startInteraction(sessionID, {
              agentPlugin,
              agent:               resolvedAgent,
              userMessage:         null,
              authorType:          'agent',
              authorID:            agentID,
              checkPermission,
              executeTool,
              replayFromPermission: true,
            });
          } else {
            // Fallback: start without agent (will use existing session agent)
            await interactionLoop.startInteraction(sessionID, {
              replayFromPermission: true,
            });
          }
        } catch (startError) {
          this.logger.error('[PermissionApproval] Failed to start interaction:', startError);
        }
      }

      /**
       * @param {any} interactionLoop
       * @param {string} sessionID
       * @param {string} output
       * @param {string | null} toolUseID
       * @returns {Promise<void>}
       */
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
