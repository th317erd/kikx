import FileSystem from 'node:fs';
import Nife       from 'nife';
import TWT        from 'mythix-twt';

import {
  Types,
  CryptoUtils,
} from 'mythix';

import { TaggableBase } from './taggable-base.mjs';
import { PermissionBase } from '../permissions/index.mjs';
import Utils from '../utils/index.mjs';

 
const AVATAR_SIZES  = [ 48, 196, 512 ];
const TWT_KEY_MAP   = {
  s:    'scope',
  u:    'userID',
  o:    'organizationID',
  mfa:  'isMFARequired',
  st:   'isSeedToken',
};
const TWT_SCOPE_MAP = {
  'a':  'admin',
  's':  'system',
  'u':  'user',
};

export class User extends TaggableBase {
  static fields = {
    ...(TaggableBase.fields || {}),
    id: {
      type:         Types.XID({ prefix: Utils.getModelIDPrefixFor('User') }),
      defaultValue: Types.XID.Default.XID,
      allowNull:    false,
      primaryKey:   true,
    },
    email: {
      type:         Types.STRING(64),
      allowNull:    false,
      index:        true,
      unique:       true,
    },
    phone: {
      type:         Types.STRING(32),
      allowNull:    true,
      index:        true,
    },
    firstName: {
      type:         Types.STRING(32),
      allowNull:    true,
      index:        true,
    },
    lastName: {
      type:         Types.STRING(32),
      allowNull:    true,
      index:        true,
    },
    dob: {
      type:         Types.DATE,
      allowNull:    true,
      index:        true,
    },
    organizationRoles: {
      type:         Types.Models('Role', ({ self }, { Role }, userQuery) => {
        return Role
            .$.DISTINCT
            .sourceID
              .EQ(self.id)
            .sourceType
              .EQ('User')
            .targetType
              .EQ('Organization')
            .MERGE(userQuery);
      }),
    },
    roles: {
      type:         Types.Models('Role', async ({ self }, { Role }, userQuery) => {
        return Role
            .$.DISTINCT
            .sourceID
              .EQ(self.id)
            .sourceType
              .EQ('User')
            .MERGE(userQuery);
      }),
    },
    organizationLinks: {
      type:         Types.Models('OrganizationUserLink', ({ self }, { OrganizationUserLink }, userQuery) => {
        return OrganizationUserLink.$.userID.EQ(self.id).MERGE(userQuery);
      }),
    },
    organizations: {
      type:         Types.Models('Organization', ({ self }, { Organization, OrganizationUserLink }, userQuery) => {
        return Organization
            .$.id
              .EQ(OrganizationUserLink.$.organizationID)
            .AND
            .OrganizationUserLink.userID
              .EQ(self.id)
            .MERGE(userQuery);
      }),
    },
  };

  constructor(...args) {
    super(...args);

    Object.defineProperties(this, {
      'currentOrganizationID': {
        writable:     true,
        enumberable:  false,
        configurable: true,
        value:        null,
      },
    });
  }

  async onBeforeSave(...args) {
    if (this.email)
      this.email = ('' + this.email).trim().toLowerCase();

    return await super.onBeforeSave(...args);
  }

  // Users always have an "active" or "current"
  // organization they are targeting. The client
  // application is expected to provide this.
  // via the "X-Organization-ID" header on
  // requests.
  getCurrentOrganizationID() {
    return this.currentOrganizationID;
  }

  setCurrentOrganizationID(id) {
    this.currentOrganizationID = id;
  }

  async getFirstOrganizationID() {
    // Support staff and masteradmins can view anything
    if (await this.hasRolesFor(null, { names: [ 'support', 'masteradmin' ] })) {
      let { Organization }  = this.getModels();
      let organizationIDs   = await Organization.where.ORDER('Organization:name').LIMIT(1).pluck('Organization:id');

      return (organizationIDs && organizationIDs[0]);
    }

    let query           = await this.queryForOrganizations();
    let organizationIDs = await query.ORDER('Organization:name').LIMIT(1).pluck('Organization:id');

    return (organizationIDs && organizationIDs[0]);
  }

