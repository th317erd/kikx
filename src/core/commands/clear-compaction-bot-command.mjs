'use strict';

import { ClearDesignationCommand } from './designation-command.mjs';

export class ClearCompactionBotCommand extends ClearDesignationCommand {
  static description = 'Remove the session compaction bot assignment.';
  static field = 'compactionAgentID';
  static label = 'Compaction bot';
  static usage = '/clear-compaction-bot';
}
