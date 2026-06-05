'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { CommandRegistry, parseSlashCommand } from '../../../src/core/commands/index.mjs';

test('CommandRegistry registers commands and aliases by normalized slash name', () => {
  class InviteCommand {}

  let registry = new CommandRegistry({ logger: { warn() {} } });
  registry.registerCommand('/Invite', InviteCommand, {
    aliases: [ 'add-agent' ],
    description: 'Invite an agent',
  });

  assert.equal(registry.getCommand('invite').CommandClass, InviteCommand);
  assert.equal(registry.getCommand('/add-agent').CommandClass, InviteCommand);
  assert.deepEqual(registry.listCommands(), [
    {
      name: 'invite',
      description: 'Invite an agent',
      aliases: [ 'add-agent' ],
    },
  ]);
});

test('CommandRegistry rejects malformed command registrations', () => {
  let registry = new CommandRegistry();

  assert.throws(() => registry.registerCommand('', class {}), /Command name/);
  assert.throws(() => registry.registerCommand('bad space', class {}), /Invalid command name/);
  assert.throws(() => registry.registerCommand('invite', {}), /must be a class/);
  assert.throws(() => registry.registerCommand('invite', class {}, { aliases: 'nope' }), /aliases/);
});

test('parseSlashCommand parses commands and leaves normal messages alone', () => {
  assert.deepEqual(parseSlashCommand('/invite Coder'), {
    name: 'invite',
    args: 'Coder',
    raw: '/invite Coder',
  });

  assert.deepEqual(parseSlashCommand('  /INVITE agent_1  '), {
    name: 'invite',
    args: 'agent_1',
    raw: '/INVITE agent_1',
  });

  assert.equal(parseSlashCommand('hello /invite Coder'), null);
  assert.equal(parseSlashCommand('//not-a-command'), null);
  assert.equal(parseSlashCommand('/'), null);
});
