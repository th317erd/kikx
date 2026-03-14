'use strict';

// =============================================================================
// AuthController — register, login, me
// =============================================================================

import { ControllerAuthBase } from './controller-auth-base.mjs';

export class AuthController extends ControllerAuthBase {
  // Register and login are unauthenticated
  skipAuthorization(context) {
    let methodName = context && (context.controllerMethod || context.methodName);
    return (methodName === 'register' || methodName === 'login');
  }

  // ---------------------------------------------------------------------------
  // PUT /api/v2/auth/me — update profile
  // ---------------------------------------------------------------------------

  async updateProfile({ body }) {
    let { User } = this.getCoreModels();
    let user     = await User.where.id.EQ(this.request.userID).first();

    if (!user)
      this.throwNotFoundError('User not found');

    let { firstName, lastName, email, avatar, riskLevel } = body || {};

    if (firstName !== undefined)
      user.firstName = firstName;

    if (lastName !== undefined)
      user.lastName = lastName;

    if (avatar !== undefined)
      user.avatar = avatar;

    // Email change: store directly for now (verification stub)
    if (email !== undefined && email !== user.email)
      user.email = email;

    await user.save();

    // Update riskLevel in user settings if provided
    if (riskLevel !== undefined) {
      let keystore = this.getKeystore();
      let umk      = this.request.getUMK();

      // Generate Ed25519 key pair on-the-fly for pre-existing users who lack one
      if (!user.encryptedPrivateKey) {
        let { publicKey: signingPublicKey, privateKey: signingPrivateKey } = keystore.generateSigningKeyPair();
        let encryptedSigningKey = keystore.encryptUserPrivateKey(signingPrivateKey, umk, user.id);

        user.publicKey           = signingPublicKey;
        user.encryptedPrivateKey = JSON.stringify(encryptedSigningKey);
        await user.save();
      }

      let privateKeyPEM = keystore.decryptUserPrivateKey(
        JSON.parse(user.encryptedPrivateKey),
        umk,
        user.id,
      );

      await user.updateSettings({ riskLevel }, keystore, privateKeyPEM);
    }

    let settings = await user.getSettings();

    return {
      data: {
        id:             user.id,
        email:          user.email,
        firstName:      user.firstName,
        lastName:       user.lastName,
        organizationID: user.organizationID,
        avatar:         user.avatar ? true : false,
        riskLevel:      settings.riskLevel,
      },
    };
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
    let user     = await User.where.id.EQ(this.request.userID).first();

    if (!user)
      this.throwNotFoundError('User not found');

    let settings = await user.getSettings();

    return {
      data: {
        id:             user.id,
        email:          user.email,
        firstName:      user.firstName,
        lastName:       user.lastName,
        organizationID: user.organizationID,
        avatar:         user.avatar || null,
        riskLevel:      settings.riskLevel,
      },
    };
  }
}
