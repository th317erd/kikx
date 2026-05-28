/* eslint-disable key-spacing */

export default {
  getCurrentUser: {
    'description': 'This method will return the user data for the currently logged in user.',
    'example': 'await API.getCurrentUser();',
    'notes': [
      'There must be a valid user session for this method to work (specified as a cookie, or an "Authorization" header)',
      'The user\'s current organizationID will be returned as the attribute "currentOrganizationID" in the response payload',
      'An organizationID is not required for this endpoint, but can be optionally provided.',
      'If an organizationID can not be found, and was not provided, then the user\'s "first" organizationID will be returned',
      'A user\'s "first" organization is the first organization queried, ordering user organizations by "name ASC"',
    ],
  },
  setCurrentOrganization: {
    'description': 'This method will set the user\'s "current organization" on the user\'s Session.',
    'data': [
      {
        'property':     'organizationID',
        'type':         'string',
        'description':  'The organizationID to set as the user\'s "current organization"',
        'required':     true,
      },
    ],
    'example': 'await API.setCurrentOrganization({ data: { organizationID: "some-organization-id" } });',
    'notes': [
      'There must be a valid user session for this method to work (specified as a cookie, or an "Authorization" header)',
      'The user\'s current organizationID will be returned as the attribute "currentOrganizationID" in the response payload',
      'Setting the "current organization" for a user will set the "currentOrganizationID" on the user\'s Session, which will be used when they "reload" or come back to the page',
    ],
  },
  getUser: {
    'description': 'This method will return the user data for the specified user ID.',
    'params': [
      {
        'property':     'userID',
        'type':         'string',
        'description':  'ID of user to fetch',
        'required':     true,
      },
    ],
    'example': 'await API.getUser({ params: { userID: \'some-user-id\' } });',
    'notes': [
      'You will receive a 403 Forbidden response if you don\'t have the permission level to read the specified user',
    ],
  },
  getUsers: {
    'description': 'This method will list all users in the organization.',
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
    'example': 'await API.getUsers({ data: { limit: 20, offset: 0, order: "-User:firstName" } });',
    'notes': [
      'The target organization is the calling users current organization',
      'Only users you have permission to view will be returned',
      'The "order" field can specify the sort direction.\n    For ASC order, simply prefix the field with "+" (default).\n    For DESC order, simply prefix the field with "-".\n    Example 1: { order: "-User:firstName" } (DESC)\n    Example 2: { order: "+User:firstName" } (ASC)',
      'Add an "organizationID" to the root of the "filter" object to filter users by an organization',
    ],
  },
  updateCurrentUser: {
    'description': 'This method will update the currently logged-in user\'s data. This method will update the demographics directly on the User model, instead of the UserOrganizationLink model. To update the user\'s demographics for a specific organization use the "updateOrganizationUser" method instead.',
    'example': 'await API.updateCurrentUser({ data: { firstName: \'New\', lastName: \'Name\' } });',
    'notes': [
      'Only the "current user" is allowed to call this method. If another user (i.e. admin) calls this method then the result will be a 403 Forbidden response',
      'Use the "updateOrganizationUser" method instead to update the user\'s demographics for a specific organization',
    ],
  },
  updateUser: {
    'description': 'This method will update the specified user\'s data. This method will update the demographics directly on the User model, instead of the UserOrganizationLink model. To update the user\'s demographics for a specific organization use the "updateOrganizationUser" method instead.',
    'example': 'await API.updateUser({ data: { firstName: \'New\', lastName: \'Name\' } });',
    'notes': [
      'Only the "current user", "masteradmin" users, and "support" users are allowed to call this method. If another user (i.e. admin) calls this method then the result will be a 403 Forbidden response',
      'Use the "updateOrganizationUser" method instead to update the user\'s demographics for a specific organization',
    ],
  },
  addUserTags: {
    'description': 'This method will add the specified tags to the specified user.',
    'data': [
      {
        'property':     'tags',
        'type':         'Array<string>',
        'description':  'Tags to add to the specified user',
        'required':     true,
      },
    ],
    'params': [
      {
        'property':     'userID',
        'type':         'string',
        'description':  'ID of user to add tags to',
        'required':     true,
      },
    ],
    'example': 'await API.addUserTags({ data: { tags: [ \'tag1\', \'tag2\', \'tag3\' ] }, params: { userID: \'some-user-id\' } });',
    'notes': [
      'You will receive a 403 Forbidden response if you don\'t have the permission level to update the specified user',
      'Upon success the tags that were added to the user are returned',
      'Tags that already existed on the user will not be returned... only added tags will be returned',
      'Tags must be only alpha-numeric, plus underscore and hyphen',
      'Any character that isn\'t alpha-numeric, hyphen, or underscore will be stripped from each tag',
    ],
  },
  removeUserTags: {
    'description': 'This method will remove the specified tags from the specified user.',
    'data': [
      {
        'property':     'tags',
        'type':         'Array<string>',
        'description':  'Tags to remove from the specified user',
        'required':     true,
      },
    ],
    'params': [
      {
        'property':     'userID',
        'type':         'string',
        'description':  'ID of user to remove tags from',
        'required':     true,
      },
    ],
    'example': 'await API.removeUserTags({ data: { tags: [ \'tag1\', \'tag2\', \'tag3\' ] }, params: { userID: \'some-user-id\' } });',
    'notes': [
      'You will receive a 403 Forbidden response if you don\'t have the permission level to update the specified user',
      'Upon success the remaining tags for the user are returned',
      'Tags that don\'t exist on the user will not be ignored',
      'Tags must be only alpha-numeric, plus underscore and hyphen',
      'Any character that isn\'t alpha-numeric, hyphen, or underscore will be stripped from each tag',
    ],
  },
  searchUsers: {
    'description': 'This method will search the users of an organization.',
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
        'description':  'Order results by specified field (format [+-]{ModelName}:{fieldName})',
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
            'example': 'filter: { "firstName=": "Bob" }',
          },
          {
            'operator': '!=',
            'name': 'not equals',
            'description': 'Match against field value not equals specified value',
            'example': 'filter: { "firstName!=": "Bob" }',
          },
          {
            'operator': '=',
            'name': 'in',
            'description': 'Match against field value that is any of the specified values',
            'example': 'filter: { "firstName=": [ "Bob", "John" ] }',
          },
          {
            'operator': '!=',
            'name': 'not in',
            'description': 'Match against field value that is not any of the specified values',
            'example': 'filter: { "firstName!=": [ "Bob", "John" ] }',
          },
          {
            'operator': '>',
            'name': 'greater than',
            'description': 'Match against field value is greater than specified value',
            'example': 'filter: { "dob>": "2001-01-01" }',
          },
          {
            'operator': '>=',
            'name': 'greater than or equal',
            'description': 'Match against field value is greater than or equal to specified value',
            'example': 'filter: { "dob>=": "2001-01-01" }',
          },
          {
            'operator': '<',
            'name': 'less than',
            'description': 'Match against field value is less than specified value',
            'example': 'filter: { "dob<": "2001-01-01" }',
          },
          {
            'operator': '<=',
            'name': 'less than or equal',
            'description': 'Match against field value is less than or equal to specified value',
            'example': 'filter: { "dob<=": "2001-01-01" }',
          },
          {
            'operator': '><',
            'name': 'between',
            'description': 'Match against field value is between specified values',
            'example': 'filter: { "dob><": [ "2001-01-01", "2022-01-01" ] }',
          },
          {
            'operator': '<>',
            'name': 'not between',
            'description': 'Match against field value is not between specified values',
            'example': 'filter: { "dob<>": [ "2001-01-01", "2022-01-01" ] }',
          },
          {
            'operator': '*',
            'name': 'like',
            'description': 'Match against field value is like specified value (wildcard match)',
            'example': 'filter: { "firstName*": "%Bob%" }',
          },
          {
            'operator': '!*',
            'name': 'not like',
            'description': 'Match against field value is not like specified value (wildcard match)',
            'example': 'filter: { "firstName!*": "%Bob%" }',
          },
        ],
      },
    ],
    'example': 'await API.searchUsers({ data: { filter: { tags: [ \'tag1\', \'tag2\' ], roles: [ \'role1\', \'role2\' ], firstName: \'Bob\' }, limit: 20, offset: 0, order: \'-User:firstName\' } });',
    'notes': [
      'The target organization is the calling users current organization',
      'Only users you have permission to view will be returned',
      'The "filter" property can contain any of the fields for users, along with "tags" and "roles"',
      '"tags" and "role" filters must fully match all specified values',
      '"=" and "!=" operators switch automatically to "IN" and "NOT IN" operators if the specified value is an array',
      'When filtering on user fields you can postfix the field name with an operator... for example: "dob>=": "2001-01-01" to find users born on or after 2001-01-01',
      'Pay attention to the table containing a list of usable operators for user fields',
      'If no field operator is specified for filter fields, then the equals (=) operator is assumed',
      '"filter" can contain AND and OR operations. For this to work, you simply need to use an array (OR) or an object (AND).\n    An array specifies an "OR" context.\n    An object specifies an "AND" context.\n    For example: "filter": [ { "firstName": "Bob", "lastName": "Brown" }, { "dob>=": "2001-01-01", "firstName": null } ]\n    would result in ((firstName = \'Bob\' AND lastName = \'Brown\') OR (dob >= \'2001-01-01\' AND firstName IS NULL))',
      'The "order" field can specify the sort direction.\n    For ASC order, simply prefix the field with "+" (default).\n    For DESC order, simply prefix the field with "-".\n    Example 1: { order: "-User:firstName" } (DESC)\n    Example 2: { order: "+User:firstName" } (ASC)',
    ],
  },
};
