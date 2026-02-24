import { ControllerAuthBase } from './controller-auth-base.mjs';
import Utils                  from '../utils/index.mjs';

export class OrganizationController extends ControllerAuthBase {
  async create({ body }, { Organization }) {
    let organizationParams = this.getParams({
      'name!': (value) => value.trim(),
    }, [ body ]);

    // This will throw a Forbidden error if the user is not allow to do this
    await this.permissible('create:Organization', organizationParams);

    try {
      let organization = await Organization.create(organizationParams);
      return { data: await organization.serializeAttributes() };
    } catch (error) {
      this.getLogger().error('OrganizationController::create: Failed to create organization: ', error);
      this.throwInternalServerError('Failed to create organization', 'organization-creation-failed');
    }
  }

  async update({ params, body }, { Organization }) {
    let organizationParams = this.getParams({
      'name!': (value) => value.trim(),
    }, [ body ]);

    let targetOrganizationID = params.organizationID;
    if (!Utils.isValidID(targetOrganizationID))
      this.throwBadRequestError('"organizationID" parameter required', 'organization-id-not-supplied');

    let organizationToUpdate = await Organization.$.id.EQ(targetOrganizationID).first();
    if (!organizationToUpdate)
      this.throwNotFoundError('Organization not found', 'organization-not-found');

    // This will throw a Forbidden error if the user is not allow to do this
    await this.permissible('update:Organization', organizationToUpdate, organizationParams);

    try {
      organizationToUpdate.setAttributes(organizationParams);
      await organizationToUpdate.save();
    } catch (error) {
      this.getLogger().error(`OrganizationController::update: Failed to update organization "${organizationToUpdate.id}": `, error);
      this.throwInternalServerError('Failed to update organization', 'organization-update-failed');
    }

    return { data: await organizationToUpdate.serializeAttributes() };
  }

  async updateUser({ params, body }) {
    let userParams = this.getParams({
      'email':      (value) => value.trim().toLowerCase(),
      'phone':      (value) => Utils.formatPhoneNumber(value, 'DB'),
      'firstName':  (value) => value.trim(),
      'lastName':   (value) => value.trim(),
    }, [ body ]);

    if (!Utils.isValidID(params.organizationID))
      this.throwBadRequestError('"organizationID" parameter required', 'organization-id-not-supplied');

    let userToUpdate = await this.getTargetUser(params.userID);

    // This will throw a Forbidden error if the user is not allow to do this
    await this.permissible('updateUser:Organization', userToUpdate, params.organizationID);

    let organizationUserLink = await userToUpdate.getOrganizationUserLink(params.organizationID, false);
    if (!organizationUserLink)
      this.throwNotFoundError('User not found in organization specified', 'user-not-found-in-organization');

    try {
      organizationUserLink.setAttributes(userParams);
      await organizationUserLink.save();
      return { data: await userToUpdate.serializeAttributes(params.organizationID, organizationUserLink) };
    } catch (error) {
      this.getLogger().error(`OrganizationController::updateUser: Failed to update user "${userToUpdate.id}": `, error);
      this.throwInternalServerError('Failed to update user', 'user-update-failed');
    }
  }

  async list({ query, body }) {
    let { limit, offset, order } = this.getLimitOffsetOrder([ query, body ]);

    try {
      let organizations = await this.currentUser.searchOrganizations({
        requestingUser: this.currentUser,
        filter:         body.filter,
        limit,
        offset,
        order,
      });

      return {
        data: await Promise.all(organizations.map((organization) => {
          return organization.serializeAttributes();
        })),
      };
    } catch (error) {
      this.rethrowIfKnown(error);

      this.getLogger().error(`OrganizationController::list: Error while attempting to list organizations as user ${this.currentUser.id}: `, error);
      this.throwInternalServerError();
    }
  }

  async show({ params }, { Organization }) {
    let organizationID = params.organizationID;
    if (!Utils.isValidID(organizationID))
      this.throwBadRequestError('"organizationID" parameter required', 'organization-id-not-supplied');

    // Is user allowed to view this organization?
    //
    // The AuthMiddleware ensures the user can
    // view the organization they already have targeted.
    // So we only need to check this if the organizationIDs
    // differ.
    if (organizationID !== this.currentUser.getCurrentOrganizationID())
      await this.permissible('view:Organization', organizationID);

    let organization = await Organization.$.id.EQ(organizationID).first();

    return { data: await organization.serializeAttributes() };
  }

