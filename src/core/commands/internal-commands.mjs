'use strict';

import { CompactCommand } from './compact-command.mjs';
import { InviteCommand } from './invite-command.mjs';
import { SlashCommandFramePlugin } from './slash-command-frame-plugin.mjs';
import { registerMentionRouting } from '../mentions/index.mjs';

export function registerInternalCommands({ pluginRegistry, commandRegistry }) {
  if (!pluginRegistry)
    throw new TypeError('registerInternalCommands() requires pluginRegistry');

  if (!commandRegistry)
    throw new TypeError('registerInternalCommands() requires commandRegistry');

  commandRegistry.registerCommand('compact', CompactCommand);
  commandRegistry.registerCommand('invite', InviteCommand);
  registerMentionRouting(pluginRegistry);
  pluginRegistry.registerSelector('Type:UserMessage', SlashCommandFramePlugin, SlashCommandFramePlugin.pluginID);
}
