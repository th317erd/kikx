'use strict';

// =============================================================================
// PermissionDeniedError
// =============================================================================
// Thrown when a 'deny' rule matches in Permissions.evaluate().
// Unlike a regular "needs approval" result, a deny is final — no approval
// can override it.
// =============================================================================

export class PermissionDeniedError extends Error {
  constructor(featureName, reason) {
    super(`Permission denied for "${featureName}": ${reason || 'explicit deny'}`);

    this.name        = 'PermissionDeniedError';
    this.featureName = featureName;
    this.reason      = reason || 'explicit deny';
  }
}
