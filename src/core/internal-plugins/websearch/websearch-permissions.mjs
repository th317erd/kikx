'use strict';

import { Permissions }            from '../../permissions/permissions-base.mjs';
import { PermissionRequiredError } from '../../permissions/permission-required-error.mjs';

// =============================================================================
// WebsearchPermissions
// =============================================================================
// Tool-owned permission logic for websearch:fetch and websearch:search.
// Always throws PermissionRequiredError with URL and/or query in details.
// =============================================================================

export class WebsearchPermissions extends Permissions {
  // eslint-disable-next-line no-unused-vars
  async checkPermission(featureName, args, _options) {
    let url   = args && args.url;
    let query = args && args.query;

    let details = [];
    if (url)   details.push({ label: 'permission.detail.url', value: url });
    if (query) details.push({ label: 'permission.detail.query', value: query });

    throw new PermissionRequiredError(featureName, {
      title:       'permission.websearch.title',
      description: 'permission.websearch.description',
      details,
    });
  }
}
