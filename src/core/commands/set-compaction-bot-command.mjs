'use strict';

import { SetDesignationCommand } from './designation-command.mjs';

export class SetCompactionBotCommand extends SetDesignationCommand {
  static description = 'Assign the session compaction bot.';
  static field = 'compactionAgentID';
  static label = 'Compaction bot';
  static usage = '/set-compaction-bot <agent>';
}
