'use strict';

export function defaultConfigForProvider(provider) {
  let config = {};

  for (let field of provider?.configFields || []) {
    if (field.secret)
      continue;

    if (field.defaultValue !== undefined)
      config[field.name] = field.defaultValue;
  }

  return config;
}

export function mergeAgentConfigWithProviderDefaults(provider, config) {
  return {
    ...defaultConfigForProvider(provider),
    ...(config || {}),
  };
}

// Mirror the live agent-config guts values into app state so a full shell
// re-render (which rebuilds the guts element) can reseed it via setContext
// without losing edits. Kept here as a pure helper so it is unit-testable.
export function applyAgentConfigValues(state, values) {
  if (!state || typeof state !== 'object' || !values || typeof values !== 'object')
    return;

  state.agentFormConfig = values.config && typeof values.config === 'object' ? { ...values.config } : {};
  state.agentFormSecrets = values.secrets && typeof values.secrets === 'object' ? { ...values.secrets } : {};
}
