'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  contextWindowForModel,
  isAutoContextWindowValue,
  seedContextWindowForModel,
} from '../../src/client/state/agent-model-context.mjs';

const PROVIDER = {
  configFields: [
    {
      name: 'model',
      type: 'select',
      options: [
        { value: 'mimo-cloud', label: 'Mimo Cloud', contextWindow: 1_048_576 },
        { value: 'small-local', label: 'Small Local', contextWindow: 8_192 },
        { value: 'unknown', label: 'Unknown' },
      ],
    },
    { name: 'contextWindowTokens', type: 'number' },
  ],
};

test('contextWindowForModel reads the selected option metadata', () => {
  assert.equal(contextWindowForModel(PROVIDER, 'mimo-cloud'), 1_048_576);
  assert.equal(contextWindowForModel(PROVIDER, 'small-local'), 8_192);
  assert.equal(contextWindowForModel(PROVIDER, 'unknown'), null);
  assert.equal(contextWindowForModel(PROVIDER, ''), null);
});

test('auto context values can be replaced when the model changes', () => {
  assert.equal(isAutoContextWindowValue(PROVIDER, ''), true);
  assert.equal(isAutoContextWindowValue(PROVIDER, 1_048_576), true);
  assert.equal(isAutoContextWindowValue(PROVIDER, 65_536), false);
});

test('seedContextWindowForModel fills blanks and swaps auto values, but never overrides a human value', () => {
  assert.equal(seedContextWindowForModel(PROVIDER, { model: 'mimo-cloud' }).contextWindowTokens, 1_048_576);
  assert.equal(seedContextWindowForModel(PROVIDER, { model: 'small-local', contextWindowTokens: 1_048_576 }).contextWindowTokens, 8_192);
  assert.equal(seedContextWindowForModel(PROVIDER, { model: 'mimo-cloud', contextWindowTokens: 65_536 }).contextWindowTokens, 65_536);
  assert.equal(seedContextWindowForModel(PROVIDER, { model: 'unknown', contextWindowTokens: 1_048_576 }).contextWindowTokens, null);
});
