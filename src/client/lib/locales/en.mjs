'use strict';

export default {
  application: {
    title:   'Hero',
    loading: 'Loading...',
  },
  login: {
    title:          'Sign In',
    emailLabel:     'Email Address',
    emailPlaceholder: 'Enter your email',
    submitButton:   'Send Magic Link',
    successMessage: 'Check your email for a login link.',
    errorMessage:   'Something went wrong. Please try again.',
  },
  session: {
    create: {
      title:          'New Session',
      namePlaceholder: 'Session name...',
      createButton:   'Create',
      cancelButton:   'Cancel',
    },
    list: {
      title:             'Sessions',
      empty:             'No sessions yet.',
      searchPlaceholder: 'Search sessions...',
    },
    categories: {
      channels: 'Channels',
      private:  'Private',
    },
    archive: {
      archiveAction: 'Archive',
      reviveAction:  'Restore',
    },
  },
  agent: {
    list: {
      title:     'Agents',
      empty:     'No agents configured.',
      addButton: 'New Agent',
    },
    form: {
      nameLabel:     'Agent Name',
      providerLabel: 'Provider',
      apiKeyLabel:   'API Key',
      modelLabel:    'Model',
      saveButton:    'Save',
      deleteButton:  'Delete',
      cancelButton:  'Cancel',
    },
  },
  ability: {
    list: {
      title:          'Abilities',
      myAbilitiesTab: 'My Abilities',
      addButton:      'New Ability',
    },
    wizard: {
      nameStep:        'Name',
      categoryStep:    'Category',
      descriptionStep: 'Description',
      whenToUseStep:   'When to Use',
      contentStep:     'Content',
      permissionsStep: 'Permissions',
      nextButton:      'Next',
      backButton:      'Back',
      saveButton:      'Save',
    },
  },
  chat: {
    input: {
      placeholder: 'Type a message...',
      sendButton:  'Send',
    },
    scrollAnchor: {
      jumpToBottom: 'Jump to bottom',
    },
    interaction: {
      ignoreButton: 'Ignore',
      submitButton: 'Submit',
      tokenCount:   {
        one:   '~{count} token',
        other: '~{count} tokens',
      },
    },
    reflection: {
      label: 'Reflection',
    },
  },
  permission: {
    title:         'Permission Request',
    grantQuestion: 'Grant permission?',
    allowOnce:     'Allow this once',
    allowSession:  'Allow for this session',
    allowAlways:   'Always allow',
    deny:          'Deny',
  },
  status: {
    connected:    'Connected',
    disconnected: 'Disconnected',
    reconnecting: 'Reconnecting...',
    cost: {
      global:  'Global',
      service: 'Service',
      session: 'Session',
    },
  },
  settings: {
    title: 'Settings',
    tabs: {
      profile:     'Profile',
      account:     'Account',
      apiKeys:     'API Keys',
      permissions: 'Permissions',
      appearance:  'Appearance',
    },
  },
  common: {
    save:    'Save',
    cancel:  'Cancel',
    delete:  'Delete',
    close:   'Close',
    confirm: 'Confirm',
    loading: 'Loading...',
    error:   'Error',
    warning: 'Warning',
    success: 'Success',
  },
};
