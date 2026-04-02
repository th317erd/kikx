'use strict';

import { Permissions }            from '../../permissions/permissions-base.mjs';
import { PermissionRequiredError } from '../../permissions/permission-required-error.mjs';

// =============================================================================
// SystemCommandPermissions
// =============================================================================
// Logic-based permission decisions for system:command tool calls.
//
// The interaction controller translates `system:command { command: 'help' }`
// into a per-command feature name `command:help` before permission evaluation.
//
// Auto-approval logic:
//   1. Check if the target capability has riskLevel 'none' or 'low' → auto-approve
//   2. Fall back to ALWAYS_ALLOWED set for traditional commands (no capability)
//   3. Everything else defers to normal rule matching
// =============================================================================

const ALWAYS_ALLOWED = new Set([
  'help',
]);

export class SystemCommandPermissions extends Permissions {
  /**
   * @param {string} featureName
   * @param {{ command?: string, args?: string }} args
   * @param {Record<string, any>} _options
   * @returns {Promise<boolean | null | never>}
   */
  // eslint-disable-next-line no-unused-vars
  async checkPermission(featureName, args, _options) {
    // featureName is `command:<name>` after translation
    let commandName = featureName.startsWith('command:')
      ? featureName.slice(8)
      : (args && args.command);

    if (!commandName)
      return null;

    commandName = commandName.toLowerCase().trim();

    // Check if this is a registered capability with a declared risk level
    let pluginRegistry = this._context && this._context.getProperty
      ? this._context.getProperty('pluginRegistry')
      : null;

    if (pluginRegistry) {
      let capability = (typeof pluginRegistry.getCapabilityBySlashCommand === 'function')
        ? pluginRegistry.getCapabilityBySlashCommand(commandName)
        : null;

      if (capability && (capability.riskLevel === 'none' || capability.riskLevel === 'low'))
        return false; // Auto-approved — capability declares itself safe
    }

    // Fallback: hard-coded always-allowed for traditional commands
    if (ALWAYS_ALLOWED.has(commandName))
      return false;

    // Needs approval — throw with rich context
    let commandDisplay = `/${commandName}`;
    if (args && args.args)
      commandDisplay += ` ${args.args}`;

    throw new PermissionRequiredError(`command:${commandName}`, {
      title:       `Run Command: /${commandName}`,
      description: `Agent is requesting to run the command: ${commandDisplay.trim()}`,
      details: [
        { label: 'Command', value: commandDisplay.trim() },
      ],
    });
  }
}
