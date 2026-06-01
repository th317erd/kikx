'use strict';

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadPlugins } from '../../src/core/plugins/plugin-loader.mjs';
import { PluginRegistry } from '../../src/core/plugins/index.mjs';

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
  assert.deepEqual(registry.listAgentProviderDescriptors()[0].configFields[0], {
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
