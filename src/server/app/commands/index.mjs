export * from './server-prep-command.mjs';
export * from './shell-command.mjs';
export * from './test-email-command.mjs';

import { ServerPrepCommand } from './server-prep-command.mjs';
import { ShellCommand } from './shell-command.mjs';
import { TestEmailCommand } from './test-email-command.mjs';

export const COMMANDS = {
  'server-prep':  ServerPrepCommand,
  'shell':        ShellCommand,
  'test-email':   TestEmailCommand,
};
