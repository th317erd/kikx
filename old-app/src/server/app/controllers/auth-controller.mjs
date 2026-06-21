import Nife               from 'nife';
import { ControllerBase } from './controller-base.mjs';
import Utils              from '../utils/index.mjs';

export class AuthController extends ControllerBase {
  async login({ query, body }, { User, InvalidToken }) {
    const { magicToken }  = (this.method === 'POST') ? body : query;
    const app             = this.getApplication();

    if (Nife.isEmpty(magicToken))
      this.throwBadRequestError('"magicToken" parameter required', 'magic-token-not-supplied');

    let sessionToken;
    let user;
    let claims;

    try {
      let result = await User.validateSessionToken(magicToken, { skipMFACheck: true, skipSeedCheck: true });
      user = result.user;
      claims = result.claims;
    } catch (error) {
      this.rethrowIfKnown(error);
      this.throwUnauthorizedError('Specified token is invalid', 'auth-token-invalid');
    }

    if (claims.isMFARequired) {
      let mfaPageURL = app.getConfigValue('application.{environment}.mfaPageURL');
      mfaPageURL = `${mfaPageURL}?magicToken=${magicToken}`;

      if (this.method === 'GET') {
        return this.redirectTo(mfaPageURL);
      } else {
        return {
          data: {
            needsMFA:     true,
            redirectURL:  mfaPageURL,
          },
        };
      }
    } else if (claims.isSeedToken) {
      let result = await user.generateSessionToken({
        scope:        claims.scope,
        skipMFA:      true,
        isSeedToken:  false,
      });

      // Invalidate magicToken
      await InvalidToken.createForToken(magicToken);

      sessionToken = result.sessionToken;
    } else {
      // The token provided was already
      // a valid token
      sessionToken = magicToken;
    }

    let afterLoginPageURL;
    if (Nife.isEmpty(afterLoginPageURL))
      afterLoginPageURL = app.getConfigValue('application.{environment}.afterLoginPageURL');

    this.setHeader('X-Session-Token', sessionToken);

    this.setCookie(this.getAuthTokenCookieName(), sessionToken, {
      domain:   app.getConfigValue('application.{environment}.domain', 'example.com'),
       
      maxAge:   claims.expiresIn * 1000,
      secure:   true,
      httpOnly: true,
      sameSite: 'Strict',
      path:     '/',
    });

    if (this.method === 'GET') {
      return this.redirectTo(afterLoginPageURL);
    } else {
      return {
        data: {
          redirectURL:  afterLoginPageURL,
          sessionToken: sessionToken,
        },
      };
    }
  }

  async logout(_, { InvalidToken }) {
    let request         = this.request;
    let app             = this.getApplication();
    let authHeader      = request.headers['authorization'];
    let authCookieToken = this.getCookie(this.getAuthTokenCookieName());
    let authHeaderToken;

    if (!Nife.isEmpty(authHeader)) {
      authHeader = ('' + authHeader).trim();

      authHeader.replace(/^Bearer ([0-9a-zA-Z+/=_.-]+)$/, (m, _authToken) => {
        authHeaderToken = _authToken;
      });
    }

    if (Nife.isEmpty(authCookieToken) && Nife.isEmpty(authHeaderToken)) {
       
      this.setStatusCode(201);
      return;
    }

    if (authHeaderToken)
      await InvalidToken.createForToken(authHeaderToken);

    if (authCookieToken && authHeaderToken !== authCookieToken)
      await InvalidToken.createForToken(authCookieToken);

    // Destroy the cookie
    this.setCookie(this.getAuthTokenCookieName(), 'null', {
      domain:   app.getConfigValue('application.{environment}.domain', 'example.com'),
      maxAge:   0,
      secure:   true,
      httpOnly: true,
      sameSite: 'Strict',
      path:     '/',
    });

    this.setStatusCode(200);
  }

  async sendMagicLink({ body }, { User }) {
    let loginParams = this.getParams({
      'email!': (value) => value.trim().toLowerCase(),
    }, [ body ]);

    let user = await User.$.email.EQ(loginParams.email).first();
    if (!user)
      this.throwNotFoundError(`User "${loginParams.email}" not found`, 'user-not-found');

    // Dev mode: generate token and return it directly instead of emailing
    let { sessionToken, magicLinkURL } = await user.generateSessionToken({
      skipMFA:      true,
      isSeedToken:  true,
    });

    console.log(`[DEV] Magic link for ${loginParams.email}: ${magicLinkURL}`);

    return {
      data: {
        success:      true,
        sessionToken,
        magicLinkURL,
      },
    };
  }

  async registerUser({ body }, { User }) {
    let userParams = this.getParams({
      'email!':     (value) => value.trim().toLowerCase(),
      'phone':      (value) => Utils.formatPhoneNumber(value, 'DB'),
      'firstName':  (value) => value.trim(),
      'lastName':   (value) => value.trim(),
      'dob':        (value) => value.trim(),
    }, [ body ]);

    let user = await User.$.email.EQ(userParams.email).first();
    if (!user) {
      try {
        user = await User.create(userParams);
      } catch (error) {
        this.getLogger().error(`AuthController::registerUser: Failed to create user "${userParams.email}": `, error);
        this.throwInternalServerError('Failed to create user', 'user-creation-failed');
      }

      // Dev mode: generate a session token and return it directly
      let app = this.getApplication();
      let { sessionToken } = await user.generateSessionToken({
        skipMFA:      true,
        isSeedToken:  false,
      });

      this.setHeader('X-Session-Token', sessionToken);

      this.setCookie(this.getAuthTokenCookieName(), sessionToken, {
        domain:   app.getConfigValue('application.{environment}.domain', 'wyatt-desktop.mythix.info'),
        maxAge:   86400000,
        secure:   true,
        httpOnly: true,
        sameSite: 'Strict',
        path:     '/',
      });

      return {
        data: {
          ...(await user.serializeAttributes()),
          sessionToken,
        },
      };
    } else {
      this.throwBadRequestError('User with that email address already exists', 'user-already-exists');
    }
  }
}
