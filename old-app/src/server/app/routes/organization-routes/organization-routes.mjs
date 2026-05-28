import HELP from './organization-routes-help.mjs';

export function organizationRoutes({ path, endpoint }) {
  endpoint('organizations', {
    requiresOrgID:  false,
    name:           'createOrganization',
    methods:        [ 'PUT' ],
    controller:     'OrganizationController.create',
    help:           HELP.createOrganization,
  });

  endpoint('organizations', {
    name:       'getOrganizations',
    controller: 'OrganizationController.list',
    help:       HELP.getOrganizations,
  });

  endpoint('organizations', {
    name:       'searchOrganizations',
    methods:    [ 'POST' ],
    controller: 'OrganizationController.list',
    help:       HELP.searchOrganizations,
  });

  path('organization', ({ path, endpoint, capture }) => {
    let organizationID = capture('organizationID');

    endpoint(organizationID, {
      name:       'getOrganization',
      controller: 'OrganizationController.show',
      help:       HELP.getOrganization,
    });

    endpoint(organizationID, {
      name:       'updateOrganization',
      methods:    [ 'PATCH' ],
      controller: 'OrganizationController.update',
      help:       HELP.updateOrganization,
    });

    path(organizationID, ({ path, endpoint }) => {
      endpoint('find', {
        name:       'findAllForOrganization',
        methods:    [ 'POST' ],
        controller: 'OrganizationController.findAllForOrganization',
        help:       HELP.findAllForOrganization,
      });

      endpoint('invite-user', {
        name:       'inviteUserToOrganization',
        methods:    [ 'POST' ],
        controller: 'OrganizationController.inviteUser',
        help:       HELP.inviteUserToOrganization,
      });

      endpoint('search-teams-and-users', {
        name:       'searchTeamsAndUsers',
        methods:    [ 'POST' ],
        controller: 'OrganizationController.searchTeamsAndUsers',
        help:       HELP.searchTeamsAndUsers,
      });

      path('user', ({ path, endpoint, capture }) => {
        let userID = capture('userID');

        endpoint(userID, {
          name:       'removeUserFromOrganization',
          methods:    [ 'DELETE' ],
          controller: 'OrganizationController.removeUser',
          help:       HELP.removeUserFromOrganization,
        });

        endpoint(userID, {
          name:       'updateOrganizationUser',
          methods:    [ 'PATCH' ],
          controller: 'OrganizationController.updateUser',
          help:       HELP.updateOrganizationUser,
        });

        path(userID, ({ endpoint }) => {
          endpoint('avatar', {
            name:       'updateUserAvatar',
            methods:    [ 'PATCH' ],
            controller: 'OrganizationController.updateUserAvatar',
            help:       HELP.updateUserAvatar,
          });
        });
      });
    });
  });
}
