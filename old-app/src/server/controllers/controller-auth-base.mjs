'use strict';

// =============================================================================
// ControllerAuthBase — V2 authenticated controller base
// =============================================================================
// Extends ControllerBase with auth middleware. Child controllers that need
// authentication inherit from this. Override skipAuthorization() to exempt
// specific endpoints (e.g., register/login).
// =============================================================================

import { ControllerBase }  from './controller-base.mjs';
import { authMiddleware }  from '../middleware/index.mjs';

export class ControllerAuthBase extends ControllerBase {
  // Override in child controller to skip auth for specific endpoints.
  // Return true to skip, false (default) to require auth.
  // eslint-disable-next-line no-unused-vars
  skipAuthorization(context) {
    return false;
  }

  getMiddleware(context) {
    if (this.skipAuthorization(context) === true)
      return;

    return [
      authMiddleware,
    ];
  }
}
