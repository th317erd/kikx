'use strict';

import { Permissions }             from '../../permissions/permissions-base.mjs';
import { PermissionRequiredError } from '../../permissions/permission-required-error.mjs';
import { parseShellCommands }      from './command-parser.mjs';

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
  async checkPermission(featureName, args, options) {
    let command = args && args.command;
    if (!command || typeof command !== 'string')
      return null; // No command to check — defer

    // Parse into individual commands
    let commands = parseShellCommands(command);

    if (!commands || commands.length === 0)
      return null;

    // Check each command against PermissionEngine
    let permissionEngine = this._context?.getProperty?.('permissionEngine');
    let needsApproval = false;
    let details = [];

    for (let cmd of commands) {
      let perCommandFeature = `shell:${cmd.command}`;
      let approved = false;

      if (permissionEngine) {
        try {
          // Strip toolClass to prevent infinite recursion — the PermissionEngine
          // would see the toolClass, get its PermissionsClass (us), and call
          // checkPermission again in an infinite loop.
          let engineOptions = { ...options, toolClass: null };

          let needs = await Promise.race([
            permissionEngine.checkPermission(perCommandFeature, cmd, engineOptions),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Permission check timed out')), 5000)),
          ]);
          console.log(`[ShellPerm] ${perCommandFeature} result: needs=${needs}`);
          approved = !needs;
        } catch (error) {
          if (error.name === 'PermissionDeniedError')
            throw error; // Deny-forever — block everything

          // Timeout or other error — treat as needing approval
          console.error('[ShellPermissions] Permission check error:', error.message);
        }
      }

      if (approved) {
        details.push({ label: 'permission.detail.approvedCommand', value: cmd.raw || cmd.command });
      } else {
        needsApproval = true;
        details.push({ label: 'permission.detail.pendingCommand', value: cmd.raw || cmd.command });
      }
    }

    if (!needsApproval)
      return false; // All commands approved

    // Some commands need approval
    throw new PermissionRequiredError('shell:execute', {
      title:       'permission.shell.executeTitle',
      description: 'permission.shell.executeDescription',
      details,
    });
  }

  matchesRule(rule, args, metadata) {
    // If the rule has stored command + arguments, require exact argument match.
    // This prevents "allow forever ls -la /tmp/" from auto-allowing "ls /etc/shadow".
    if (metadata && metadata.command && args) {
      // Command name must match
      if (args.command !== metadata.command)
        return { matches: false };

      // Arguments must match positionally — argument order is semantically meaningful
      // in shell commands (e.g. mv src dest vs mv dest src).
      let ruleArgs    = metadata.arguments || [];
      let currentArgs = args.arguments || [];

      if (ruleArgs.length !== currentArgs.length)
        return { matches: false };

      for (let i = 0; i < ruleArgs.length; i++) {
        if (ruleArgs[i] !== currentArgs[i])
          return { matches: false };
      }

      return { matches: true };
    }

    // Legacy: allowedCommands array (command-name-only matching)
    if (metadata && metadata.allowedCommands && args && args.command) {
      let baseCommand = args.command.split(/\s+/)[0];

      return { matches: metadata.allowedCommands.includes(baseCommand) };
    }

    return { matches: true }; // no metadata filter = rule matches
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