  // This eventually needs to be hooked up to a
  // user setting that the user can toggle on or off.
  mfaEnabled() {
    return false;
  }

  async serializeAttributes(_organizationID, _userOrganizationLink) {
    let organizationID        = _organizationID || this.getCurrentOrganizationID();
    let organizationUserLink  = _userOrganizationLink || {};
    let roles;
    let tags;

    if (organizationID) {
      if (Nife.isEmpty(organizationUserLink)) {
        try {
          organizationUserLink = await this.getOrganizationUserLink(organizationID);
           
        } catch (error) {}
      }

      roles = await this.getRolesFor({ id: organizationID, type: 'Organization' }, { namesOnly: true });
      tags = await this.getTags(organizationID);
    } else {
      roles = await this.getRolesFor(null, { namesOnly: true });
    }

    // We first call toJSON to format the model fields
    let userData                  = this.toJSON();
    let organizationUserLinkData  = {};

    if (organizationUserLink) {
      if (typeof organizationUserLink.toJSON === 'function')
        organizationUserLinkData = organizationUserLink.toJSON();
    }

    return Object.assign(
      {},
      userData,
      {
        email:      organizationUserLinkData.email || userData.email,
        phone:      Utils.formatPhoneNumber(organizationUserLink.phone || userData.phone || null),
        firstName:  organizationUserLinkData.firstName || userData.firstName || null,
        lastName:   organizationUserLinkData.lastName || userData.lastName || null,
        roles:      (roles || []).sort(),
        tags:       (tags || []).sort(),
        dob:        userData.dob || null,
      },
    );
  }

  static async validateSessionToken(authToken, _options) {
    if (Nife.isEmpty(authToken))
      throw new Error('Invalid "authToken" provided');

    let options = _options || {};
    let app     = this.getApplication();
    let claims  = TWT.verifyTWT(authToken, {
      encodedSecret:  app.getSalt(),
      keyMap:         TWT_KEY_MAP,
    });

    if (options.onlyVerify === true)
      return { claims };

    if (options.skipMFACheck !== true && claims.isMFARequired)
      throw new Error('MFA required');

    // Seed tokens are valid tokens, and
    // are used as the "magicToken". By
    // themselves they are not valid for
    // authentication... however they are
    // valid to generate a session token
    // for the user.
    if (options.skipSeedCheck !== true && claims.isSeedToken)
      throw new Error('Seed token not valid for authentication');

    if (!Object.prototype.hasOwnProperty.call(TWT_SCOPE_MAP, claims.scope))
      throw new Error('Invalid or unknown "scope" on provided token');

    let {
      User,
      InvalidToken,
    } = this.getModels();

    if (await InvalidToken.isInvalid(authToken))
      throw new Error('Token has been recorded as no longer valid');

    let user = await User.where.id.EQ(claims.userID).first();
    if (!user)
      throw new Utils.NotFoundError('User not found');

    if (claims.organizationID)
      user.setCurrentOrganizationID(claims.organizationID);

    return {
      scope: TWT_SCOPE_MAP[claims.scope] || 'user',
      claims,
      user,
    };
  }

