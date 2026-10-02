'use strict';

import { ClearDesignationCommand } from './designation-command.mjs';

export class ClearCoordinatorBotCommand extends ClearDesignationCommand {
  static description = 'Remove the session coordinator bot assignment.';
  static field = 'coordinatorAgentID';
  static label = 'Coordinator bot';
  static usage = '/clear-coordinator-bot';
}