  async inviteUser({ params, body }, { Organization }) {
    let organizationID = params.organizationID || this.currentUser.getCurrentOrganizationID();
    if (!Utils.isValidID(organizationID))
      this.throwBadRequestError('"organizationID" parameter required', 'organization-id-not-supplied');

    let organization = await Organization.$.id.EQ(organizationID).first();
    if (!organization)
      this.throwNotFoundError('Organization not found', 'organization-not-found');

    await this.permissible('inviteUser:Organization', organization);

    let userParams = this.getParams({
      'email!': (value) => value.trim().toLowerCase(),
      'roles':  null,
    }, [ body ]);

    try {
      let result = await organization.inviteUser(this.currentUser, userParams.email, userParams.roles);

      let responseData = {
        status:         result.status,
        organizationID: organization.id,
        userID:         result.user.id,
      };

      if (result.status === 'not-modified') {
        // eslint-disable-next-line no-magic-numbers
        this.setStatusCode(201);
      } else {
        this.setStatusCode(200);
        responseData.addedRoles = result.addedRoles;
      }

      return {
        data: responseData,
      };
    } catch (error) {
      this.rethrowIfKnown(error);

      this.getLogger().error(`OrganizationController::inviteUser: Error while attempting to invite user "${userParams.email}" to organization "${organizationID}" as user ${this.currentUser.id}: `, error);
      this.throwInternalServerError();
    }
  }

  async removeUser({ params }, { Organization }) {
    let organizationID = params.organizationID || this.currentUser.getCurrentOrganizationID();
    if (!Utils.isValidID(organizationID))
      this.throwBadRequestError('"organizationID" parameter required', 'organization-id-not-supplied');

    let userID = params.userID;
    if (!Utils.isValidID(userID))
      this.throwBadRequestError('"userID" parameter required', 'user-id-not-supplied');

    let user = await this.getTargetUser(userID);

    // This will throw if the current user doesn't have the correct permissions
    await this.permissible('removeUser:Organization', user, organizationID);

    let organization = await Organization.$.id.EQ(organizationID).first();
    if (!organization)
      this.throwNotFoundError('Organization not found', 'organization-not-found');

    try {
      await organization.removeUser(user);

      return {
        data: {
          status:         'removed',
          organizationID: organization.id,
          userID:         user.id,
        },
      };
    } catch (error) {
      this.rethrowIfKnown(error);

      this.getLogger().error(`OrganizationController::removeUser: Error while attempting to remove user "${userID}" from organization "${organizationID}" as user ${this.currentUser.id}: `, error);
      this.throwInternalServerError();
    }
  }

  async updateUserAvatar({ params, body }, { User }) {
    let {
      organizationID,
      userID,
    } = params;

    if (!Utils.isValidID(organizationID))
      this.throwBadRequestError('"organizationID" parameter required', 'organization-id-not-supplied');

    if (!Utils.isValidID(userID))
      this.throwBadRequestError('"userID" parameter required', 'user-id-not-supplied');

    let userToUpdate = await User.$.id.EQ(userID).first();
    if (!userToUpdate)
      this.throwNotFoundError('User not found', 'user-not-found');

    userToUpdate.setCurrentOrganizationID(organizationID);

    // This will throw a Forbidden error if the user is not allow to do this
    await this.permissible('updateUser:Organization', userToUpdate, organizationID);

    let contentType = this.contentType;
    let urls;

    if (('' + contentType).match(/application\/json/i)) {
      let avatarParams = this.getParams({
        'fileName!':  (value) => value.trim(),
        'file!':      null,
      }, [ body ]);

      let fileContents = Buffer.from(avatarParams.file, 'base64');

      urls = await userToUpdate.updateAvatar(
        organizationID,
        {
          fileName: avatarParams.fileName,
          contents: fileContents,
        },
      );
    } else if (('' + contentType).match(/multipart\/form-data/i)) {
      let { file } = this.getAndVerifyRequestFiles();
      if (!file)
        this.throwBadRequestError('"file" field required in multipart upload', 'file-not-supplied');

      urls = await userToUpdate.updateAvatar(organizationID, file);
    }

    return { data: { organizationID, ...(urls || {}) } };
  }
}
