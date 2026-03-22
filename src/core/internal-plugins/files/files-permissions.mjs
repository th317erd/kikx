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
  // eslint-disable-next-line no-unused-vars
  async checkPermission(featureName, args, _options) {
    let path = (args && args.path) || (args && args.filePath) || null;

    throw new PermissionRequiredError(featureName, {
      title:       'permission.files.title',
      titleParams: { operation: featureName.split(':')[1] || 'access' },
      description: 'permission.files.description',
      details: path ? [{ label: 'permission.detail.filePath', value: path }] : [],
    });
  }
}
