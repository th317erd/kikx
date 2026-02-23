'use strict';

import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';

// We'll import the command system once it's created
// import { parseCommand, executeCommand, isCommand, registerCommand } from '../../server/lib/commands/index.mjs';

describe('Command System', () => {
  describe('isCommand()', () => {
    it('should match /command at start of string', async () => {
      const { isCommand } = await import('../../server/lib/commands/index.mjs');
      assert.strictEqual(isCommand('/help'), true);
      assert.strictEqual(isCommand('/clear'), true);
      assert.strictEqual(isCommand('/session'), true);
    });

    it('should match /command with leading whitespace', async () => {
      const { isCommand } = await import('../../server/lib/commands/index.mjs');
      assert.strictEqual(isCommand('  /help'), true);
      assert.strictEqual(isCommand('\t/clear'), true);
      assert.strictEqual(isCommand('\n/session'), true);
    });

    it('should match /command_with_underscores', async () => {
      const { isCommand } = await import('../../server/lib/commands/index.mjs');
      assert.strictEqual(isCommand('/update_usage'), true);
      assert.strictEqual(isCommand('/my_custom_command'), true);
    });

    it('should NOT match text that does not start with /', async () => {
      const { isCommand } = await import('../../server/lib/commands/index.mjs');
      assert.strictEqual(isCommand('hello'), false);
      assert.strictEqual(isCommand('help'), false);
      assert.strictEqual(isCommand('not a /command'), false);
    });

    it('should NOT match / alone', async () => {
      const { isCommand } = await import('../../server/lib/commands/index.mjs');
      assert.strictEqual(isCommand('/'), false);
      assert.strictEqual(isCommand('/ '), false);
    });

    it('should NOT match /command in the middle of text', async () => {
      const { isCommand } = await import('../../server/lib/commands/index.mjs');
      assert.strictEqual(isCommand('hello /help'), false);
      assert.strictEqual(isCommand('please /clear'), false);
    });
  });

  describe('parseCommand()', () => {
    it('should parse command name without args', async () => {
      const { parseCommand } = await import('../../server/lib/commands/index.mjs');
      let result = parseCommand('/help');
      assert.strictEqual(result.name, 'help');
      assert.strictEqual(result.args, '');
    });

    it('should parse command name with args', async () => {
      const { parseCommand } = await import('../../server/lib/commands/index.mjs');
      let result = parseCommand('/help websearch');
      assert.strictEqual(result.name, 'help');
      assert.strictEqual(result.args, 'websearch');
    });

    it('should preserve args with spaces', async () => {
      const { parseCommand } = await import('../../server/lib/commands/index.mjs');
      let result = parseCommand('/ability delete my ability name');
      assert.strictEqual(result.name, 'ability');
      assert.strictEqual(result.args, 'delete my ability name');
    });

    it('should handle leading whitespace', async () => {
      const { parseCommand } = await import('../../server/lib/commands/index.mjs');
      let result = parseCommand('  /help');
      assert.strictEqual(result.name, 'help');
    });

    it('should lowercase command names', async () => {
      const { parseCommand } = await import('../../server/lib/commands/index.mjs');
      let result = parseCommand('/HELP');
      assert.strictEqual(result.name, 'help');
    });

    it('should handle commands with underscores', async () => {
      const { parseCommand } = await import('../../server/lib/commands/index.mjs');
      let result = parseCommand('/update_usage 5.50');
      assert.strictEqual(result.name, 'update_usage');
      assert.strictEqual(result.args, '5.50');
    });

    it('should return null for invalid input', async () => {
      const { parseCommand } = await import('../../server/lib/commands/index.mjs');
      assert.strictEqual(parseCommand('not a command'), null);
      assert.strictEqual(parseCommand(''), null);
      assert.strictEqual(parseCommand(null), null);
    });
  });

  describe('Command Registry', () => {
    it('should have built-in commands registered', async () => {
      const { getCommand } = await import('../../server/lib/commands/index.mjs');
      assert.ok(getCommand('help'), 'help command should exist');
      assert.ok(getCommand('session'), 'session command should exist');
      assert.ok(getCommand('start'), 'start command should exist');
      assert.ok(getCommand('compact'), 'compact command should exist');
      assert.ok(getCommand('reload'), 'reload command should exist');
    });

    it('should return null for unknown commands', async () => {
      const { getCommand } = await import('../../server/lib/commands/index.mjs');
      assert.strictEqual(getCommand('nonexistent'), null);
    });

    it('should normalize command names (update-usage -> update_usage)', async () => {
      const { getCommand } = await import('../../server/lib/commands/index.mjs');
      // Both should resolve to the same command
      let cmd1 = getCommand('update_usage');
      let cmd2 = getCommand('update-usage');
      assert.ok(cmd1, 'update_usage should exist');
      assert.ok(cmd2, 'update-usage should also resolve');
    });
  });

  describe('executeCommand()', () => {
    it('should return error for unknown command', async () => {
      const { executeCommand } = await import('../../server/lib/commands/index.mjs');
      let context = { sessionId: 1, userId: 1 };
      let result = await executeCommand('nonexistent', '', context);

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('Unknown command'));
    });

    it('should execute help command and return content', async () => {
      const { executeCommand } = await import('../../server/lib/commands/index.mjs');
      let context = { sessionId: 1, userId: 1 };
      let result = await executeCommand('help', '', context);

      assert.strictEqual(result.success, true);
      assert.ok(result.content, 'help should return content');
      assert.ok(result.content.includes('Commands'), 'help content should list commands');
    });

    it('should execute session command', async () => {
      const { executeCommand } = await import('../../server/lib/commands/index.mjs');
      let context = {
        sessionId: 123,
        userId:    1,
        session:   { id: 123, name: 'Test Session' },
      };
      let result = await executeCommand('session', '', context);

      assert.strictEqual(result.success, true);
      assert.ok(result.content.includes('Test Session'), 'session should show session name');
      assert.ok(result.content.includes('123'), 'session should show session ID');
    });

    it('should handle command errors gracefully', async () => {
      const { executeCommand } = await import('../../server/lib/commands/index.mjs');
      // No session in context should produce an error for session-dependent commands
      let context = { userId: 1 };
      let result = await executeCommand('compact', '', context);

      assert.strictEqual(result.success, false);
      assert.ok(result.error, 'should have error message');
    });
  });
});

