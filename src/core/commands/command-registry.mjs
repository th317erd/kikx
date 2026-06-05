'use strict';

export class CommandRegistry {
  constructor(options = {}) {
    this.logger = options.logger || console;
    this._commands = new Map();
  }

  registerCommand(name, CommandClass, options = {}) {
    let commandName = normalizeCommandName(name);
    if (typeof CommandClass !== 'function')
      throw new TypeError(`Command "${commandName}" must be a class/function`);

    if (this._commands.has(commandName))
      this.logger.warn?.(`Command "${commandName}" is being overridden`);

    let aliases = normalizeAliases(options.aliases || CommandClass.aliases);
    let descriptor = {
      name: commandName,
      CommandClass,
      description: options.description || CommandClass.description || '',
      aliases,
    };

    this._commands.set(commandName, descriptor);
    for (let alias of aliases)
      this._commands.set(alias, { ...descriptor, aliasOf: commandName });

    return CommandClass;
  }

  getCommand(name) {
    let commandName = normalizeCommandName(name);
    let descriptor = this._commands.get(commandName);
    if (!descriptor)
      return null;

    if (descriptor.aliasOf)
      return this._commands.get(descriptor.aliasOf) || null;

    return descriptor;
  }

  listCommands() {
    let commands = [];
    let seen = new Set();

    for (let descriptor of this._commands.values()) {
      let name = descriptor.aliasOf || descriptor.name;
      if (seen.has(name))
        continue;

      let command = this._commands.get(name);
      seen.add(name);
      commands.push({
        name: command.name,
        description: command.description,
        aliases: command.aliases.slice(),
      });
    }

    return commands.sort((a, b) => a.name.localeCompare(b.name));
  }
}

export function normalizeCommandName(name) {
  if (typeof name !== 'string' || name.trim() === '')
    throw new TypeError('Command name must be a non-empty string');

  let normalized = name.trim().replace(/^\/+/g, '').toLowerCase();
  if (!/^[a-z][a-z0-9:_-]*$/.test(normalized))
    throw new TypeError(`Invalid command name: ${name}`);

  return normalized;
}

function normalizeAliases(aliases) {
  if (aliases == null)
    return [];

  if (!Array.isArray(aliases))
    throw new TypeError('Command aliases must be an array');

  return aliases.map((alias) => normalizeCommandName(alias));
}
