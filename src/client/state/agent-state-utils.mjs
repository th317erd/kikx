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

export function defaultTagValues(definitions = []) {
  let values = {};
  for (let definition of agentTagDefinitions(definitions))
    values[definition.name] = definition.defaultValue ?? '';
  return values;
}

export function tagValuesFromAgent(agent, definitions = []) {
  let values = defaultTagValues(definitions);
  let tags = Array.isArray(agent?.tags) ? agent.tags : [];
  for (let tag of tags) {
    if (tag?.target_type && tag.target_type !== 'agent')
      continue;
    if (Object.hasOwn(values, tag.name))
      values[tag.name] = tag.value;
  }
  return values;
}

export function buildAgentTags(definitions = [], values = {}) {
  let tags = [];
  for (let definition of agentTagDefinitions(definitions)) {
    let value = values?.[definition.name];
    tags.push({
      target_type: 'agent',
      name: definition.name,
      value: value === '' || value == null ? null : value,
    });
  }
  return tags;
}

export function agentTagDefinitions(definitions = []) {
  return (Array.isArray(definitions) ? definitions : []).filter((definition) => (
    definition
    && typeof definition.name === 'string'
    && (!Array.isArray(definition.targetTypes) || definition.targetTypes.includes('agent'))
  ));
}
