'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { register } from 'node:module';
import { installDom } from './support/mini-dom.mjs';

register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);

const { document } = installDom();
await import('../../src/client/components/kikx-default-agent-config-form.mjs');

const PROVIDER = {
  pluginID: 'ollama-agent',
  configFields: [
    {
      name: 'model',
      label: 'Model',
      type: 'select',
      options: [
        { value: 'mimo-cloud', label: 'Mimo Cloud', contextWindow: 1_048_576 },
        { value: 'small-local', label: 'Small Local', contextWindow: 8_192 },
      ],
    },
    { name: 'contextWindowTokens', label: 'Context window (tokens)', type: 'number' },
  ],
};

function createForm(config = { model: 'mimo-cloud' }) {
  let element = document.createElement('kikx-default-agent-config-form');
  element.setContext({ mode: 'create', pluginID: PROVIDER.pluginID, provider: PROVIDER, config, secrets: {} });
  return element;
}

test('the context window starts at the selected model value, not blank', () => {
  let element = createForm();
  assert.equal(element.readValues().config.contextWindowTokens, 1_048_576);
  assert.equal(Number(element._controls.get('contextWindowTokens').value), 1_048_576);
});

test('changing models swaps an auto context value, while a manual value wins', () => {
  let element = createForm();
  let modelField = PROVIDER.configFields[0];

  element._onFieldChange(modelField, 'small-local');
  assert.equal(element.readValues().config.contextWindowTokens, 8_192);

  element._controls.get('contextWindowTokens').value = '65536';
  element._onFieldChange({ name: 'contextWindowTokens', type: 'number' }, '65536');
  element._onFieldChange(modelField, 'mimo-cloud');
  assert.equal(element.readValues().config.contextWindowTokens, 65_536);
});
