'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  readCustomAgentConfig,
  selectAgentConfigFormDescriptor,
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

test('readCustomAgentConfig reads config and secrets from the custom form element', () => {
  let state = { clientAgentConfigFormsByPluginID: { 'codex-agent': descriptorFor('codex-agent') } };
  let element = {
    readConfig() {
      return {
        config: { baseUrl: 'http://127.0.0.1:8090', model: 'local' },
        secrets: { apiKey: 'sk-x' },
      };
    },
  };
  let form = { querySelector: (selector) => selector === 'kog-agent-config-form' ? element : null };

  assert.deepEqual(
    readCustomAgentConfig(state, { pluginID: 'codex-agent' }, form, { isRegistered: () => true }),
    {
      config: { baseUrl: 'http://127.0.0.1:8090', model: 'local' },
      secrets: { apiKey: 'sk-x' },
    },
  );
});

test('readCustomAgentConfig returns null without a form, element or readConfig', () => {
  let state = { clientAgentConfigFormsByPluginID: { 'codex-agent': descriptorFor('codex-agent') } };
  let provider = { pluginID: 'codex-agent' };

  assert.equal(readCustomAgentConfig(state, provider, null, { isRegistered: () => true }), null);
  assert.equal(
    readCustomAgentConfig(state, provider, { querySelector: () => null }, { isRegistered: () => true }),
    null,
  );
  assert.equal(
    readCustomAgentConfig(state, provider, { querySelector: () => ({}) }, { isRegistered: () => true }),
    null,
  );
  assert.equal(
    readCustomAgentConfig(state, { pluginID: 'other' }, { querySelector: () => ({}) }, { isRegistered: () => true }),
    null,
  );
});

test('readCustomAgentConfig normalizes a malformed readConfig result', () => {
  let state = { clientAgentConfigFormsByPluginID: { 'codex-agent': descriptorFor('codex-agent') } };
  let form = {
    querySelector: () => ({ readConfig: () => ({ config: 'nope', secrets: null }) }),
  };

  assert.deepEqual(
    readCustomAgentConfig(state, { pluginID: 'codex-agent' }, form, { isRegistered: () => true }),
    { config: {}, secrets: {} },
  );
});
