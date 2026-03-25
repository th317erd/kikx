'use strict';

import { BasePluginClass } from '../../routing/base-plugin-class.mjs';

// =============================================================================
// Permissions Plugin
// =============================================================================
// Routing-based permission observer. Registers for tool-call frames and
// verifies that approved tool calls carry valid signatures.
//
// This plugin does NOT replace the InteractionLoop's permission checking
// (that migration happens in C5). Instead, it participates in routing to:
//   1. Observe tool-call frames for audit/logging
//   2. Verify signatures on approved tool calls
//   3. Provide a routing-based hook point for future permission enhancements
//
// The PermissionService is accessed from the KikxCore context via closure.
// =============================================================================

export function setup(provide) {
  provide(({ registry, context }) => {
    let permissionService = context.getProperty('permissionService');

    // If no permission service exists (e.g., embedded/test mode), skip.
    if (!permissionService)
      return;

    class PermissionPlugin extends BasePluginClass {
      async process(next, done) {
        let commit  = this.context.commit;
        let changes = commit && commit.changes;

        if (!changes || changes.length === 0)
          return await next(this.context);

        // Check each tool-call frame in the commit for signature verification
        let frameManager = this.context.frameManager;

        for (let change of changes) {
          let frame = frameManager && frameManager.getHead(change.frameID);
          if (!frame || frame.type !== 'ToolCall')
            continue;

          // Read signature from the frame's top-level signature field (Ed25519)
          let signature = frame.signature;
          if (!signature)
            continue;

          // Look up author's public key for Ed25519 verification
          let authorPublicKey = null;

          if (commit) {
            let models = context.getProperty('models');

            if (models && commit.authorType === 'user' && commit.authorID) {
              let user = await models.User.where.id.EQ(commit.authorID).first();
              if (user)
                authorPublicKey = user.publicKey;
            } else if (models && commit.authorType === 'agent' && commit.authorID) {
              let agent = await models.Agent.where.id.EQ(commit.authorID).first();
              if (agent)
                authorPublicKey = agent.publicKey;
            }
          }

          if (authorPublicKey) {
            // Verify with Ed25519 using the author's public key
            let keystore = context.getProperty('keystore');
            let valid    = keystore && keystore.verifyWithPublicKey(
              frame.content, authorPublicKey, signature,
            );

            if (!valid)
              this.logger.warn(`PermissionPlugin: invalid Ed25519 signature on frame ${frame.id}`);
          } else {
            // Fallback: try HMAC verification via permission service (backward compat)
            let valid = permissionService.verifyApproval(
              'approve',
              frame.id,
              frame.content.toolName,
              frame.content.arguments || {},
              signature,
              this.context.session && this.context.session.id,
            );

            if (!valid)
              this.logger.warn(`PermissionPlugin: invalid signature on tool-call frame ${frame.id}`);
          }
        }

        return await next(this.context);
      }
    }

    registry.registerSelector('type:ToolCall', PermissionPlugin);
  });
}
