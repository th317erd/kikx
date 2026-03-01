'use strict';

// =============================================================================
// AuthController — register, login, me
// =============================================================================

import { ControllerAuthBase } from './controller-auth-base.mjs';

export class AuthController extends ControllerAuthBase {
  // Register and login are unauthenticated
  skipAuthorization(context) {
    let methodName = context && context.methodName;
    return (methodName === 'register' || methodName === 'login');
  }

  // ---------------------------------------------------------------------------
  // POST /api/v2/auth/register
  // ---------------------------------------------------------------------------

  async register({ body }) {
    let { email, password, organizationName, firstName, lastName } = body || {};

    if (!email)
      this.throwBadRequestError('email is required');

    if (!password)
      this.throwBadRequestError('password is required');

    let authService = this.getAuthService();
    let result      = await authService.register(email, password, {
      organizationName,
      firstName,
      lastName,
    });

    this.setStatusCode(201);

    return {
      data: {
        user:         { id: result.user.id, email: result.user.email, firstName: result.user.firstName, lastName: result.user.lastName },
        token:        result.token,
        organization: { id: result.organization.id, name: result.organization.name },
      },
    };
  }

  // ---------------------------------------------------------------------------
  // POST /api/v2/auth/login
  // ---------------------------------------------------------------------------

  async login({ body }) {
    let { email, password } = body || {};

    if (!email)
      this.throwBadRequestError('email is required');

    if (!password)
      this.throwBadRequestError('password is required');

    let authService = this.getAuthService();
    let result      = await authService.login(email, password);

    return {
      data: {
        user:  { id: result.user.id, email: result.user.email, firstName: result.user.firstName, lastName: result.user.lastName },
        token: result.token,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // GET /api/v2/auth/me
  // ---------------------------------------------------------------------------

  async me() {
    let { User } = this.getCoreModels();
    let user     = await User.where.id.EQ(this.request.userId).first();

    if (!user)
      this.throwNotFoundError('User not found');

    return {
      data: {
        id:             user.id,
        email:          user.email,
        firstName:      user.firstName,
        lastName:       user.lastName,
        organizationID: user.organizationID,
      },
    };
  }
}
