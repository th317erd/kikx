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

test('host-ocr-command resolves the default bot-ocr through BOT_OCR_BIN instead of PATH', async () => {
  let Provider = createProviderClass();
  let previous = process.env.BOT_OCR_BIN;
  process.env.BOT_OCR_BIN = process.execPath;
  try {
    let provider = new Provider({
      agent: {
        id: 'ocr_3',
        name: 'Host OCR',
        config: {
          args: '-e "process.stdout.write(\'resolved OCR\')"',
          promptFlag: '',
        },
      },
    });
    let result = await provider.runOcr({ images: [ '/tmp/example.png' ] });
    assert.equal(result.text, 'resolved OCR');
    assert.equal(result.command, process.execPath);
  } finally {
    if (previous == null)
      delete process.env.BOT_OCR_BIN;
    else
      process.env.BOT_OCR_BIN = previous;
  }
});

test('host-ocr-command names the paths it tried when the command is missing', async () => {
  let Provider = createProviderClass();
  let previous = process.env.BOT_OCR_BIN;
  delete process.env.BOT_OCR_BIN;
  try {
    let provider = new Provider({
      agent: {
        id: 'ocr_4',
        name: 'Host OCR',
        config: { command: 'definitely-not-a-real-ocr-command', promptFlag: '' },
      },
    });
    await assert.rejects(
      () => provider.runOcr({ images: [ '/tmp/example.png' ] }),
      /OCR command 'definitely-not-a-real-ocr-command' was not found.*Tried:.*\.bot-common.*absolute command path/,
    );
  } finally {
    if (previous == null)
      delete process.env.BOT_OCR_BIN;
    else
      process.env.BOT_OCR_BIN = previous;
  }
});
