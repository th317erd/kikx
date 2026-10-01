'use strict';

// Agent create/edit "wrapper dialog" <-> "guts component" contract.
//
// The core wrapper owns the modal chrome, agent Name, Provider select and the
// submit/POST/PATCH call. The provider-specific config UI and its client-side
// validation live in a guts custom element, resolved per provider:
//   - a plugin that registered an `agent-config-form` descriptor via
//     registerAgentConfigForm(pluginID, { tagName, moduleURL }), or
//   - the core default guts (DEFAULT_AGENT_CONFIG_FORM_TAG) which renders the
//     provider's `configFields`.
//
// Guts contract:
//   setContext({ mode, pluginID, provider, config, secrets, secretState, agent,
//                onValuesChanged }) -> void
//   validate() -> { valid: boolean, errors?: { fieldName: message } } (sync/async)
//   readValues() -> { config, secrets }
//   onValuesChanged({ config, secrets }) -> void   (called on every field change)

export const DEFAULT_AGENT_CONFIG_FORM_TAG = 'kikx-default-agent-config-form';

// Decide whether an agent provider has a plugin-supplied custom config form.
// Pure and injectable so it is unit-testable without a browser: the default
// registration check reads the global custom element registry, while tests can
// pass their own `isRegistered`.
export function selectAgentConfigFormDescriptor(state = {}, provider = null, options = {}) {
  let pluginID = provider?.pluginID;
  if (!pluginID)
    return null;

  let descriptor = state.clientAgentConfigFormsByPluginID?.[pluginID];
  if (!descriptor || typeof descriptor.tagName !== 'string' || descriptor.tagName === '')
    return null;

  let isRegistered = typeof options.isRegistered === 'function'
    ? options.isRegistered
    : defaultIsRegistered;
  if (!isRegistered(descriptor.tagName))
    return null;

  return descriptor;
}

// The guts tag for a provider: the plugin's registered descriptor when present,
// otherwise the core default guts.
export function resolveAgentConfigFormTag(state = {}, provider = null, options = {}) {
  let descriptor = selectAgentConfigFormDescriptor(state, provider, options);
  if (descriptor)
    return descriptor.tagName;

  return options.defaultTag || DEFAULT_AGENT_CONFIG_FORM_TAG;
}

// Locate the live guts element under a host (the wrapper form or the app root).
export function findAgentConfigFormElement(appRoot, gutsTag) {
  if (!appRoot || typeof gutsTag !== 'string' || gutsTag === '' || typeof appRoot.querySelector !== 'function')
    return null;

  return appRoot.querySelector(gutsTag) || null;
}

export function normalizeAgentGutsValues(result) {
  return {
    config: result?.config && typeof result.config === 'object' && !Array.isArray(result.config)
      ? { ...result.config }
      : {},
    secrets: result?.secrets && typeof result.secrets === 'object' && !Array.isArray(result.secrets)
      ? { ...result.secrets }
      : {},
  };
}

// Read values from the guts element on submit. Returns null when the element is
// missing or does not implement readValues, so callers fall back to app state.
export function readAgentGutsValues(element) {
  if (!element || typeof element.readValues !== 'function')
    return null;

  return normalizeAgentGutsValues(element.readValues() || {});
}

export function normalizeAgentGutsErrors(errors) {
  if (!errors || typeof errors !== 'object' || Array.isArray(errors))
    return {};

  let output = {};
  for (let [ key, value ] of Object.entries(errors)) {
    if (typeof value === 'string' && value.trim() !== '')
      output[key] = value.trim();
  }

  return output;
}

// Run client-side guts validation. An element without validate() is treated as
// valid, preserving behavior for providers that rely on server validation only.
export async function validateAgentGuts(element) {
  if (!element || typeof element.validate !== 'function')
    return { valid: true, errors: {} };

  let result = await element.validate();
  if (!result || typeof result !== 'object')
    return { valid: true, errors: {} };

  let errors = normalizeAgentGutsErrors(result.errors);
  return {
    valid: result.valid !== false,
    errors,
  };
}

function defaultIsRegistered(tagName) {
  if (typeof globalThis.customElements === 'undefined')
    return false;

  return Boolean(globalThis.customElements.get(tagName));
}
