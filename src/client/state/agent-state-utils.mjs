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
