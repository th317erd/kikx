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
        getCommand: (name) => name === 'reload' ? fn : null,
      };

      assert.equal(handler.resolve('reload'), fn);
    });

    it('should return null for unknown command', () => {
      mockLoop._pluginRegistry = {
        getCommand: () => null,
      };

      assert.equal(handler.resolve('unknown'), null);
    });

    it('should return null when no registry', () => {
      mockLoop._pluginRegistry = null;
      assert.equal(handler.resolve('anything'), null);
    });
  });

  // ---------------------------------------------------------------------------
  // execute
  // ---------------------------------------------------------------------------

  describe('execute', () => {
    it('should create user-message and command-result frames', async () => {
      mockLoop._pluginRegistry = { getCommand: () => null };

      let interactionID = await handler.execute('ses_1', {
        userMessage: '/unknown',
        authorType:  'user',
      }, { commandName: 'unknown', arguments: '' });

      assert.ok(interactionID);
      assert.equal(savedFrames.length, 2);
      assert.equal(savedFrames[0].type, 'user-message');
      assert.equal(savedFrames[0].hidden, true);
      assert.equal(savedFrames[1].type, 'command-result');
      assert.ok(savedFrames[1].content.html.includes('Unknown command'));
    });

    it('should execute command handler and return result', async () => {
      mockLoop._pluginRegistry = {
        getCommand: (name) => {
          if (name === 'test')
            return async () => ({ content: { html: '<p>Test result</p>' } });
          return null;
        },
      };

      await handler.execute('ses_1', {
        userMessage: '/test',
      }, { commandName: 'test', arguments: '' });

      assert.equal(savedFrames[1].content.html, '<p>Test result</p>');
    });

    it('should handle command handler errors gracefully', async () => {
      mockLoop._pluginRegistry = {
        getCommand: () => async () => { throw new Error('boom'); },
      };

      await handler.execute('ses_1', {
        userMessage: '/test',
      }, { commandName: 'test', arguments: '' });

      assert.ok(savedFrames[1].content.html.includes('Command error: boom'));
    });

    it('should emit interaction:start and interaction:end', async () => {
      mockLoop._pluginRegistry = { getCommand: () => null };

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
      };

      await handler.execute('ses_1', {
        userMessage: '/test',
        checkPermission: async () => { throw permError; },
      }, { commandName: 'test', arguments: '' });

      assert.ok(savedFrames[1].content.html.includes('Permission denied'));
    });
  });
});
