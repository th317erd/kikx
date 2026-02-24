async function _createUser(models, { data, primaryRole, otherRoles, organization }) {
  const {
    User,
    Role,
  } = models;

  let user = await User.where.email.EQ(data.email).first();
  if (user)
    return user;

  console.log(`Creating user ${data.email}...`);

  user = await User.create(data);
  await organization.addUser(user, { userRole: primaryRole });

  if (otherRoles) {
    for (let i = 0, il = otherRoles.length; i < il; i++) {
      let role = otherRoles[i];
      await Role.createFor(user, role, organization);
    }
  }

  return user;
}

// This will seed the DB.
// It can be used by running: `mythix-cli shell` from
// the command line, and then typing "await seedDB()"
// into the shell.
export async function seedDB(app) {
  const models = app.getModels();
  const { Organization } = models;
  const createUser = _createUser.bind(this, models);

  // Create an organization
  let organization = await Organization.where.name.EQ('Test Organization').first();
  if (!organization) {
    console.log('Creating Test Organization...');
    organization = await Organization.create({
      name: 'Test Organization',
    });
  }

  // Create our root user
  await createUser({
    data: {
      email:      'root+user@hero.com',
      firstName:  'Root',
      lastName:   'User',
    },
    primaryRole: 'masteradmin',
    organization,
  });
}
