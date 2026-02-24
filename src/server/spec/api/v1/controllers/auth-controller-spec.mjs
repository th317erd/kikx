/* eslint-disable no-magic-numbers */

import TWT from 'mythix-twt';

import {
  createTestApplication,
  createFactories,
  createRunners,
  PREFIXED_XID_REGEXP,
  URL_SAFE_BASE64_REGEXP,
} from '../../../support/application.mjs';

describe('AuthController', function() {
  let app;
  let models;
  let factory;

  // eslint-disable-next-line no-unused-vars
  const { it, fit } = createRunners(() => app.getConnection());

  beforeAll(async () => {
    app = await createTestApplication();
    models = app.getModels();
    factory = createFactories(app);
  });

  afterAll(async () => {
    await app.stop();
  });

  afterEach(async () => {
    factory.reset();

    jasmine.clock().uninstall();
    await app.truncateAllTables();
  });

  describe('authenticate', () => {
    describe('GET', () => {
      it('should fail without a magicToken', async () => {
        let result = await app.get('/api/v1/auth/login');
        expect(result.statusCode).toEqual(400);
        expect(result.body).toEqual('"magicToken" parameter required');
      });

      it('should fail with a bad magicToken', async () => {
        let result = await app.get('/api/v1/auth/login?magicToken=derp');
        expect(result.statusCode).toEqual(401);
        expect(result.body).toEqual('Specified token is invalid');
      });

      it('should redirect to MFA page if MFA is enabled', async () => {
        let { user } = await factory.users.create();
        spyOn(user, 'mfaEnabled').and.callFake(() => true);

        let { sessionToken } = await user.generateSessionToken();

        let result = await app.get(`/api/v1/auth/login?magicToken=${sessionToken}`, { followRedirect: false });
        expect(result.statusCode).toEqual(302);
        expect(result.headers['location']).toEqual(`https://test.hero.com/pages/mfa?magicToken=${sessionToken}`);
      });

      it('should fail if magicToken is invalid #1', async () => {
        jasmine.clock().install();
        jasmine.clock().mockDate(new Date(0));

        let magicToken = TWT.generateTWT(
          {
            s:    'u',
            u:    'USR_cd06dx7qqwpgbh6yqp3g',
            o:    undefined,
            mfa:  0,
            st:   1,
          },
          { encodedSecret: app.getSalt() },
        );

        jasmine.clock().uninstall();

        let result = await app.get(`/api/v1/auth/login?magicToken=${magicToken}`);
        expect(result.statusCode).toEqual(401);
        expect(result.body).toEqual('Specified token is invalid');
      });

      it('should fail if magicToken is invalid #2', async () => {
        jasmine.clock().install();
        jasmine.clock().mockDate(new Date(Date.now() + 130000));

        let magicToken = TWT.generateTWT(
          {
            s:    'u',
            u:    'USR_cd06dx7qqwpgbh6yqp3g',
            o:    undefined,
            mfa:  0,
            st:   1,
          },
          { encodedSecret: app.getSalt() },
        );

        jasmine.clock().uninstall();

        let result = await app.get(`/api/v1/auth/login?magicToken=${magicToken}`);
        expect(result.statusCode).toEqual(401);
        expect(result.body).toEqual('Specified token is invalid');
      });

      it('should fail if user not found', async () => {
        let magicToken = TWT.generateTWT(
          {
            s:    'u',
            u:    'bad_id',
            o:    undefined,
            mfa:  0,
            st:   1,
          },
          { encodedSecret: app.getSalt() },
        );

        let result = await app.get(`/api/v1/auth/login?magicToken=${magicToken}`);
        expect(result.statusCode).toEqual(404);
        expect(result.body).toEqual('User not found');
      });

      it('should succeed', async () => {
        let { user } = await factory.users.create();
        let { sessionToken } = await user.generateSessionToken();

        let result = await app.get(`/api/v1/auth/login?magicToken=${sessionToken}`);
        expect(result.statusCode).toEqual(302);
        expect(result.headers['location']).toEqual('https://test.hero.com/pages/home');

        expect(result.headers['x-session-token']).toMatch(URL_SAFE_BASE64_REGEXP);

        let cookie = result.headers['set-cookie'];
        expect((new RegExp(`^${app.getAuthTokenCookieName()}=[A-Za-z0-9_=-]+(%3D)*;`)).test(cookie)).toEqual(true);
        expect((/Max-Age=2592000;/).test(cookie)).toEqual(true);
        expect((/Domain=test\.hero\.com;/).test(cookie)).toEqual(true);
        expect((/Path=\/;/).test(cookie)).toEqual(true);
        expect((/HttpOnly;/).test(cookie)).toEqual(true);
        expect((/Secure;/).test(cookie)).toEqual(true);
        expect((/SameSite=Strict/).test(cookie)).toEqual(true);

        expect(await models.InvalidToken.count()).toBe(1);
        expect(await models.InvalidToken.isInvalid(sessionToken)).toEqual(true);
      });
    });

    describe('POST', () => {
      it('should fail without a magicToken', async () => {
        let result = await app.post('/api/v1/auth/login');
        expect(result.statusCode).toEqual(400);
        expect(result.body).toEqual('"magicToken" parameter required');
      });

      it('should fail with a bad magicToken', async () => {
        let result = await app.post('/api/v1/auth/login', { data: { magicToken: 'derp' } });
        expect(result.statusCode).toEqual(401);
        expect(result.body).toEqual('Specified token is invalid');
      });

      it('should redirect to MFA page if MFA is enabled', async () => {
        let { user } = await factory.users.create();
        spyOn(user, 'mfaEnabled').and.callFake(() => true);

        let { sessionToken } = await user.generateSessionToken();

        let result = await app.post('/api/v1/auth/login', { data: { magicToken: sessionToken }, followRedirect: false });
        expect(result.statusCode).toEqual(200);
        expect(result.body.data).toEqual({
          needsMFA:     true,
          redirectURL:  `https://test.hero.com/pages/mfa?magicToken=${sessionToken}`,
        });
      });

      it('should fail if magicToken is invalid #1', async () => {
        jasmine.clock().install();
        jasmine.clock().mockDate(new Date(0));

        let magicToken = TWT.generateTWT(
          {
            s:    'u',
            u:    'USR_cd06dx7qqwpgbh6yqp3g',
            o:    undefined,
            mfa:  0,
            st:   1,
          },
          { encodedSecret: app.getSalt() },
        );

        jasmine.clock().uninstall();

        let result = await app.post('/api/v1/auth/login', { data: { magicToken } });
        expect(result.statusCode).toEqual(401);
        expect(result.body).toEqual('Specified token is invalid');
      });

      it('should fail if magicToken is invalid #2', async () => {
        jasmine.clock().install();
        jasmine.clock().mockDate(new Date(Date.now() + 130000));

        let magicToken = TWT.generateTWT(
          {
            s:    'u',
            u:    'USR_cd06dx7qqwpgbh6yqp3g',
            o:    undefined,
            mfa:  0,
            st:   1,
          },
          { encodedSecret: app.getSalt() },
        );

        jasmine.clock().uninstall();

        let result = await app.post('/api/v1/auth/login', { data: { magicToken } });
        expect(result.statusCode).toEqual(401);
        expect(result.body).toEqual('Specified token is invalid');
      });

      it('should fail if user not found', async () => {
        let magicToken = TWT.generateTWT(
          {
            s:    'u',
            u:    'bad_id',
            o:    undefined,
            mfa:  0,
            st:   1,
          },
          { encodedSecret: app.getSalt() },
        );

        let result = await app.post('/api/v1/auth/login', { data: { magicToken } });
        expect(result.statusCode).toEqual(404);
        expect(result.body).toEqual('User not found');
      });

      it('should succeed', async () => {
        let { user } = await factory.users.create();
        let { sessionToken } = await user.generateSessionToken();

        let result = await app.post('/api/v1/auth/login', { data: { magicToken: sessionToken } });
        expect(result.statusCode).toEqual(200);

        expect(result.headers['x-session-token']).toMatch(URL_SAFE_BASE64_REGEXP);

        let cookie = result.headers['set-cookie'];
        expect((new RegExp(`^${app.getAuthTokenCookieName()}=[A-Za-z0-9_=-]+(%3D)*;`)).test(cookie)).toEqual(true);
        expect((/Max-Age=2592000;/).test(cookie)).toEqual(true);
        expect((/Domain=test\.hero\.com;/).test(cookie)).toEqual(true);
        expect((/Path=\/;/).test(cookie)).toEqual(true);
        expect((/HttpOnly;/).test(cookie)).toEqual(true);
        expect((/Secure;/).test(cookie)).toEqual(true);
        expect((/SameSite=Strict/).test(cookie)).toEqual(true);

        expect(await models.InvalidToken.count()).toBe(1);
        expect(await models.InvalidToken.isInvalid(sessionToken)).toEqual(true);
      });
    });
  });

  describe('logout', () => {
    describe('POST', () => {
      it('should return 201 if not logged in', async () => {
        let result = await app.post('/api/v1/auth/logout');
        expect(result.statusCode).toEqual(201);
      });

      it('should succeed', async () => {
        let { user } = await factory.users.createAndLogin();

        // Should authenticate successfully
        let result = await app.get(`/api/v1/user/${user.id}`);
        expect(result.statusCode).toEqual(200);

        result = await app.post('/api/v1/auth/logout');
        expect(result.statusCode).toEqual(200);

        // Should fail to authenticate successfully
        let loggedOutResult = await app.get(`/api/v1/user/${user.id}`);
        expect(loggedOutResult.statusCode).toEqual(401);

        let cookie = result.headers['set-cookie'];
        expect((new RegExp(`^${app.getAuthTokenCookieName()}=[A-Za-z0-9_=-]+(%3D)*;`)).test(cookie)).toEqual(true);
        expect((/Max-Age=0;/).test(cookie)).toEqual(true);
        expect((/Domain=test\.hero\.com;/).test(cookie)).toEqual(true);
        expect((/Path=\/;/).test(cookie)).toEqual(true);
        expect((/HttpOnly;/).test(cookie)).toEqual(true);
        expect((/Secure;/).test(cookie)).toEqual(true);
        expect((/SameSite=Strict/).test(cookie)).toEqual(true);
      });
    });
  });

  describe('requestLogin', () => {
    describe('POST', () => {
      it('should fail to find non-existent user', async () => {
        let result = await app.post('/api/v1/auth/send-magic-link', { data: { email: 'none@nothing.com' } });
        expect(result.statusCode).toEqual(404);
        expect(result.body).toEqual('User "none@nothing.com" not found');
      });

      it('should succeed', async () => {
        let { user } = await factory.users.create();

        let result = await app.post('/api/v1/auth/send-magic-link', { data: { email: user.email } });
        expect(result.statusCode).toEqual(200);
        expect(result.body).toEqual({ data: { success: true } });

        let notification = await models.Notification.first();
        expect(notification.subject).toEqual('Hero Magic Login Link');

        let emailBodyMatch = notification.content.match(/<a\s+href\s*=\s*"(https:\/\/test\.hero\.com\/api\/v1\/auth\/login[^"]+)/i);
        expect(emailBodyMatch).toBeInstanceOf(Array);
        expect(emailBodyMatch.length).toEqual(2);
        expect((/^https:\/\/test\.hero\.com\/api\/v1\/auth\/login\?magicToken=[A-Za-z0-9_=-]+$/).test(emailBodyMatch[1])).toEqual(true);
      });
    });
  });

  describe('Full auth process', () => {
    describe('GET', () => {
      it('can send a magic link and use that to login', async () => {
        // Create the user
        let { user } = await factory.users.create();

        // Send the login link to email
        let result = await app.post('/api/v1/auth/send-magic-link', { data: { email: user.email } });
        expect(result.statusCode).toEqual(200);
        expect(result.body).toEqual({ data: { success: true } });

        expect(await models.InvalidToken.count()).toEqual(0);

        // Capture the login link from the email arguments
        let notification    = await models.Notification.first();
        let emailBodyMatch  = notification.content.match(/<a\s+href\s*=\s*"(https:\/\/test\.hero\.com\/api\/v1\/auth\/login[^"]+)/i);
        let magicToken      = emailBodyMatch[1].match(/magicToken=([A-Za-z0-9_=-]+)$/)[1];

        expect(magicToken).toMatch(URL_SAFE_BASE64_REGEXP);

        // Now authenticate this user using the magic link
        result = await app.get(`/api/v1/auth/login?magicToken=${magicToken}`, { followRedirect: false });
        expect(result.statusCode).toEqual(302);

        // The magicToken should have been
        // marked as invalid (single-use)
        expect(await models.InvalidToken.count()).toEqual(1);
        expect(await models.InvalidToken.isInvalid(magicToken)).toEqual(true);

        // Now verify that the user has a session
        expect(result.headers['location']).toEqual('https://test.hero.com/pages/home');

        let sessionToken = result.headers['x-session-token'];
        expect(sessionToken).toMatch(URL_SAFE_BASE64_REGEXP);
        expect(sessionToken).not.toEqual(magicToken);
      });
    });

    describe('POST', () => {
      it('can send a magic link and use that to login', async () => {
        // Create the user
        let { user } = await factory.users.create();

        // Send the login link to email
        let result = await app.post('/api/v1/auth/send-magic-link', { data: { email: user.email } });
        expect(result.statusCode).toEqual(200);
        expect(result.body).toEqual({ data: { success: true } });

        // Capture the login link from the email arguments
        let notification    = await models.Notification.first();
        let emailBodyMatch  = notification.content.match(/<a\s+href\s*=\s*"(https:\/\/test\.hero\.com\/api\/v1\/auth\/login[^"]+)/i);
        let magicToken      = emailBodyMatch[1].match(/magicToken=([A-Za-z0-9_=-]+)$/)[1];

        expect(magicToken).toMatch(URL_SAFE_BASE64_REGEXP);
        expect(await models.InvalidToken.count()).toEqual(0);

        // Now authenticate this user using the magic link
        result = await app.post('/api/v1/auth/login', { data: { magicToken } });
        expect(result.statusCode).toEqual(200);

        // The magicToken should have been
        // marked as invalid (single-use)
        expect(await models.InvalidToken.count()).toEqual(1);
        expect(await models.InvalidToken.isInvalid(magicToken)).toEqual(true);

        // Now verify that the user has a session
        let sessionToken = result.body.data.sessionToken;
        expect(sessionToken).toMatch(URL_SAFE_BASE64_REGEXP);
        expect(sessionToken).not.toEqual(magicToken);
      });
    });
  });

  describe('registerUser', () => {
    it('should fail without an email', async () => {
      let result = await app.post('/api/v1/auth/register-user');
      expect(result.statusCode).toEqual(400);
      expect(result.body).toEqual('"email" is required');
    });

    it('should properly handle a server error', async () => {
      spyOn(models.User, 'create').and.rejectWith(new Error('Failed!'));

      let result = await app.post('/api/v1/auth/register-user', { data: { email: 'test@example.com' } });
      expect(result.statusCode).toEqual(500);
      expect(result.body).toEqual('Failed to create user');
      expect(result.headers['x-error-code']).toEqual('user-creation-failed');
    });

    it('should succeed with just an email', async () => {
      expect(await models.User.count()).toEqual(0);

      let result = await app.post('/api/v1/auth/register-user', { data: { email: 'test@example.com' } });
      expect(result.statusCode).toEqual(200);

      expect(await models.User.count()).toEqual(1);

      let data = result.body.data;
      expect(data.id).toMatch(PREFIXED_XID_REGEXP);
      expect(data.email).toEqual('test@example.com');
      expect(data.phone).toBe(null);
      expect(data.firstName).toBe(null);
      expect(data.lastName).toBe(null);
      expect(data.dob).toBe(null);
    });

    it('should succeed with all attributes', async () => {
      expect(await models.User.count()).toEqual(0);

      let result = await app.post('/api/v1/auth/register-user', { data: {
        email:      'test@example.com',
        phone:      '987-654-3210',
        firstName:  'Test',
        lastName:   'User',
        dob:        '2000-01-01',
      } });

      expect(result.statusCode).toEqual(200);

      expect(await models.User.count()).toEqual(1);

      let data = result.body.data;
      expect(data.id).toMatch(PREFIXED_XID_REGEXP);
      expect(data.email).toEqual('test@example.com');
      expect(data.phone).toBe('+1-987-654-3210');
      expect(data.firstName).toBe('Test');
      expect(data.lastName).toBe('User');
      expect(data.dob).toBe('2000-01-01');
    });
  });
});
