'use strict';

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadPlugins, unloadPlugin } from '../../src/core/plugins/plugin-loader.mjs';
import { registerCoreClasses } from '../../src/core/plugins/core-classes.mjs';
import { PluginRegistry } from '../../src/core/plugins/index.mjs';
import { CommandRegistry } from '../../src/core/commands/index.mjs';

test('loadPlugins supports external setup(provide) agent provider registration', async () => {
  let root = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-plugin-loader-'));
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ main: 'index.mjs' }));
  await fs.writeFile(path.join(root, 'index.mjs'), `
    export function setup(provide) {
      provide(({ registry }) => {
        let AgentInterface = registry.getClass('AgentInterface');
        class ExternalAgent extends AgentInterface {
          static pluginId = 'external-agent';
          static displayName = 'External Agent';
          static configFields = [
            { name: 'apiKey', secret: true, required: true },
          ];
        }
        registry.registerAgentType('external-agent', ExternalAgent);
      });
    }
  `);

  let registry = new PluginRegistry({ logger: { warn() {} } });
  let loaded = await loadPlugins({
    pluginPaths: root,
    registry,
    logger: { warn() {} },
  });

  assert.equal(loaded.length, 1);
  assert.equal(registry.getAgentProvider('external-agent')?.displayName, 'External Agent');
  assert.deepEqual((await registry.listAgentProviderDescriptors())[0].configFields[0], {
    name: 'apiKey',
    label: 'apiKey',
    type: 'text',
    required: true,
    secret: true,
    defaultValue: undefined,
    options: undefined,
    help: '',
  });
});

test('loadPlugins exposes command registration to external plugins', async () => {
  let root = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-command-plugin-'));
  await fs.writeFile(path.join(root, 'index.mjs'), `
    export function setup(provide) {
      provide(({ registerCommand }) => {
        class PingCommand {
          static description = 'Ping command';
          async execute() {
            return { message: 'pong' };
          }
        }
        registerCommand('ping', PingCommand, { aliases: [ 'p' ] });
      });
    }
  `);

  let registry = new PluginRegistry({ logger: { warn() {} } });
  let commandRegistry = new CommandRegistry({ logger: { warn() {} } });
  let loaded = await loadPlugins({
    pluginPaths: root,
    registry,
    commandRegistry,
    logger: { warn() {} },
  });

  assert.equal(loaded.length, 1);
  assert.equal(commandRegistry.getCommand('ping').description, 'Ping command');
  assert.equal(commandRegistry.getCommand('/p').name, 'ping');
});

test('loadPlugins exposes client component registration to external plugins', async () => {
  let root = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-component-plugin-'));
  await fs.writeFile(path.join(root, 'index.mjs'), `
    export function setup(provide) {
      provide(({ registerFrameComponent, registerToolComponent }) => {
        registerFrameComponent('ToolResult', {
          tagName: 'kikx-external-tool-result',
          moduleURL: '/client/plugins/external-tool-result.mjs',
        });
        registerToolComponent('external-tool', {
          tagName: 'kikx-external-tool',
          moduleURL: '/client/plugins/external-tool.mjs',
        });
      });
    }
  `);

  let registry = new PluginRegistry({ logger: { warn() {} } });
  let loaded = await loadPlugins({
    pluginPaths: root,
    registry,
    logger: { warn() {} },
  });

  assert.equal(loaded.length, 1);
  assert.equal(registry.getFrameComponents().get('ToolResult').tagName, 'kikx-external-tool-result');
  assert.equal(registry.getToolComponents().get('external-tool').tagName, 'kikx-external-tool');
});

test('loadPlugins exposes agent-config-form registration and records plugin path by provider ID', async () => {
  let root = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-config-form-plugin-'));
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ main: 'index.mjs' }));
  await fs.writeFile(path.join(root, 'index.mjs'), `
    export const pluginName = 'config-form-plugin';
    export function setup(provide) {
      provide(({ registry, registerAgentConfigForm }) => {
        let AgentInterface = registry.getClass('AgentInterface');
        class CustomAgent extends AgentInterface {
          static pluginId = 'custom-agent';
          static displayName = 'Custom Agent';
        }
        registry.registerAgentType('custom-agent', CustomAgent);
        registerAgentConfigForm('custom-agent', {
          tagName: 'kog-agent-config-form',
          moduleURL: '/api/v1/plugin-assets/config-form-plugin/agent-config-form.mjs',
        });
      });
    }
  `);

  let registry = new PluginRegistry({ logger: { warn() {} } });
  let loaded = await loadPlugins({ pluginPaths: root, registry, logger: { warn() {} } });

  assert.equal(loaded.length, 1);
  assert.equal(registry.getAgentConfigForms().get('custom-agent').tagName, 'kog-agent-config-form');
  // Provider ID -> plugin root, so asset requests can be resolved.
  assert.equal(registry.getPluginPath('custom-agent'), root);
  assert.equal(registry.getPluginPath('config-form-plugin'), root);
});

test('a plugin can override a core class and unloadPlugin restores it', async () => {
  let root = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-plugin-override-'));
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ main: 'index.mjs' }));
  await fs.writeFile(path.join(root, 'index.mjs'), `
    export const pluginName = 'override-plugin';
    export function setup(provide) {
      provide(({ registry, registerClass }) => {
        class CustomRouter {}
        registerClass('FrameRouter', CustomRouter);
      });
      return () => {};
    }
  `);

  let registry = new PluginRegistry({ logger: { warn() {} } });
  class CoreRouter {}
  registry.registerClass('FrameRouter', CoreRouter, { pluginName: 'core' });

  await loadPlugins({ pluginPaths: root, registry, logger: { warn() {} } });

  let Overridden = registry.getClass('FrameRouter');
  assert.notEqual(Overridden, CoreRouter);
  assert.equal(Overridden.name, 'CustomRouter');

  let unloaded = await unloadPlugin(registry, 'override-plugin');
  assert.equal(unloaded, true);
  assert.equal(registry.getClass('FrameRouter'), CoreRouter);
});

test('coreClasses registers the override-worthy core classes', async () => {
  let registry = new PluginRegistry({ logger: { warn() {} } });
  registerCoreClasses(registry);

  for (let key of [ 'FrameRouter', 'FrameRuntime', 'CompactionService', 'PluginRegistry', 'AgentInterface', 'PluginInterface' ])
    assert.ok(registry.hasClass(key), `expected ${key} registered`);

  assert.equal(registry.getClass('FrameRouter').name, 'FrameRouter');
});
