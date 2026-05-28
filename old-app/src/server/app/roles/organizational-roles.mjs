export default [
  // Organizational
  {
    // superadmin = highest level admin for an organization (must target an organization)
    source:         'User',
    target:         'Organization',
    name:           'superadmin',
    displayName:    'Super Admin',
    priority:       2,
    isPrimaryRole:  true,
  },
  {
    // admin = normal admin for an organization (must target an organization)
    source:         'User',
    target:         'Organization',
    name:           'admin',
    displayName:    'Admin',
    priority:       3,
    isPrimaryRole:  true,
  },
  {
    // member = normal member user for an organization (must target an organization)
    source:         'User',
    target:         'Organization',
    name:           'member',
    displayName:    'Member',
    priority:       4,
    isPrimaryRole:  true,
  },
  {
    // invite-to-organization = allow a user to invite other users to the organization (must target an organization)
    source:         'User',
    target:         'Organization',
    name:           'invite-to-organization',
    displayName:    'Invite User to Organization',
    priority:       5,
    isPrimaryRole:  false,
  },
];
