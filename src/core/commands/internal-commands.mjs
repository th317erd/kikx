'use strict';

import { ClearCompactionBotCommand } from './clear-compaction-bot-command.mjs';
import { ClearCoordinatorBotCommand } from './clear-coordinator-bot-command.mjs';
import { CompactCommand } from './compact-command.mjs';
import { InviteCommand } from './invite-command.mjs';
import { SetCompactionBotCommand } from './set-compaction-bot-command.mjs';
import { SetCoordinatorBotCommand } from './set-coordinator-bot-command.mjs';
import { SlashCommandFramePlugin } from './slash-command-frame-plugin.mjs';
import { registerMentionRouting } from '../mentions/index.mjs';

export function registerInternalCommands({ pluginRegistry, commandRegistry }) {
  if (!pluginRegistry)
    throw new TypeError('registerInternalCommands() requires pluginRegistry');

  if (!commandRegistry)
    throw new TypeError('registerInternalCommands() requires commandRegistry');

  commandRegistry.registerCommand('compact', CompactCommand);
  commandRegistry.registerCommand('invite', InviteCommand);
  commandRegistry.registerCommand('set-coordinator-bot', SetCoordinatorBotCommand);
  commandRegistry.registerCommand('clear-coordinator-bot', ClearCoordinatorBotCommand);
  commandRegistry.registerCommand('set-compaction-bot', SetCompactionBotCommand);
  commandRegistry.registerCommand('clear-compaction-bot', ClearCompactionBotCommand);
  registerMentionRouting(pluginRegistry);
  pluginRegistry.registerSelector('Type:UserMessage', SlashCommandFramePlugin, SlashCommandFramePlugin.pluginID);
}
