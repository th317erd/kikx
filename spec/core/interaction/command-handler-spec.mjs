'use strict';

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { CommandHandler } from '../../../src/core/interaction/command-handler.mjs';

// =============================================================================
// Phase C5 — CommandHandler Tests
// =============================================================================

describe('CommandHandler (C5)', () => {
  let handler;
  let mockLoop;
  let emitted;
  let savedFrames;

  beforeEach(() => {
    emitted     = [];
    savedFrames = [];

    mockLoop = {
      _context: {
        getProperty(name) {
          if (name === 'pluginRegistry')
            return mockLoop._pluginRegistry;
          return null;
        },
      },
      _pluginRegistry: null,
      _primerNeeded: new Set(),
      _getFramePersistence() {
        return {
          getNextOrder: async () => 1,
          saveFrames:   async (_sid, frames) => { savedFrames.push(...frames); },
        };
      },
      emit(event, data) {
        emitted.push({ event, data });
      },
    };

    handler = new CommandHandler(mockLoop);
  });

  // ---------------------------------------------------------------------------
  // parse
  // ---------------------------------------------------------------------------

  describe('parse', () => {
    it('should parse /command', () => {
      let result = handler.parse('/reload');
      assert.equal(result.commandName, 'reload');
      assert.equal(result.arguments, '');
    });

    it('should parse /command with arguments', () => {
      let result = handler.parse('/invite @agent-b');
      assert.equal(result.commandName, 'invite');
      assert.equal(result.arguments, '@agent-b');
    });

    it('should parse command with leading whitespace', () => {
      let result = handler.parse('  /reload');
      assert.equal(result.commandName, 'reload');
    });

    it('should parse command with hyphens and underscores', () => {
      let result = handler.parse('/my-cool_cmd');
      assert.equal(result.commandName, 'my-cool_cmd');
    });

    it('should normalize to lowercase', () => {
      let result = handler.parse('/RELOAD');
      assert.equal(result.commandName, 'reload');
    });

    it('should return null for non-commands', () => {
      assert.equal(handler.parse('hello world'), null);
      assert.equal(handler.parse(''), null);
      assert.equal(handler.parse(null), null);
      assert.equal(handler.parse(undefined), null);
    });

    it('should return null for slash in middle of text', () => {
      assert.equal(handler.parse('hello /world'), null);
    });
  });

  // ---------------------------------------------------------------------------
  // resolve
  // ---------------------------------------------------------------------------

  describe('resolve', () => {
    it('should return handler from registry', () => {
      let fn = () => {};
      mockLoop._pluginRegistry = {
        getCommand:                  (name) => name === 'reload' ? fn : null,
        getCapabilityBySlashCommand: () => null,
      };

      assert.equal(handler.resolve('reload'), fn);
    });

    it('should return null for unknown command', () => {
      mockLoop._pluginRegistry = {
        getCommand:                  () => null,
        getCapabilityBySlashCommand: () => null,
      };

      assert.equal(handler.resolve('unknown'), null);
    });

    it('should return null when no registry', () => {
      mockLoop._pluginRegistry = null;
      assert.equal(handler.resolve('anything'), null);
    });

    it('should resolve a capability by slash command alias', () => {
      let capability = {
        name:         'inviteParticipant',
        handler:      async () => ({ content: { html: 'invited' } }),
        slashCommand: 'invite',
        parseArgs:    (raw) => ({ agentName: raw }),
      };

      mockLoop._pluginRegistry = {
        getCommand:                  () => null,
        getCapabilityBySlashCommand: (name) => name === 'invite' ? capability : null,
      };

      let result = handler.resolve('invite');
      assert.ok(result, 'Should resolve capability');
      assert.equal(result.__capability, capability);
    });

    it('should prefer traditional command over capability with same slash alias', () => {
      let fn = () => 'command-wins';
      let capability = {
        name:         'inviteParticipant',
        handler:      async () => ({ content: { html: 'cap' } }),
        slashCommand: 'invite',
      };

      mockLoop._pluginRegistry = {
        getCommand:                  (name) => name === 'invite' ? fn : null,
        getCapabilityBySlashCommand: (name) => name === 'invite' ? capability : null,
      };

      let result = handler.resolve('invite');
      assert.equal(result, fn, 'Traditional command should take precedence');
    });
  });

  // ---------------------------------------------------------------------------
  // execute — capabilities
  // ---------------------------------------------------------------------------

  describe('execute (capabilities)', () => {
    it('should execute a capability via slash command with parseArgs', async () => {
      let receivedParams = null;
      let capability = {
        name:         'inviteParticipant',
        handler:      async ({ params, sessionID, context, authorType }) => {
          receivedParams = { params, sessionID, authorType };
          return { content: { html: '<p>Invited!</p>' } };
        },
        slashCommand: 'invite',
        parseArgs:    (raw) => ({ agentName: raw.replace(/^@/, '').trim() }),
      };

      mockLoop._pluginRegistry = {
        getCommand:                  () => null,
        getCapabilityBySlashCommand: (name) => name === 'invite' ? capability : null,
      };

      // The resolve step returns a wrapper with __capability attached
      let resolved = handler.resolve('invite');
      assert.ok(resolved.__capability);

      await handler.execute('ses_1', {
        userMessage: '/invite @test-agent',
        authorType:  'user',
        authorID:    'user_1',
      }, { commandName: 'invite', arguments: '@test-agent' });

      assert.ok(receivedParams, 'Capability handler should have been called');
      assert.equal(receivedParams.params.agentName, 'test-agent');
      assert.equal(receivedParams.sessionID, 'ses_1');
      assert.equal(receivedParams.authorType, 'user');
      assert.equal(savedFrames[1].type, 'CommandResult');
      assert.ok(savedFrames[1].content.html.includes('Invited!'));
    });

    it('should handle parseArgs returning null (bad args)', async () => {
      let capability = {
        name:         'inviteParticipant',
        handler:      async () => ({ content: { html: 'should not reach' } }),
        slashCommand: 'invite',
        parseArgs:    () => null,
        schema:       { type: 'object', properties: { agentName: { type: 'string' } } },
      };

      mockLoop._pluginRegistry = {
        getCommand:                  () => null,
        getCapabilityBySlashCommand: (name) => name === 'invite' ? capability : null,
      };

      handler.resolve('invite');

      await handler.execute('ses_1', {
        userMessage: '/invite',
        authorType:  'user',
      }, { commandName: 'invite', arguments: '' });

      // Should produce an error frame, not call the handler
      assert.equal(savedFrames[1].type, 'CommandResult');
      assert.ok(savedFrames[1].content.html.includes('Usage'));
    });

    it('should handle capability without parseArgs (raw args as text param)', async () => {
      let receivedParams = null;
      let capability = {
        name:         'simpleCap',
        handler:      async ({ params }) => {
          receivedParams = params;
          return { content: { html: 'done' } };
        },
        slashCommand: 'simple',
        // no parseArgs
      };

      mockLoop._pluginRegistry = {
        getCommand:                  () => null,
        getCapabilityBySlashCommand: (name) => name === 'simple' ? capability : null,
      };

      handler.resolve('simple');

      await handler.execute('ses_1', {
        userMessage: '/simple hello world',
        authorType:  'user',
      }, { commandName: 'simple', arguments: 'hello world' });

      assert.deepEqual(receivedParams, { text: 'hello world' });
    });

    it('should pass injectPrimer flag from capability result', async () => {
      let capability = {
        name:         'reload',
        handler:      async () => ({ content: { html: 'Reloaded' }, injectPrimer: true }),
        slashCommand: 'reload',
      };

      mockLoop._pluginRegistry = {
        getCommand:                  () => null,
        getCapabilityBySlashCommand: (name) => name === 'reload' ? capability : null,
      };

      handler.resolve('reload');

      await handler.execute('ses_1', {
        userMessage: '/reload',
        authorType:  'user',
      }, { commandName: 'reload', arguments: '' });

      assert.ok(mockLoop._primerNeeded.has('ses_1'));
    });
  });

  // ---------------------------------------------------------------------------
  // execute
  // ---------------------------------------------------------------------------

  describe('execute', () => {
    it('should create user-message and command-result frames', async () => {
      mockLoop._pluginRegistry = { getCommand: () => null, getCapabilityBySlashCommand: () => null };

      let interactionID = await handler.execute('ses_1', {
        userMessage: '/unknown',
        authorType:  'user',
      }, { commandName: 'unknown', arguments: '' });

      assert.ok(interactionID);
      assert.equal(savedFrames.length, 2);
      assert.equal(savedFrames[0].type, 'UserMessage');
      assert.equal(savedFrames[0].hidden, true);
      assert.equal(savedFrames[1].type, 'CommandResult');
      assert.ok(savedFrames[1].content.html.includes('Unknown command'));
    });

    it('should execute command handler and return result', async () => {
      mockLoop._pluginRegistry = {
        getCommand: (name) => {
          if (name === 'test')
            return async () => ({ content: { html: '<p>Test result</p>' } });
          return null;
        },
        getCapabilityBySlashCommand: () => null,
      };

      await handler.execute('ses_1', {
        userMessage: '/test',
      }, { commandName: 'test', arguments: '' });

      assert.equal(savedFrames[1].content.html, '<p>Test result</p>');
    });

    it('should handle command handler errors gracefully', async () => {
      mockLoop._pluginRegistry = {
        getCommand: () => async () => { throw new Error('boom'); },
        getCapabilityBySlashCommand: () => null,
      };

      await handler.execute('ses_1', {
        userMessage: '/test',
      }, { commandName: 'test', arguments: '' });

      assert.ok(savedFrames[1].content.html.includes('Command error: boom'));
    });

    it('should emit interaction:start and interaction:end', async () => {
      mockLoop._pluginRegistry = { getCommand: () => null, getCapabilityBySlashCommand: () => null };

      await handler.execute('ses_1', {
        userMessage: '/test',
      }, { commandName: 'test', arguments: '' });

      let events = emitted.map((e) => e.event);
      assert.ok(events.includes('interaction:start'));
      assert.ok(events.includes('interaction:end'));
    });

    it('should set injectPrimer flag from command result', async () => {
      mockLoop._pluginRegistry = {
        getCommand: () => async () => ({ content: { html: 'ok' }, injectPrimer: true }),
        getCapabilityBySlashCommand: () => null,
      };

      await handler.execute('ses_1', {
        userMessage: '/reload',
      }, { commandName: 'reload', arguments: '' });

      assert.ok(mockLoop._primerNeeded.has('ses_1'));
    });

    it('should handle permission denied error', async () => {
      let permError = new Error('denied');
      permError.name = 'PermissionDeniedError';

      mockLoop._pluginRegistry = {
        getCommand: () => async () => ({ content: { html: 'ok' } }),
        getCapabilityBySlashCommand: () => null,
      };

      await handler.execute('ses_1', {
        userMessage: '/test',
        checkPermission: async () => { throw permError; },
      }, { commandName: 'test', arguments: '' });

      assert.ok(savedFrames[1].content.html.includes('Permission denied'));
    });
  });
});
