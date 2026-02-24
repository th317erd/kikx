import Nife                   from 'nife';
import { ControllerAuthBase } from './controller-auth-base.mjs';
import Utils                  from '../utils/index.mjs';

export class UserController extends ControllerAuthBase {
  async update({ params, body }) {
    let userParams = this.getParams({
      'email':      (value) => value.trim().toLowerCase(),
      'phone':      (value) => Utils.formatPhoneNumber(value, 'DB'),
      'firstName':  (value) => value.trim(),
      'lastName':   (value) => value.trim(),
      'dob':        (value) => value.trim(),
    }, [ body ]);

    let userToUpdate = await this.getTargetUser(params.userID, this.currentUser);

    // This will throw a Forbidden error if the user is not allow to do this
    await this.permissible('update:User', userToUpdate);

    try {
      userToUpdate.setAttributes(userParams);
      await userToUpdate.save();
    } catch (error) {
      this.getLogger().error(`UserController::update: Failed to update user "${userToUpdate.id}": `, error);
      this.throwInternalServerError('Failed to update user', 'user-update-failed');
    }

    return { data: await userToUpdate.serializeAttributes() };
  }

  async list({ query, body }, { Organization }) {
    let organizationID = this.currentUser.getCurrentOrganizationID();
    if (!this.isValidID(organizationID, 'Organization'))
      this.throwNotFoundError('User Organization Not Found', 'organization-not-found');

    let { limit, offset, order } = this.getLimitOffsetOrder([ query, body ]);

    try {
      let organization = await Organization.$.id.EQ(organizationID).first();
      if (organization == null)
        this.throwNotFoundError('User Organization Not Found', 'organization-not-found');

      let users = await organization.searchUsers({
        requestingUser: this.currentUser,
        filter:         body.filter,
        limit,
        offset,
        order,
      });

      return {
        data: await Promise.all(users.map((user) => {
          user.setCurrentOrganizationID(organizationID);
          return user.serializeAttributes();
        })),
      };
    } catch (error) {
      this.rethrowIfKnown(error);

      this.getLogger().error(`UserController::list: Error while attempting to list users as user ${this.currentUser.id}: `, error);
      this.throwInternalServerError();
    }
  }

  async show({ params }) {
    let userID  = params.userID;
    let user    = this.currentUser;

    if (userID && userID !== user.id) {
      user = await this.getTargetUser(userID);

      // This will throw a Forbidden error if the user is not allow to do this
      await this.permissible('view:User', user);

      user.setCurrentOrganizationID(this.currentUser.getCurrentOrganizationID());
    }

    return { data: await user.serializeAttributes() };
  }

  async showCurrentUser() {
    let user            = this.currentUser;
    let organizationID  = this.currentUser.getCurrentOrganizationID();

    if (!organizationID) {
      organizationID = await user.getFirstOrganizationID();
      if (Nife.isEmpty(organizationID))
        this.throwForbiddenError('Forbidden', 'user-has-no-organization');

      user.setCurrentOrganizationID(organizationID);

      // Now update the session to store the currentOrganizationID
      let session = this.request.session;
      if (session) {
        session.currentOrganizationID = organizationID;
        await session.save();
      }
    }

    let attributes = await user.serializeAttributes();
    return { data: { ...attributes, currentOrganizationID: organizationID } };
  }

  async setCurrentOrganization({ body }, { User, InvalidToken }) {
    let organizationID = body.organizationID;
    if (!this.isValidID(organizationID, 'Organization'))
      this.throwBadRequestError('"organizationID" required.', 'organization-id-not-provided');

    // This will throw a Forbidden error if the user is not allow to do this
    await this.permissible('view:Organization', organizationID);

    this.currentUser.setCurrentOrganizationID(organizationID);
    let { sessionToken } = await this.currentUser.generateSessionToken({
      scope:        Nife.get(this.request, 'authTokenClaims.scope', 'u'),
      skipMFA:      true,
      isSeedToken:  false,
    });

    let app = this.getApplication();
    let { claims } = await User.validateSessionToken(sessionToken, { onlyVerify: true });

    this.setCookie(this.getAuthTokenCookieName(), sessionToken, {
      domain:   app.getConfigValue('application.{environment}.domain', 'example.com'),
      // eslint-disable-next-line no-magic-numbers
      maxAge:   claims.expiresIn * 1000,
      secure:   true,
      httpOnly: true,
      sameSite: 'Strict',
      path:     '/',
    });

    // Invalidate current token
    if (this.request.currentSessionToken)
      await InvalidToken.createForToken(this.request.currentSessionToken);

    return {
      data: {
        userID:                 this.currentUser.id,
        currentOrganizationID:  organizationID,
        sessionToken,
      },
    };
  }

  async addTags({ params, body }) {
    let { tags, organizationID } = this.getParams({
      'tags!': (value) => Nife.toArray(value).filter((tagName) => {
        if (Nife.isEmpty(tagName))
          return false;

        if (!Nife.instanceOf(tagName, 'string'))
          return false;

        return true;
      }),
      'organizationID': (value) => ('' + value).trim(),
    }, [ body ]);

    if (Nife.isEmpty(tags))
      this.throwBadRequestError('"tags" required', 'tags-not-supplied');

    let userToUpdate = await this.getTargetUser(params.userID);

    // This will throw a Forbidden error if the user is not allow to do this
    await this.permissible('updateUser:Organization', userToUpdate, organizationID);

    try {
      let organization = { id: organizationID || this.currentUser.getCurrentOrganizationID(), type: 'Organization' };
      let savedTags = await userToUpdate.addTags(organization, tags);
      return { data: savedTags };
    } catch (error) {
      this.getLogger().error(`UserController::addTags: Failed to add tags to user "${userToUpdate.id}": `, error);
      this.throwInternalServerError('Failed to add tags to user', 'user-update-failed');
    }
  }

  async removeTags({ params, body }) {
    let { tags, organizationID } = this.getParams({
      'tags!': (value) => Nife.toArray(value).filter((tagName) => {
        if (Nife.isEmpty(tagName))
          return false;

        if (!Nife.instanceOf(tagName, 'string'))
          return false;

        return true;
      }),
      'organizationID': (value) => ('' + value).trim(),
    }, [ body ]);

    if (Nife.isEmpty(tags))
      this.throwBadRequestError('"tags" required', 'tags-not-supplied');

    let userToUpdate = await this.getTargetUser(params.userID);

    // This will throw a Forbidden error if the user is not allow to do this
    await this.permissible('updateUser:Organization', userToUpdate, organizationID);

    try {
      let organization = { id: organizationID || this.currentUser.getCurrentOrganizationID(), type: 'Organization' };

      await userToUpdate.removeTags(organization, tags);

      return { data: await userToUpdate.getTags(organization) };
    } catch (error) {
      this.getLogger().error(`UserController::removeTags: Failed to remove tags from user "${userToUpdate.id}": `, error);
      this.throwInternalServerError('Failed to remove tags from user', 'user-update-failed');
    }
  }
}
