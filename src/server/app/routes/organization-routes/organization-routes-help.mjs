/* eslint-disable key-spacing */

export default {
  getOrganization: {
    'description': 'This method will return the specified organization data.',
    'params': [
      {
        'property':     'organizationID',
        'type':         'string',
        'description':  'ID of organization to show',
        'required':     true,
      },
    ],
    'example': 'await API.getOrganization({ params: { organizationID: \'some-organization-id\' } });',
    'notes': [
      'You will receive a 403 Forbidden response if you don\'t have the permission level to read the specified organization',
    ],
  },
  updateOrganization: {
    'description': 'This method will update the specified organization with the data provided.',
    'data': [
      {
        'property':     'name',
        'type':         'string',
        'description':  'Name of the organization',
        'required':     true,
      },
    ],
    'params': [
      {
        'property':     'organizationID',
        'type':         'string',
        'description':  'ID of organization to update',
        'required':     true,
      },
    ],
    'example': 'await API.updateOrganization({ data: { name: \'New Name of Organization\' }, params: { organizationID: \'some-organization-id\' } });',
    'notes': [
      'You will receive a 403 Forbidden response if you don\'t have the permission level to update the specified organization',
      'The updated organization will be returned as the response',
    ],
  },
  findAllForOrganization: {
    'description': 'This method search for all data matching the provided search term in the organization specified.',
    'data': [
      {
        'property':     'search',
        'type':         'string',
        'description':  'Search term',
        'required':     true,
      },
      {
        'property':     'words',
        'type':         'boolean',
        'description':  'If true, then split the search term into individual words',
        'required':     false,
      },
    ],
    'params': [
      {
        'property':     'organizationID',
        'type':         'string',
        'description':  'ID of organization to find data in',
        'required':     true,
      },
    ],
    'example': 'await API.findAllForOrganization({ data: { search: \'test\', words: false }, params: { organizationID: \'some-organization-id\' } });',
    'notes': [
      'You will receive a 403 Forbidden response if you don\'t have the permission level to interact with the organization',
      'The "words" parameter, if "true" will split the provided search term into individual words, and search on each word, instead of searching against the entire search term',
    ],
  },
  inviteUserToOrganization: {
    'description': 'This method will invite the specified user to the specified organization.',
    'data': [
      {
        'property':     'email',
        'type':         'string',
        'description':  'Email of user to invite',
        'required':     true,
      },
      {
        'property':     'roles',
        'type':         'Array<string>',
        'description':  'Roles to assign to invited user',
        'required':     false,
      },
    ],
    'params': [
      {
        'property':     'organizationID',
        'type':         'string',
        'description':  'ID of organization to invite user to',
        'required':     true,
      },
    ],
    'example': 'await API.inviteUserToOrganization({ data: { email: \'some+user+to+invite@example.com\', roles: [ \'admin\' ] }, params: { organizationID: \'some-organization-id\' } });',
    'notes': [
      'You will receive a 403 Forbidden response if you don\'t have the permission level to invite the user to the specified organization',
      'The \'invite-to-organization\' role is required to invite a user to an organization, unless the user is permission level \'superadmin\' or above',
      'The user does not need to already exist. If they don\'t already exist, the user will be created via the email provided, and will be sent an invite link to their email',
    ],
  },
  removeUserFromOrganization: {
    'description': 'This method will invite the specified user to the specified organization.',
    'data': [
      {
        'property':     'email',
        'type':         'string',
        'description':  'Email of user to invite',
        'required':     true,
      },
      {
        'property':     'roles',
        'type':         'Array<string>',
        'description':  'Roles to assign to invited user',
        'required':     false,
      },
    ],
    'params': [
      {
        'property':     'organizationID',
        'type':         'string',
        'description':  'ID of organization to remove user from',
        'required':     true,
      },
      {
        'property':     'userID',
        'type':         'string',
        'description':  'ID of user to remove from organization',
        'required':     true,
      },
    ],
    'example': 'await API.removeUserFromOrganization({ params: { organizationID: \'some-organization-id\', userID: \'some-user-id\' } });',
    'notes': [
      'You will receive a 403 Forbidden response if you don\'t have the permission level to remove the user from the specified organization',
    ],
  },
  updateUserAvatar: {
    'description': 'This method will update the specified user\'s avatar for the specified organization. FormData or JSON formats are both accepted. For JSON payloads, the "file" property must be a base64 encoded image.',
    'data': [
      {
        'property':     'file',
        'type':         'FormData->file | base64 encoded image',
        'description':  'Avatar image file',
        'required':     true,
      },
      {
        'property':     'fileName',
        'type':         'string',
        'description':  'Name of file. The file extension is used to detect the Content-Type',
        'required':     true,
      },
    ],
    'params': [
      {
        'property':     'organizationID',
        'type':         'string',
        'description':  'ID of organization to update avatar on',
        'required':     true,
      },
      {
        'property':     'userID',
        'type':         'string',
        'description':  'ID of user to update avatar for',
        'required':     true,
      },
    ],
    'example': 'await API.updateUserAvatar({ data: FormData || JSON, params: { organizationID: \'some-organization-id\', userID: \'some-user-id\' } });',
    'notes': [
      'You will receive a 403 Forbidden response if you don\'t have the permission level to update the user\'s avatar',
      'You can optionally use FormData with a file attachment, or you can use a JSON payload to upload the attachment.\n    If JSON is used, then the "file" property should be a base64 encoded image.',
      'User avatar\'s are per-organization, which is why you must go through the organization controller to update a user\'s avatar',
      '"dob" for a user can not be updated via this method. "dob" can only be updated by the user themselves through the "updateCurrentUser" method',
    ],
  },
  updateOrganizationUser: {
    'description': 'This method will update the user with the data provided. This will update the user\'s demographics ONLY for the specified organization!',
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
    ],
    'params': [
      {
        'property':     'organizationID',
        'type':         'string',
        'description':  'ID of organization to update user demographics for',
        'required':     true,
      },
      {
        'property':     'userID',
        'type':         'string',
        'description':  'ID of user to update',
        'required':     true,
      },
    ],
    'example': 'await API.updateOrganizationUser({ data: { email: \'some+user@example.com\', firstName: \'Test\', lastName: \'User\' }, params: { organizationID: \'some-organization-id\', userID: \'some-user-id\' } });',
    'notes': [
      'You will receive a 403 Forbidden response if you don\'t have the permission level to update the specified user',
      'Upon success the updated user will be returned',
      'This will update the user\'s demographics FOR A SPECIFIED ORGANIZATION. To update the User model directly for a user, use the "updateCurrentUser", or "updateUser" (only masteradmin and support roles) methods instead.',
      'Unlike the "updateCurrentUser" method, this method can be called by other user\'s on behalf of the specified user (i.e. admin users)',
      'The specified user can update themselves via this method',
    ],
  },
  searchOrganizations: {
    'description': 'This method will search organizations.',
    'data': [
      {
        'property':     'filter',
        'type':         'Object',
        'description':  'Filter properties',
        'required':     true,
      },
      {
        'property':     'limit',
        'type':         'number',
        'description':  'Limit returned records',
        'required':     false,
      },
      {
        'property':     'offset',
        'type':         'number',
        'description':  'Offset in records to start searching',
        'required':     false,
      },
      {
        'property':     'order',
        'type':         'string',
        'description':  'Order results by specified field (format [+-]{ModelName}:{name})',
        'required':     false,
      },
    ],
    'extra': [
      {
        'type': 'table',
        'title': 'User fields filter operators',
        'columns': [ 'operator', 'name', 'description', 'example' ],
        'rows': [
          {
            'operator': '=',
            'name': 'equals',
            'description': 'Match against field value equals specified value',
            'example': 'filter: { "name=": "Bob" }',
          },
          {
            'operator': '!=',
            'name': 'not equals',
            'description': 'Match against field value not equals specified value',
            'example': 'filter: { "name!=": "Bob" }',
          },
          {
            'operator': '=',
            'name': 'in',
            'description': 'Match against field value that is any of the specified values',
            'example': 'filter: { "name=": [ "Bob", "John" ] }',
          },
          {
            'operator': '!=',
            'name': 'not in',
            'description': 'Match against field value that is not any of the specified values',
            'example': 'filter: { "name!=": [ "Bob", "John" ] }',
          },
          {
            'operator': '>',
            'name': 'greater than',
            'description': 'Match against field value is greater than specified value',
            'example': 'filter: { "createdAt>": "2001-01-01" }',
          },
          {
            'operator': '>=',
            'name': 'greater than or equal',
            'description': 'Match against field value is greater than or equal to specified value',
            'example': 'filter: { "createdAt>=": "2001-01-01" }',
          },
          {
            'operator': '<',
            'name': 'less than',
            'description': 'Match against field value is less than specified value',
            'example': 'filter: { "createdAt<": "2001-01-01" }',
          },
          {
            'operator': '<=',
            'name': 'less than or equal',
            'description': 'Match against field value is less than or equal to specified value',
            'example': 'filter: { "createdAt<=": "2001-01-01" }',
          },
          {
            'operator': '><',
            'name': 'between',
            'description': 'Match against field value is between specified values',
            'example': 'filter: { "createdAt><": [ "2001-01-01", "2022-01-01" ] }',
          },
          {
            'operator': '<>',
            'name': 'not between',
            'description': 'Match against field value is not between specified values',
            'example': 'filter: { "createdAt<>": [ "2001-01-01", "2022-01-01" ] }',
          },
          {
            'operator': '*',
            'name': 'like',
            'description': 'Match against field value is like specified value (wildcard match)',
            'example': 'filter: { "name*": "%Bob%" }',
          },
          {
            'operator': '!*',
            'name': 'not like',
            'description': 'Match against field value is not like specified value (wildcard match)',
            'example': 'filter: { "name!*": "%Bob%" }',
          },
        ],
      },
    ],
    'example': 'await API.searchOrganizations({ data: { filter: { name: \'Some Organization\', \'createdAt>=\': \'2001-01-01\', }, limit: 20, offset: 0, order: \'-Organization:name\' } });',
    'notes': [
      'Only organizations you have permission to view will be returned',
      'The "filter" property can contain any of the fields for organizations',
      '"=" and "!=" operators switch automatically to "IN" and "NOT IN" operators if the specified value is an array',
      'When filtering on organization fields you can postfix the field name with an operator... for example: "name*": "%Test%" to find organizations whose name contains "Test"',
      'Pay attention to the table containing a list of usable operators for organization fields',
      'If no field operator is specified for filter fields, then the equals (=) operator is assumed',
      '"filter" can contain AND and OR operations. For this to work, you simply need to use an array (OR) or an object (AND).\n    An array specifies an "OR" context.\n    An object specifies an "AND" context.\n    For example: "filter": [ { "name*": "%Test%", "createdAt>": "2001-01-01" }, { "createdAt>=": "2022-01-01", "name": null } ]\n    would result in ((name LIKE \'%Bob%\' AND createdAt >= \'2001-01-01\') OR (createdAt >= \'2022-01-01\' AND name IS NULL))',
      'The "order" field can specify the sort direction.\n    For ASC order, simply prefix the field with "+" (default).\n    For DESC order, simply prefix the field with "-".\n    Example 1: { order: "-Organization:name" } (DESC)\n    Example 2: { order: "+Organization:name" } (ASC)',
    ],
  },
  searchTeamsAndUsers: {
    'description': 'This method will search across teams and users.',
    'data': [
      {
        'property':     'filter',
        'type':         'Object',
        'description':  'Filter properties. Note that this filter, if provided, must contain a "teams" and/or "users" scope.',
        'required':     false,
      },
      {
        'property':     'limit',
        'type':         'number',
        'description':  'Limit returned records',
        'required':     false,
      },
      {
        'property':     'offset',
        'type':         'number',
        'description':  'Offset in records to start searching',
        'required':     false,
      },
      {
        'property':     'order',
        'type':         'string',
        'description':  'Order results by specified field (format [+-]{ModelName}:{name})',
        'required':     false,
      },
    ],
    'params': [
      {
        'property':     'organizationID',
        'type':         'string',
        'description':  'ID of organization to search for teams and users in',
        'required':     true,
      },
    ],
    'extra': [
      {
        'type': 'table',
        'title': 'User fields filter operators',
        'columns': [ 'operator', 'name', 'description', 'example' ],
        'rows': [
          {
            'operator': '=',
            'name': 'equals',
            'description': 'Match against field value equals specified value',
            'example': 'filter: { "name=": "Team Name" }',
          },
          {
            'operator': '!=',
            'name': 'not equals',
            'description': 'Match against field value not equals specified value',
            'example': 'filter: { "name!=": "Team Name" }',
          },
          {
            'operator': '=',
            'name': 'in',
            'description': 'Match against field value that is any of the specified values',
            'example': 'filter: { "name=": [ "Team 1", "Team 2" ] }',
          },
          {
            'operator': '!=',
            'name': 'not in',
            'description': 'Match against field value that is not any of the specified values',
            'example': 'filter: { "name!=": [ "Team 1", "Team 2" ] }',
          },
          {
            'operator': '>',
            'name': 'greater than',
            'description': 'Match against field value is greater than specified value',
            'example': 'filter: { "createdAt>": "2001-01-01" }',
          },
          {
            'operator': '>=',
            'name': 'greater than or equal',
            'description': 'Match against field value is greater than or equal to specified value',
            'example': 'filter: { "createdAt>=": "2001-01-01" }',
          },
          {
            'operator': '<',
            'name': 'less than',
            'description': 'Match against field value is less than specified value',
            'example': 'filter: { "createdAt<": "2001-01-01" }',
          },
          {
            'operator': '<=',
            'name': 'less than or equal',
            'description': 'Match against field value is less than or equal to specified value',
            'example': 'filter: { "createdAt<=": "2001-01-01" }',
          },
          {
            'operator': '><',
            'name': 'between',
            'description': 'Match against field value is between specified values',
            'example': 'filter: { "createdAt><": [ "2001-01-01", "2022-01-01" ] }',
          },
          {
            'operator': '<>',
            'name': 'not between',
            'description': 'Match against field value is not between specified values',
            'example': 'filter: { "createdAt<>": [ "2001-01-01", "2022-01-01" ] }',
          },
          {
            'operator': '*',
            'name': 'like',
            'description': 'Match against field value is like specified value (wildcard match)',
            'example': 'filter: { "name*": "%Team%" }',
          },
          {
            'operator': '!*',
            'name': 'not like',
            'description': 'Match against field value is not like specified value (wildcard match)',
            'example': 'filter: { "name!*": "%Team%" }',
          },
        ],
      },
    ],
    'example': 'await API.searchTeamsAndUsers({ data: { filter: { teams: { \'name*\': \'%search term%\' }, users: { \'email*\': \'%search term%\' } }, limit: 20, offset: 0, order: [ \'User:firstName\', \'User:lastName\' ] }, params: { organizationID: \'some-organization-id\' } });',
    'notes': [
      'Only teams you have permission to view will be returned',
      'The "filter.teams" property can contain any of the fields for teams',
      'The "filter.users" property can contain any of the following fields for users: `email`, `firstName`, `lastName`',
      '"=" and "!=" operators switch automatically to "IN" and "NOT IN" operators if the specified value is an array',
      'When filtering on fields you can postfix the field name with an operator... for example: `teams: { "name*": "%Test%" }` to find teams whose name contains "Test"',
      'Pay attention to the table containing a list of usable operators for teams and user fields',
      'If no field operator is specified for filter fields, then the equals (=) operator is assumed',
      '"filter" can contain AND and OR operations. For this to work, you simply need to use an array (OR) or an object (AND).\n    An array specifies an "OR" context.\n    An object specifies an "AND" context.\n    For example: "filter": [ { "name*": "%Test%", "createdAt>": "2001-01-01" }, { "createdAt>=": "2022-01-01", "name": null } ]\n    would result in ((name LIKE \'%Bob%\' AND createdAt >= \'2001-01-01\') OR (createdAt >= \'2022-01-01\' AND name IS NULL))',
      'The "order" field can specify the sort direction.\n    For ASC order, simply prefix the field with "+" (default).\n    For DESC order, simply prefix the field with "-".\n    Example 1: { order: "-Team:name" } (DESC)\n    Example 2: { order: "+Team:name" } (ASC)',
      'The "filter" for this endpoint works slightly differently then other filters. It requires a "teams" or "users" sub-key(s)/scopes if provided. The `teams` scope specifies filter properties for searching teams, and the `users` key should contain filter properties for searching against users. Both can be used at the same time, or one or the other can be specified.',
      'The `limit` and `order` might be a little odd for this endpoint. The limit and order are applied both to the teams and users queries, which are separate. Then the collecting of users for each team is also an extra step. This might mean that your `limit` and `offset` aren\'t fully respected like you might expect. In short, you might get slightly more data than the provided `limit`. It is recommended that you simply don\'t supply a limit or offset.',
    ],
  },
  getOrganizations: {
    'description': 'This method will list all organizations.',
    'data': [
      {
        'property':     'limit',
        'type':         'number',
        'description':  'Limit returned records',
        'required':     false,
      },
      {
        'property':     'offset',
        'type':         'number',
        'description':  'Offset in records to start searching',
        'required':     false,
      },
      {
        'property':     'order',
        'type':         'string',
        'description':  'Order results by specified field (format [+-]{ModelName}:{fieldName})',
        'required':     false,
      },
    ],
    'example': 'await API.getOrganizations({ data: { limit: 20, offset: 0, order: "-Organization:name" } });',
    'notes': [
      'Only organizations you have permission to view will be returned',
      'A user has permission to view an organization if they are a member',
      '"masteradmin" and "support" user roles have permission to view all organizations',
      'The "order" field can specify the sort direction.\n    For ASC order, simply prefix the field with "+" (default).\n    For DESC order, simply prefix the field with "-".\n    Example 1: { order: "-Organization:name" } (DESC)\n    Example 2: { order: "+Organization:name" } (ASC)',
    ],
  },
  createOrganization: {
    'description': 'This method will create a new organization with the name specified.',
    'data': [
      {
        'property':     'name',
        'type':         'string',
        'description':  'Name of the organization',
        'required':     true,
      },
    ],
    'example': 'await API.createOrganization({ data: { name: \'Test Organization\' } });',
    'notes': [
      'A 403 Forbidden response will be returned if the calling user doesn\'t have the permission level needed to create an organization',
      '"masteradmin" and "support" user roles have permission to create organizations',
      'No users are invited by default to the organization created (not even the calling user)',
      'Upon success the newly created organization will be returned',
    ],
  },
};
