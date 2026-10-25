'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { AgentInterface, PluginRegistry } from '../../../src/core/plugins/index.mjs';
import { setup } from '../../../plugins/ocr/index.mjs';

function createProviderClass() {
  let registry = new PluginRegistry({ logger: { warn() {} } });
  registry.registerClass('AgentInterface', AgentInterface);
  setup((callback) => callback({
    registry,
    registerAgentType: (name, provider) => registry.registerAgentType(name, provider),
  }));
  return registry.getAgentProvider('host-ocr-command');
}

test('host-ocr-command registers a provider and runs the configured command', async () => {
  let Provider = createProviderClass();
  assert.ok(Provider, 'expected host-ocr-command to be registered');

  let provider = new Provider({
    agent: {
      id: 'ocr_1',
      name: 'Host OCR',
      config: {
        command: process.execPath,
        args: '-e "process.stdout.write(\'OCR:\' + process.argv[1])"',
        promptFlag: '',
      },
    },
  });

  let result = await provider.runOcr({
    images: [ '/tmp/example.png' ],
    prompt: 'ignored because promptFlag is blank',
  });

  assert.equal(result.text, 'OCR:/tmp/example.png');
  assert.equal(result.exitCode, 0);
});

test('host-ocr-command reports a non-zero command as an error', async () => {
  let Provider = createProviderClass();
  let provider = new Provider({
    agent: {
      id: 'ocr_2',
      name: 'Host OCR',
      config: {
        command: process.execPath,
        args: '-e "process.stderr.write(\'bad OCR\'); process.exit(3)"',
        promptFlag: '',
      },
    },
  });

  await assert.rejects(
    () => provider.runOcr({ images: [ '/tmp/example.png' ] }),
    /exit 3: bad OCR/,
  );
});