  // Generate a session token for this user.
  // This is a TWT (tiny web token) that
  // will be used to authorize the user.
  async generateSessionToken(_options) {
    const getScope = (scope) => {
      if (Object.prototype.hasOwnProperty.call(TWT_SCOPE_MAP, scope))
        return scope;

      let keys = Object.keys(TWT_SCOPE_MAP);
      for (let i = 0, il = keys.length; i < il; i++) {
        let key   = keys[i];
        let value = TWT_SCOPE_MAP[key];

        if (value === scope)
          return key;
      }

      throw new Error(`Unknown scope provided: "${scope}"`);
    };

    let options = _options || {};
    let scope   = (options.scope) ? getScope(options.scope) : null;

    if (!scope) {
      if (await this.hasRolesFor(this.getCurrentOrganizationID() || undefined, { names: [ 'masteradmin', 'support' ], namesOnly: true }))
        scope = 'a';
      else
        scope = 'u';
    }

    let app           = this.getApplication();
    let mfaEnabled    = (options.skipMFA) ? false : this.mfaEnabled();
    let sessionToken  = TWT.generateTWT(
      {
        s:    scope || 'u',
        u:    this.id,
        o:    this.getCurrentOrganizationID() || undefined,
        mfa:  (mfaEnabled) ? 1 : 0,

        // Seed tokens are valid tokens, and
        // are used as the "magicToken". By
        // themselves they are not valid for
        // authentication... however they are
        // valid to generate a session token
        // for the user.
        st:   (options.isSeedToken === false) ? 0 : 1,
      },
      {
        validAt:        options.validAt,
        expiresAt:      options.expiresAt,
        encodedSecret:  app.getSalt(),
      },
    );

    let magicLinkURL = app.getConfigValue('application.{environment}.magicLinkURL');
    return { sessionToken, magicLinkURL: `${magicLinkURL}?magicToken=${sessionToken}` };
  }

  // This method will send a "magic login link" to this user
  async requestLoginToken(options) {
    let { magicLinkURL } = await this.generateSessionToken(options);

    return await this.sendEmail(
      'auth/signIn',
      {
        user: this,
        magicLinkURL,
      },
    );
  }

  // Check if this user has permissions for any specific action
  async permissible(...args) {
    return await PermissionBase.permissible(this.getApplication(), this, ...args);
  }

  async getRolesFor(target, _options) {
    const { Role } = this.getModels();

    let options     = _options || {};
    let targetType  = this.getModelTypeAndID(target);
    let targetQuery;

    if (targetType) {
      targetQuery = Role.$.targetType.EQ([ null, targetType.type || null ]);

      if (targetType.id)
        targetQuery = targetQuery.targetID.EQ([ null, targetType.id ]);
      else
        targetQuery = targetQuery.targetID.EQ([ null ]);
    }

    let query = await this.queryForRoles(targetQuery);

    if (Nife.isNotEmpty(options.names)) {
      let names = Nife.toArray(options.names).filter(Boolean);
      if (Nife.isNotEmpty(names))
        query = query.name.EQ(names);
    }

     
    query = query.LIMIT(options.limit || 500).OFFSET(options.offset || 0).ORDER(options.order || '+Role:name');

    if (options.namesOnly)
      return await query.pluck('Role:name', options);

    return await query.all(options);
  }

  async hasRolesFor(target, opts) {
    if (Nife.isEmpty(opts))
      return false;

    let names = Nife.toArray(opts.names).filter(Boolean).sort();
    if (Nife.isEmpty(names))
      return false;

    let roles = await this.getRolesFor(target, Object.assign({}, opts, { names, namesOnly: true }));
    roles = roles.sort();

    if (opts.exact) {
      if (Nife.propsDiffer(names, roles))
        return false;

      return roles;
    }

    if (Nife.isEmpty(roles))
      return false;

    return roles;
  }

  getOrganizationID(_organizationOrID) {
    let { type, id: organizationID } = (this.getModelTypeAndID(_organizationOrID) || {});
    if (!this.isValidID(organizationID) || (type && type !== 'Organization'))
      organizationID = this.getCurrentOrganizationID();

    return organizationID;
  }

  // This gets the User <-> Organization link (UserOrganizationLink model)
  // for the given user/org combo. A number of different things is stored
  // on this model, including the user's avatar (which is different per-organization).
  async getOrganizationUserLink(_organizationOrID, throwError) {
    let { type, id: organizationID } = (this.getModelTypeAndID(_organizationOrID) || {});
    if (Nife.isEmpty(organizationID) || (type && type !== 'Organization')) {
      if (throwError !== false)
        throw new Error('User::getOrganizationUserLink: Organization ID is required to get user organization link.');

      return;
    }

    let organizationLinks = await this.getOrganizationLinks({ organizationID });
    if (Nife.isEmpty(organizationLinks)) {
      if (throwError !== false)
        throw new Error(`User::getOrganizationUserLink: Unable to locate specified organization ${organizationID}`);

      return;
    }

    return organizationLinks[0];
  }

