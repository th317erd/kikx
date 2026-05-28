import { ControllerBase } from './controller-base.mjs';
import { authMiddleware } from '../middleware/index.mjs';

// This controller is a parent controller.
// Any child controller that inherits from this
// controller will require authentication for all
// its endpoints. If a specific endpoint inside
// the child controller shouldn't have authentication,
// or should conditionally be authenticated, then
// use the "skipAuthorization" method in the child
// controller to specify which endpoints should
// skip authorization.

export class ControllerAuthBase extends ControllerBase {
  // Overload this in a child controller
  // to skip authorization for certain routes.

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
