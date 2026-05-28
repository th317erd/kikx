import HELP from './auth-routes-help.mjs';

export function authRoutes({ path }) {
  path('auth', ({ endpoint }) => {
    endpoint('login', {
      name:       'login',
      methods:    [ 'GET', 'POST' ],
      controller: 'AuthController.login',
      help:       HELP.login,
    });

    endpoint('logout', {
      name:       'logout',
      methods:    [ 'POST' ],
      controller: 'AuthController.logout',
      help:       HELP.logout,
    });

    endpoint('send-magic-link', {
      name:       'sendMagicLoginLink',
      methods:    [ 'POST' ],
      controller: 'AuthController.sendMagicLink',
      help:       HELP.sendMagicLoginLink,
    });

    endpoint('register-user', {
      name:       'registerUser',
      methods:    [ 'POST' ],
      controller: 'AuthController.registerUser',
      help:       HELP.registerUser,
    });
  });
}
