import { getValues } from './factory-utils.mjs';

export async function create({ data, organization, addToOrganization, userRole }, callback) {
  const { User, Role } = this.getModels();

  let userData = getValues({
    email:      'test{#}@example.com',
    phone:      '15604520919',
    firstName:  'Test',
    lastName:   'User',
    dob:        '2000-01-01',
  }, data);

  let user = await User.create(userData);
  let role;

  if (organization && addToOrganization !== false) {
    role = await organization.addUser(user, { userRole });
    user.setCurrentOrganizationID(organization.id);
  } else if (userRole) {
    role = await Role.createFor(user, userRole, organization);
  }

  if (typeof callback === 'function')
    return await callback.call(this, Object.assign({}, arguments[0], { user, role, organization }));

  return { user, organization, role };
}

export async function createWithOrganization(args, callback) {
  const { Organization } = this.getModels();

  let organization = args.organization;
  if (!organization) {
    organization = await Organization.create(getValues({
      name: 'Test',
    }, args.orgData));
  }

  return await create.call(
    this,
    {
      data:               args.userData,
      addToOrganization:  args.addToOrganization,
      userRole:           args.userRole,
      organization,
    },
    callback,
  );
}

export async function createAndLogin(args, callback) {
  let result = await createWithOrganization.call(
    this,
    {
      userData:           args.userData,
      orgData:            args.orgData,
      organization:       args.organization,
      userRole:           args.userRole,
      addToOrganization:  args.addToOrganization,
    },
    (args) => args,
  );

  let { sessionToken } = await result.user.generateSessionToken({
    skipMFA:      true,
    isSeedToken:  false,
  });

  this.setDefaultHeader('Authorization', `Bearer ${sessionToken}`);
  this.setDefaultHeader('X-Organization-ID', result.organization.id);

  if (typeof callback === 'function')
    return await callback.call(this, Object.assign({}, arguments[0], result, { sessionToken }));

  return { ...result, sessionToken };
}
