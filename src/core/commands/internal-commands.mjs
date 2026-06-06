'use strict';

import { InviteCommand } from './invite-command.mjs';
import { SlashCommandFramePlugin } from './slash-command-frame-plugin.mjs';
import { registerMentionRouting } from '../mentions/index.mjs';

export function registerInternalCommands({ pluginRegistry, commandRegistry }) {
  if (!pluginRegistry)
    throw new TypeError('registerInternalCommands() requires pluginRegistry');

  if (!commandRegistry)
    throw new TypeError('registerInternalCommands() requires commandRegistry');

  commandRegistry.registerCommand('invite', InviteCommand);
  registerMentionRouting(pluginRegistry);
  pluginRegistry.registerSelector('Type:UserMessage', SlashCommandFramePlugin, SlashCommandFramePlugin.pluginID);
}