  async isMemberOfOrganization(_organizationOrID, options) {
    let { type, id: organizationID } = (this.getModelTypeAndID(_organizationOrID) || {});
    if (Nife.isEmpty(organizationID) || (type && type !== 'Organization'))
      return false;

    return await this.hasOrganizations({ id: organizationID }, options);
  }

  async getOrganizationByID(_organizationOrID, options) {
    let { type, id: organizationID } = (this.getModelTypeAndID(_organizationOrID) || {});
    if (Nife.isEmpty(organizationID) || (type && type !== 'Organization'))
      throw new Error('User::getOrganizationByID: Organization ID is required to get user organization link.');

    let organizations = await this.searchOrganizations({ id: organizationID }, options);
    return organizations[0];
  }

  async updateAvatar(organizationID, fileInfo) {
    const resizeAvatar = (fileName, fileContents, avatarSize) => {
      return new Promise((resolve, reject) => {
        graphicsMagick(fileContents, fileName)
            .resize(avatarSize, avatarSize)
            // Strip EXIF data to remove image location data (if any)
            .noProfile()
            .toBuffer('PNG', function (error, buffer) {
              if (error) {
                reject(error);
                return;
              }

              resolve(buffer);
            });
      });
    };

    const resizeAndUploadAvatars = async (originalFileName, fileName, fileContents) => {
      let app   = this.getApplication();
      let aws   = app.getAWS();
      let urls  = [];
      let baseURL;

      for (let i = 0, il = AVATAR_SIZES.length; i < il; i++) {
        let avatarSize  = AVATAR_SIZES[i];
        let content     = await resizeAvatar(originalFileName, fileContents, avatarSize);

        let result = await aws.uploadToS3({
          folder:       'user-avatars',
          fileName:     `${fileName}-${avatarSize}.png`,
          contentType:  'image/png',
          content,
        });

        if (!baseURL) {
          let index = result.indexOf(fileName);
          baseURL = result.substring(0, index + fileName.length);
        }

        urls.push(result);
      }

      if (filePath && !fileInfo.contents) {
        try {
          FileSystem.rmSync(filePath, { force: true, recursive: false });
        } catch (error) {
          // NOOP
        }
      }

      return { baseURL, urls };
    };

    let {
      fileName,
      filePath,
    } = fileInfo;

    let fileContents = (!filePath && fileInfo.contents) ? fileInfo.contents : FileSystem.readFileSync(filePath);

    let urls = await resizeAndUploadAvatars(
      fileName,
      CryptoUtils.MD5(`${this.id}:${organizationID}`),
      fileContents,
    );

    let organizationUserLink = await this.getOrganizationUserLink(organizationID);
    organizationUserLink.userAvatarURL = urls.baseURL;
    await organizationUserLink.save();

    return urls;
  }

  async searchOrganizations(_options) {
    const {
      Organization,
      Role,
    } = this.getModels();

    let options = _options || {};
    let {
      filter,
      limit,
      order,
      offset,
    } = options;

    if (limit == null)
     
      limit = 20;

    if (order == null)
      order = '+Organization:name';

    if (offset == null)
      offset = 0;

    let query = (Nife.isNotEmpty(filter)) ? this.generateQueryFromFilter(Organization, filter) : Organization.where;

    query = query.LIMIT(limit).OFFSET(offset).ORDER(order);

    let roles = await this.getRolesFor(null, { connection: options.connection, namesOnly: true });
    if (Nife.isNotEmpty(roles)) {
      let highestLevelRole = Role.getHighestLevelRoleName(roles, [ 'User' ], [ null, 'Organization' ], { primaryRoles: true });

      // If masteradmin or support user, let them list
      // all organizations
      if (highestLevelRole === 'masteradmin' || highestLevelRole === 'support')
        return await query.all(options);
    }

    // Reset query to go through organization links
    return await this._getOrganizations.call(this, query, options);
  }
}
