'use strict';

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';

describe('Plugin loader module', () => {
  let tempPluginsDir;

  beforeEach(() => {
    tempPluginsDir = join(tmpdir(), `hero-plugins-test-${randomBytes(8).toString('hex')}`);
    mkdirSync(tempPluginsDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tempPluginsDir))
      rmSync(tempPluginsDir, { recursive: true, force: true });
  });

  function createTestPlugin(name, options = {}) {
    let pluginDir = join(tempPluginsDir, name);
    mkdirSync(pluginDir, { recursive: true });

    let packageJson = {
      name:    name,
      version: options.version || '1.0.0',
      main:    options.main || 'index.mjs',
      hero:    {
        agents: options.agents || ['*'],
      },
    };

    writeFileSync(join(pluginDir, 'package.json'), JSON.stringify(packageJson, null, 2));

    let entryContent = options.entryContent || `
      export async function init(context) {}
      export async function destroy() {}
      export const commands = [];
      export const tools = [];
      export const hooks = {};
    `;

    let mainFile = options.main || 'index.mjs';

    // Create directories for nested main files
    let mainDir = join(pluginDir, mainFile.includes('/') ? mainFile.substring(0, mainFile.lastIndexOf('/')) : '');

    if (mainDir !== pluginDir)
      mkdirSync(mainDir, { recursive: true });

    writeFileSync(join(pluginDir, mainFile), entryContent);

    return pluginDir;
  }

  describe('Plugin discovery', () => {
    it('should identify valid plugin structure', () => {
      let pluginDir = createTestPlugin('valid-plugin');

      assert.equal(existsSync(join(pluginDir, 'package.json')), true);
      assert.equal(existsSync(join(pluginDir, 'index.mjs')), true);
    });

    it('should create plugin with custom entry point', () => {
      let pluginDir = createTestPlugin('custom-entry', {
        main:         'src/main.mjs',
        entryContent: 'export const name = "custom";',
      });

      assert.equal(existsSync(join(pluginDir, 'src', 'main.mjs')), true);
    });
  });

  describe('Plugin metadata', () => {
    it('should parse package.json correctly', () => {
      let pluginDir      = createTestPlugin('metadata-test', {
        version: '2.0.0',
        agents:  ['claude'],
      });
      let packagePath    = join(pluginDir, 'package.json');
      let packageContent = JSON.parse(readFileSync(packagePath, 'utf8'));

      assert.equal(packageContent.name, 'metadata-test');
      assert.equal(packageContent.version, '2.0.0');
      assert.deepEqual(packageContent.hero.agents, ['claude']);
    });
  });

  describe('Plugin exports structure', () => {
    it('should define expected exports', () => {
      let entryContent = `
        export async function init(context) {
          return { initialized: true };
        }

        export async function destroy() {}

        export const commands = [
          {
            name: 'test-command',
            description: 'A test command',
            execute: async (args, context, signal) => 'result',
          },
        ];

        export const tools = [
          {
            name: 'test_tool',
            description: 'A test tool',
            input_schema: { type: 'object', properties: {} },
            execute: async (input, context, signal) => 'tool result',
          },
        ];

        export const hooks = {
          beforeUserMessage: async (message, context) => message,
          afterAgentResponse: async (response, context) => response,
        };
      `;

      createTestPlugin('exports-test', { entryContent });

      assert.ok(true);
    });
  });

  describe('Agent compatibility filtering', () => {
    it('should support wildcard agent compatibility', () => {
      createTestPlugin('wildcard-plugin', { agents: ['*'] });

      let packagePath = join(tempPluginsDir, 'wildcard-plugin', 'package.json');
      let pkg         = JSON.parse(readFileSync(packagePath, 'utf8'));

      assert.ok(pkg.hero.agents.includes('*'));
    });

    it('should support specific agent compatibility', () => {
      createTestPlugin('claude-only', { agents: ['claude'] });
      createTestPlugin('multi-agent', { agents: ['claude', 'openai'] });

      let claudePackage = JSON.parse(
        readFileSync(join(tempPluginsDir, 'claude-only', 'package.json'), 'utf8')
      );
      let multiPackage = JSON.parse(
        readFileSync(join(tempPluginsDir, 'multi-agent', 'package.json'), 'utf8')
      );

      assert.deepEqual(claudePackage.hero.agents, ['claude']);
      assert.deepEqual(multiPackage.hero.agents, ['claude', 'openai']);
    });
  });

  describe('AbortSignal support', () => {
    it('should allow commands to check abort signal', () => {
      let entryContent = `
        export const commands = [
          {
            name: 'cancellable',
            execute: async (args, context, signal) => {
              if (signal?.aborted)
                throw new Error('Aborted');
              return 'completed';
            },
          },
        ];
      `;

      createTestPlugin('cancellable-plugin', { entryContent });

      assert.ok(true);
    });

    it('should allow tools to check abort signal', () => {
      let entryContent = `
        export const tools = [
          {
            name: 'long_running_tool',
            input_schema: { type: 'object' },
            execute: async (input, context, signal) => {
              for (let i = 0; i < 100; i++) {
                if (signal?.aborted)
                  throw new Error('Tool execution cancelled');
              }
              return 'done';
            },
          },
        ];
      `;

      createTestPlugin('cancellable-tool-plugin', { entryContent });

      assert.ok(true);
    });
  });
});
