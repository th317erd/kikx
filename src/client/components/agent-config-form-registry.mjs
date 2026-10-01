'use strict';

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

// Read a provider's custom form values on submit. Returns null when the
// provider has no custom form or the element does not implement readConfig, so
// callers keep using the generic state path.
export function readCustomAgentConfig(state, provider, form, options = {}) {
  let descriptor = selectAgentConfigFormDescriptor(state, provider, options);
  if (!descriptor || !form || typeof form.querySelector !== 'function')
    return null;

  let element = form.querySelector(descriptor.tagName);
  if (!element || typeof element.readConfig !== 'function')
    return null;

  let result = element.readConfig() || {};
  return {
    config: result.config && typeof result.config === 'object' ? result.config : {},
    secrets: result.secrets && typeof result.secrets === 'object' ? result.secrets : {},
  };
}

function defaultIsRegistered(tagName) {
  if (typeof globalThis.customElements === 'undefined')
    return false;

  return Boolean(globalThis.customElements.get(tagName));
}
