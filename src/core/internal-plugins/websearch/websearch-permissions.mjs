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
  /**
   * @param {string} featureName
   * @param {{ url?: string, query?: string }} args
   * @param {Record<string, any>} options
   * @returns {Promise<boolean | never>}
   */
  async checkPermission(featureName, args, options) {
    // Check standing rules first
    try {
      let needsApproval = await this.evaluate(featureName, args, options);
      if (!needsApproval)
        return false;
    } catch (err) {
      throw err;
    }

    let url   = args && args.url;
    let query = args && args.query;
    let isSearch = featureName.includes('search');

    let details = [];
    if (url)   details.push({ label: 'URL', value: url });
    if (query) details.push({ label: 'Search Query', value: query });

    throw new PermissionRequiredError(featureName, {
      title:       isSearch ? 'Web Search' : 'Fetch URL',
      description: isSearch
        ? `Agent is requesting to search the web${query ? ': "' + query + '"' : '.'}`
        : `Agent is requesting to fetch: ${url || '(unknown URL)'}`,
      details,
    });
  }
}