describe('Built-in Commands', () => {
  describe('/help', () => {
    it('should list all available commands', async () => {
      const { executeCommand } = await import('../../server/lib/commands/index.mjs');
      let result = await executeCommand('help', '', { userId: 1 });

      assert.strictEqual(result.success, true);
      assert.ok(result.content.includes('/help'));
      assert.ok(result.content.includes('/session'));
      assert.ok(result.content.includes('/compact'));
    });

    it('should filter commands with filter arg', async () => {
      const { executeCommand } = await import('../../server/lib/commands/index.mjs');
      let result = await executeCommand('help', 'session', { userId: 1 });

      assert.strictEqual(result.success, true);
      assert.ok(result.content.includes('session'));
    });
  });

  describe('/session', () => {
    it('should show session info when session exists', async () => {
      const { executeCommand } = await import('../../server/lib/commands/index.mjs');
      let context = {
        sessionId: 42,
        userId:    1,
        session:   { id: 42, name: 'My Session' },
      };
      let result = await executeCommand('session', '', context);

      assert.strictEqual(result.success, true);
      assert.ok(result.content.includes('My Session'));
      assert.ok(result.content.includes('42'));
    });

    it('should show error when no session', async () => {
      const { executeCommand } = await import('../../server/lib/commands/index.mjs');
      let result = await executeCommand('session', '', { userId: 1 });

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('session'));
    });
  });

});
