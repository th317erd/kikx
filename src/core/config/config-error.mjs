'use strict';

// Boundary error type for configuration access. Callers catch `ConfigError`
// and branch on `code` (for example `config_missing`) and `propertyPath`
// without depending on the provider that produced the failure.
export class ConfigError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'ConfigError';
    this.code = options.code ?? 'config_error';
    this.propertyPath = options.propertyPath ?? null;
  }

  static missing(propertyPath) {
    return new ConfigError(`Missing configuration property: ${propertyPath}`, {
      code: 'config_missing',
      propertyPath,
    });
  }
}
