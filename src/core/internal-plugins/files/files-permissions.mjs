'use strict';

import { Permissions }            from '../../permissions/permissions-base.mjs';
import { PermissionRequiredError } from '../../permissions/permission-required-error.mjs';

// =============================================================================
// FilesPermissions
// =============================================================================
// Tool-owned permission logic for files:read, files:write, files:edit.
// Always throws PermissionRequiredError with the file path in details.
// =============================================================================

export class FilesPermissions extends Permissions {
  /**
   * @param {string} featureName
   * @param {Record<string, any>} args
   * @param {Record<string, any>} options
   * @returns {Promise<boolean | never>}
   */
  async checkPermission(featureName, args, options) {
    // Check standing rules first (e.g., allow-forever from a previous approval)
    try {
      let needsApproval = await this.evaluate(featureName, args, options);
      if (!needsApproval)
        return false;
    } catch (err) {
      throw err; // PermissionDeniedError — propagate
    }

    let path      = (args && args.path) || (args && args.filePath) || null;
    let operation = featureName.split(':')[1] || 'access';
    let opLabel   = { read: 'Read File', write: 'Write File', edit: 'Edit File' }[operation] || 'File Access';

    throw new PermissionRequiredError(featureName, {
      title:       opLabel,
      description: path
        ? `Agent is requesting to ${operation} the file: ${path}`
        : `Agent is requesting file ${operation} access.`,
      details: path ? [{ label: 'File Path', value: path }] : [],
    });
  }
}
