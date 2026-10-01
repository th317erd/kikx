'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_AGENT_CONFIG_FORM_TAG,
  findAgentConfigFormElement,
  readAgentGutsValues,
  resolveAgentConfigFormTag,
  selectAgentConfigFormDescriptor,
  validateAgentGuts,
} from '../../src/client/components/agent-config-form-registry.mjs';

function descriptorFor(pluginID, tagName = 'kog-agent-config-form') {
  return {
    kind: 'agent-config-form',
    pluginID,
    tagName,
    moduleURL: `/api/v1/plugin-assets/${pluginID}/agent-config-form.mjs`,
  };
}

test('selectAgentConfigFormDescriptor returns the form for the provider pluginID', () => {
  let descriptor = descriptorFor('codex-agent');
  let state = { clientAgentConfigFormsByPluginID: { 'codex-agent': descriptor } };

  let selected = selectAgentConfigFormDescriptor(state, { pluginID: 'codex-agent' }, { isRegistered: () => true });
  assert.equal(selected, descriptor);
});

test('selectAgentConfigFormDescriptor falls back when no provider or form exists', () => {
  let state = { clientAgentConfigFormsByPluginID: {} };

  assert.equal(selectAgentConfigFormDescriptor(state, null, { isRegistered: () => true }), null);
  assert.equal(selectAgentConfigFormDescriptor(state, { pluginID: 'unknown' }, { isRegistered: () => true }), null);
  assert.equal(
    selectAgentConfigFormDescriptor(
      { clientAgentConfigFormsByPluginID: { 'codex-agent': descriptorFor('codex-agent') } },
      { pluginID: 'codex-agent' },
      { isRegistered: () => false },
    ),
    null,
  );
});

test('selectAgentConfigFormDescriptor requires a tag name', () => {
  let state = { clientAgentConfigFormsByPluginID: { 'codex-agent': { pluginID: 'codex-agent' } } };
  assert.equal(
    selectAgentConfigFormDescriptor(state, { pluginID: 'codex-agent' }, { isRegistered: () => true }),
    null,
  );
});

test('resolveAgentConfigFormTag uses the plugin descriptor when present, else the core default', () => {
  let state = { clientAgentConfigFormsByPluginID: { 'codex-agent': descriptorFor('codex-agent') } };

  assert.equal(
    resolveAgentConfigFormTag(state, { pluginID: 'codex-agent' }, { isRegistered: () => true }),
    'kog-agent-config-form',
  );
  assert.equal(
    resolveAgentConfigFormTag(state, { pluginID: 'other' }, { isRegistered: () => true }),
    DEFAULT_AGENT_CONFIG_FORM_TAG,
  );
  assert.equal(
    resolveAgentConfigFormTag(state, null, { isRegistered: () => true }),
    DEFAULT_AGENT_CONFIG_FORM_TAG,
  );
});

test('findAgentConfigFormElement queries a host by guts tag', () => {
  let element = { readValues() {} };
  let host = { querySelector: (selector) => selector === 'kog-agent-config-form' ? element : null };

  assert.equal(findAgentConfigFormElement(host, 'kog-agent-config-form'), element);
  assert.equal(findAgentConfigFormElement(host, ''), null);
  assert.equal(findAgentConfigFormElement(null, 'kog-agent-config-form'), null);
});

test('readAgentGutsValues reads and normalizes the guts readValues result', () => {
  let element = {
    readValues() {
      return {
        config: { baseUrl: 'http://127.0.0.1:8090', model: 'local' },
        secrets: { apiKey: 'sk-x' },
      };
    },
  };

  assert.deepEqual(readAgentGutsValues(element), {
    config: { baseUrl: 'http://127.0.0.1:8090', model: 'local' },
    secrets: { apiKey: 'sk-x' },
  });
});

test('readAgentGutsValues returns null without an element or readValues', () => {
  assert.equal(readAgentGutsValues(null), null);
  assert.equal(readAgentGutsValues({}), null);
});

test('readAgentGutsValues normalizes a malformed result', () => {
  let element = { readValues: () => ({ config: 'nope', secrets: null }) };
  assert.deepEqual(readAgentGutsValues(element), { config: {}, secrets: {} });
});

test('validateAgentGuts treats a missing validate() as valid', async () => {
  assert.deepEqual(await validateAgentGuts(null), { valid: true, errors: {} });
  assert.deepEqual(await validateAgentGuts({}), { valid: true, errors: {} });
});

test('validateAgentGuts normalizes errors and supports async validate()', async () => {
  let valid = await validateAgentGuts({ validate: () => ({ valid: true }) });
  assert.deepEqual(valid, { valid: true, errors: {} });

  let invalid = await validateAgentGuts({
    validate: async () => ({ valid: false, errors: { apiKey: '  required  ', ignored: 5, empty: '' } }),
  });
  assert.deepEqual(invalid, { valid: false, errors: { apiKey: 'required' } });

  // valid omitted but errors present is treated as valid (explicit false only).
  let implicit = await validateAgentGuts({ validate: () => ({ errors: { apiKey: 'nope' } }) });
  assert.equal(implicit.valid, true);
});
