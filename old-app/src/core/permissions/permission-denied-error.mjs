'use strict';

// =============================================================================
// PermissionDeniedError
// =============================================================================
// Thrown when a 'deny' rule matches in Permissions.evaluate().
// Unlike a regular "needs approval" result, a deny is final — no approval
// can override it.
// =============================================================================

export class PermissionDeniedError extends Error {
  /**
   * @param {string} featureName
   * @param {string} [reason]
   */
  constructor(featureName, reason) {
    super(`Permission denied for "${featureName}": ${reason || 'explicit deny'}`);

    /** @type {string} */
    this.name        = 'PermissionDeniedError';
    /** @type {string} */
    this.featureName = featureName;
    /** @type {string} */
    this.reason      = reason || 'explicit deny';
  }
}
