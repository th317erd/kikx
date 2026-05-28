export default [
  // Non-organizational
  {
    // masteradmin  = root level user, they can do anything, for any organization
    source:         'User',
    target:         null,
    name:           'masteradmin',
    displayName:    'Master Admin',
    priority:       0,
    isPrimaryRole:  true,
  },
  {
    // support = near-root level user, they can do almost anything, for any organization
    source:         'User',
    target:         null,
    name:           'support',
    displayName:    'Support Staff',
    priority:       1,
    isPrimaryRole:  true,
  },
];
