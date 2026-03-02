'use strict';

// =============================================================================
// ShellPermissions
// =============================================================================
// Custom permission logic for the shell plugin.
// Checks each parsed command individually against the PermissionEngine.
// If ANY command in the pipeline needs approval, the entire pipeline is blocked.
// =============================================================================

export class ShellPermissions {
  // Returns true if ANY command in the pipeline needs permission approval
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
