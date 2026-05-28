/* eslint-disable no-magic-numbers */
/* eslint-disable camelcase */

import Nife from 'nife';
import TWT from 'mythix-twt';

import {
  createTestApplication,
  createFactories,
  createRunners,
  URL_SAFE_BASE64_REGEXP,
} from '../../../support/application.mjs';

import * as Permissions from '../../../../app/permissions/index.mjs';

describe('AuthMiddleware', function() {
  let app;
  // let models;
  let factory;

  // eslint-disable-next-line no-unused-vars
  const { it, fit } = createRunners(() => app.getConnection());

  beforeAll(async () => {
    app = await createTestApplication();
    factory = createFactories(app);
    // models = app.getModels();
  });

  afterAll(async () => {
    await app.stop();
  });

  afterEach(async () => {
    factory.reset();

    jasmine.clock().uninstall();
    await app.truncateAllTables();
  });

  const fetchValues = (args) => args;

  it('should throw an error if the organizationID is missing', async () => {
    let { user }          = await factory.users.create();
    let { sessionToken }  = await user.generateSessionToken({ isSeedToken: false });

    let result = await app.patch(`/api/v1/user/${user.id}`, {
      data: {
        email: 'test@example.com',
      },
      headers: {
        'Authorization': `Bearer ${sessionToken}`,
      },
    });

    expect(result.statusCode).toEqual(400);
    expect(result.body).toEqual('"organizationID" is required');
  });

  it('should accept an organizationID as a header', async () => {
    let { user, organization } = await factory.users.createWithOrganization(fetchValues);
    let { sessionToken }  = await user.generateSessionToken({ isSeedToken: false });

    let result = await app.patch(`/api/v1/user/${user.id}`, {
      data: {
        email: 'test@example.com',
      },
      headers: {
        'Authorization':      `Bearer ${sessionToken}`,
        'X-Organization-ID':  organization.id,
      },
    });

    expect(result.statusCode).toEqual(200);
  });

  it('should accept an organizationID as a body param', async () => {
    let { user, organization } = await factory.users.createWithOrganization(fetchValues);
    let { sessionToken }  = await user.generateSessionToken({ isSeedToken: false });

    let result = await app.patch(`/api/v1/user/${user.id}`, {
      data: {
        email:          'test@example.com',
        organizationID: organization.id,
      },
      headers: {
        'Authorization': `Bearer ${sessionToken}`,
      },
    });

    expect(result.statusCode).toEqual(200);
  });

  it('should accept an organizationID as a query param', async () => {
    let { user, organization } = await factory.users.createWithOrganization(fetchValues);
    let { sessionToken } = await user.generateSessionToken({ isSeedToken: false });

    let result = await app.patch(`/api/v1/user/${user.id}?organizationID=${organization.id}`, {
      data: {
        email: 'test@example.com',
      },
      headers: {
        'Authorization': `Bearer ${sessionToken}`,
      },
    });

    expect(result.statusCode).toEqual(200);
  });

  it('should be able to use a cookie to authenticate', async () => {
    let { user, organization } = await factory.users.createWithOrganization(fetchValues);
    let { sessionToken: magicToken } = await user.generateSessionToken();

    let result = await app.get(`/api/v1/auth/login?magicToken=${magicToken}`, {
      data: {
        email: user.email,
      },
      followRedirect: false,
    });

    expect(result.statusCode).toEqual(302);
    expect(Nife.isEmpty(result.headers['set-cookie'])).toEqual(false);

    let sessionToken = result.headers['x-session-token'];
    expect(sessionToken).toMatch(URL_SAFE_BASE64_REGEXP);

    let userUpdateResult = await app.patch(`/api/v1/user/${user.id}`, {
      data: {
        email:          'test@example.com',
        organizationID: organization.id,
      },
      headers: {
        'cookie': `${app.getAuthTokenCookieName()}=${sessionToken};`,
      },
    });

    expect(userUpdateResult.statusCode).toEqual(200);
  });

  it('should fail with a bad token', async () => {
    let { user, organization } = await factory.users.createWithOrganization(fetchValues);

    let userUpdateResult = await app.patch(`/api/v1/user/${user.id}`, {
      data: {
        email:          'test@example.com',
        organizationID: organization.id,
      },
      headers: {
        'Authorization': 'Token bae0560c-9e8f-4360-81c4-c42648720238',
      },
    });

    expect(userUpdateResult.statusCode).toEqual(401);
  });

  it('should fail with an invalid session', async () => {
    let { user, organization } = await factory.users.createWithOrganization(fetchValues);
    jasmine.clock().install();
    jasmine.clock().mockDate(new Date(0));

    let sessionToken = TWT.generateTWT(
      {
        s:    'u',
        u:    user.id,
        o:    organization.id,
        mfa:  0,
        st:   0,
      },
      { encodedSecret: app.getSalt() },
    );

    jasmine.clock().uninstall();

    let userUpdateResult = await app.patch(`/api/v1/user/${user.id}`, {
      data: {
        email:          'test@example.com',
        organizationID: organization.id,
      },
      headers: {
        'Authorization': `Bearer ${sessionToken}`,
      },
    });

    expect(userUpdateResult.statusCode).toEqual(401);
  });

  it('should fail if the user can not be loaded', async () => {
    let { user, organization } = await factory.users.createWithOrganization(fetchValues);

    jasmine.clock().install();
    jasmine.clock().mockDate(new Date(0));

    let sessionToken = TWT.generateTWT(
      {
        s:    'u',
        u:    'USR_cd06dx7qqwpgbh6yqp3g',
        o:    organization.id,
        mfa:  0,
        st:   0,
      },
      { encodedSecret: app.getSalt() },
    );

    jasmine.clock().uninstall();

    let userUpdateResult = await app.patch(`/api/v1/user/${user.id}`, {
      data: {
        email:          'test@example.com',
        organizationID: organization.id,
      },
      headers: {
        'Authorization': `Bearer ${sessionToken}`,
      },
    });

    expect(userUpdateResult.statusCode).toEqual(401);
  });

  it('should fail with an organization the user is not permitted to interact with', async () => {
    let { user } = await factory.users.createWithOrganization(fetchValues);
    let { sessionToken }  = await user.generateSessionToken({ isSeedToken: false });

    let { organization: otherOrganization } = await factory.organizations.create();

    let userUpdateResult = await app.patch(`/api/v1/user/${user.id}`, {
      data: {
        email:          'test@example.com',
        organizationID: otherOrganization.id,
      },
      headers: {
        'Authorization': `Bearer ${sessionToken}`,
      },
    });

    expect(userUpdateResult.statusCode).toEqual(403);
  });

  it('should fail with an organization the user is not permitted to interact with (error thrown)', async () => {
    let { user } = await factory.users.createWithOrganization(fetchValues);
    let { sessionToken }  = await user.generateSessionToken({ isSeedToken: false });

    let { organization: otherOrganization } = await factory.organizations.create();

    spyOn(Permissions.PermissionBase, 'permissible').and.resolveTo(new Error('Failed!'));

    let userUpdateResult = await app.patch(`/api/v1/user/${user.id}`, {
      data: {
        email:          'test@example.com',
        organizationID: otherOrganization.id,
      },
      headers: {
        'Authorization': `Bearer ${sessionToken}`,
      },
    });

    expect(userUpdateResult.statusCode).toEqual(403);
  });

  it('should fail with internal server error if something goes wrong', async () => {
    let { user } = await factory.users.createWithOrganization(fetchValues);
    let { sessionToken }  = await user.generateSessionToken({ isSeedToken: false });

    let { organization: otherOrganization } = await factory.organizations.create();

    spyOn(Permissions.PermissionBase, 'permissible').and.rejectWith(new Error('Failed!'));

    let userUpdateResult = await app.patch(`/api/v1/user/${user.id}`, {
      data: {
        email:          'test@example.com',
        organizationID: otherOrganization.id,
      },
      headers: {
        'Authorization': `Bearer ${sessionToken}`,
      },
    });

    expect(userUpdateResult.statusCode).toEqual(500);
    expect(userUpdateResult.body).toEqual('Internal Server Error');
  });
});
