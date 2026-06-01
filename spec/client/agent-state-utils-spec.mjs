'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  defaultConfigForProvider,
  mergeAgentConfigWithProviderDefaults,
} from '../../src/client/state/agent-state-utils.mjs';

test('defaultConfigForProvider seeds non-secret plugin-declared defaults only', () => {
  let provider = {
    configFields: [
      { name: 'model', defaultValue: 'gpt-5-codex' },
      { name: 'apiKey', secret: true, defaultValue: 'do-not-seed' },
      { name: 'optional' },
    ],
  };

  assert.deepEqual(defaultConfigForProvider(provider), {
    model: 'gpt-5-codex',
  });
});

test('mergeAgentConfigWithProviderDefaults lets saved config override plugin defaults', () => {
  let provider = {
    configFields: [
      { name: 'model', defaultValue: 'gpt-5-codex' },
      { name: 'temperature', defaultValue: 0.2 },
    ],
  };

  assert.deepEqual(mergeAgentConfigWithProviderDefaults(provider, {
    model: 'custom-model',
  }), {
    model: 'custom-model',
    temperature: 0.2,
  });
});
