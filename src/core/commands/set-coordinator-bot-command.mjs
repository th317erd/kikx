'use strict';

import { SetDesignationCommand } from './designation-command.mjs';

export class SetCoordinatorBotCommand extends SetDesignationCommand {
  static description = 'Assign the session coordinator bot.';
  static field = 'coordinatorAgentID';
  static label = 'Coordinator bot';
  static usage = '/set-coordinator-bot <agent>';
}
