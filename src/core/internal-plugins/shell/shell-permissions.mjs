'use strict';

import { Permissions } from '../../permissions/permissions-base.mjs';

// =============================================================================
// ShellPermissions
// =============================================================================
// Custom permission logic for the shell plugin.
// Extends the Permissions base class with command-level matching.
//
// Rule metadata can include { allowedCommands: ['ls', 'cat'] } to restrict
// which commands a rule applies to. If no allowedCommands, the rule matches
// all commands.
//
// Also provides the legacy static checkCommands() method for backward compat.
// =============================================================================

export class ShellPermissions extends Permissions {
  matchesRule(rule, args, metadata) {
    if (metadata && metadata.allowedCommands && args && args.command) {
      let baseCommand = args.command.split(/\s+/)[0];

      return { matches: metadata.allowedCommands.includes(baseCommand) };
    }

    return { matches: true }; // no command filter = rule matches
  }

  // Legacy static method (backward compat with existing tests)
  static async checkCommands(commands, permissionEngine, options) {
    for (let command of commands) {
      let needsPermission = await permissionEngine.checkPermission(
        `shell:${command.command}`,
        command,
        options,
      );

      if (needsPermission)
        return true;
    }

    return false;
  }
}
