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

export function setup({ registerSelector, context }) {
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
        if (!frame || frame.type !== 'tool-call')
          continue;

        // If frame has a signature, verify it
        let signature = frame.content && frame.content._signature;
        if (signature) {
          let valid = permissionService.verifyApproval(
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

  registerSelector('type:tool-call', PermissionPlugin);
}
