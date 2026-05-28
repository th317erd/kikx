/* eslint-disable key-spacing */

export default {
  login: {
    'description': 'This method will log a user in.',
    'data': [
      {
        'property':     'magicToken',
        'type':         'string',
        'description':  'Magic token',
        'required':     true,
      },
    ],
    'example': 'await API.login({ data: { magicToken: \'Some Token\' } });',
    'notes': [
      'Upon success, if MFA is enabled for the user, an MFA page url will be returned',
      'Upon success, an auth cookie will be set to authenticate the user',
      'Upon success, the session token will be returned',
    ],
  },
  logout: {
    'description': 'This method will log the user out, invalidating their current session token.',
    'example': 'await API.logout();',
    'notes': [
      'Upon success, a 200 status code will be returned, and the auth cookie will be set to "null" and the "maxAge" will be set to "0", causing the cookie to be deleted.',
      'If the user session couldn\'t be found (i.e. the user is not logged in), then a 201 response code will be returned and nothing will have been modified.',
    ],
  },
  sendMagicLoginLink: {
    'description': 'This method will send the specified user an email containing a magic login link.',
    'data': [
      {
        'property':     'email',
        'type':         'string',
        'description':  'Email address of user',
        'required':     true,
      },
    ],
    'example': 'await API.sendMagicLink({ data: { email: \'some+user@example.com\' } });',
    'notes': [
      'If the specified user is not found, then a 404 response will be returned',
    ],
  },
  registerUser: {
    'description': 'This method will create a new user and email them a magic login link.',
    'data': [
      {
        'property':     'email',
        'type':         'string',
        'description':  'Email address of user',
        'required':     true,
      },
      {
        'property':     'firstName',
        'type':         'string',
        'description':  'First name of the user',
        'required':     false,
      },
      {
        'property':     'lastName',
        'type':         'string',
        'description':  'Last name of the user',
        'required':     false,
      },
      {
        'property':     'phone',
        'type':         'string',
        'description':  'Phone number for the user',
        'required':     false,
      },
      {
        'property':     'dob',
        'type':         'string',
        'description':  'Date of birth for the user (format yyyy-MM-dd)',
        'required':     false,
      },
    ],
    'example': 'await API.registerUser({ data: { email: \'some+user@example.com\', firstName: \'Test\', lastName: \'User\' } });',
    'notes': [
      'Upon success, the specified users data is returned',
      'For security reasons, if the user specified already exists, then a 400 bad request will be returned instead of the users data',
    ],
  },
};
