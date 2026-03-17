'use strict';

import { Permissions } from '../../permissions/permissions-base.mjs';

// =============================================================================
// SystemCommandPermissions
// =============================================================================
// Logic-based permission decisions for system:command tool calls.
//
// The interaction controller translates `system:command { command: 'help' }`
// into a per-command feature name `command:help` before permission evaluation.
// This class short-circuits for read-only commands that are always safe.
//
// Read-only commands (auto-approved):
//   help — lists available commands and tools
//
// All other commands defer to normal rule matching.
// =============================================================================

const ALWAYS_ALLOWED = new Set([
  'help',
]);

export class SystemCommandPermissions extends Permissions {
  // eslint-disable-next-line no-unused-vars
  async checkPermission(featureName, args, _options) {
    // featureName is `command:<name>` after translation
    let commandName = featureName.startsWith('command:')
      ? featureName.slice(8)
      : (args && args.command);

    if (commandName && ALWAYS_ALLOWED.has(commandName.toLowerCase().trim()))
      return false; // Auto-approved — read-only, zero risk

    return null; // Defer to normal rule matching
  }
}
