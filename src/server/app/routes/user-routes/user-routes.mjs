import HELP from './user-routes-help.mjs';

export function userRoutes({ path, endpoint }) {
  endpoint('user', {
    requiresOrgID:  false,
    name:           'getCurrentUser',
    controller:     'UserController.showCurrentUser',
    help:           HELP.getCurrentUser,
  });

  endpoint('user', {
    requiresOrgID:  false,
    name:           'updateCurrentUser',
    methods:        [ 'PATCH' ],
    controller:     'UserController.update',
    help:           HELP.updateCurrentUser,
  });

  endpoint('users', {
    name:       'getUsers',
    controller: 'UserController.list',
    help:       HELP.getUsers,
  });

  endpoint('users', {
    name:       'searchUsers',
    methods:    [ 'POST' ],
    controller: 'UserController.list',
    help:       HELP.searchUsers,
  });

  path('user', ({ path, endpoint, capture }) => {
    let userID = capture('userID');

    endpoint('set-current-organization', {
      requiresOrgID:  false,
      name:           'setCurrentOrganization',
      methods:        [ 'POST' ],
      controller:     'UserController.setCurrentOrganization',
      help:           HELP.setCurrentOrganization,
    });

    endpoint(userID, {
      name:       'getUser',
      controller: 'UserController.show',
      help:       HELP.getUser,
    });

    endpoint(userID, {
      name:       'updateUser',
      methods:    [ 'PATCH' ],
      controller: 'UserController.update',
      help:       HELP.updateUser,
    });

    path(userID, ({ endpoint }) => {
      endpoint('tags', {
        name:       'addUserTags',
        methods:    [ 'PUT' ],
        controller: 'UserController.addTags',
        help:       HELP.addUserTags,
      });

      endpoint('tags', {
        name:       'removeUserTags',
        methods:    [ 'DELETE' ],
        controller: 'UserController.removeTags',
        help:       HELP.removeUserTags,
      });
    });
  });
}
