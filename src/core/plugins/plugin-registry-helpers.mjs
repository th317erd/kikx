'use strict';

// Pure validation and normalization helpers for the plugin registry. Kept out
// of plugin-registry.mjs so registration/orchestration stays under the cap.

import {
  clientComponentKindError,
  isClientComponentKind,
} from '../../shared/client-component-kinds.mjs';

export function optionArgs(args, index, options) {
  let next = args.slice();
  while (next.length < index) next.push(undefined);
  next[index] = options;
  return next;
}

// Read a service from a context that may implement any of require/get/has or be a plain
// Map. Used by the release path, where throwing would abort an unload.
export function readContextEntry(context, name) {
  if (!context)
    return undefined;
  if (typeof context.require === 'function')
    return context.require(name);
  if (typeof context.get === 'function')
    return context.get(name);
  return undefined;
}

export function isSubclassOf(candidate, BaseClass) {
  return typeof candidate === 'function'
    && candidate !== BaseClass
    && candidate.prototype instanceof BaseClass;
}

export function normalizeComponentDescriptor(descriptor, defaults = {}) {
  let input = normalizeDescriptorInput(descriptor);
  let kind = normalizeRequiredString(input.kind || defaults.kind, 'component kind');
  // The kind vocabulary lives in ONE place (src/shared/client-component-kinds.mjs)
  // and is imported by both this registry and the browser. It used to be a local
  // allowlist here and two DIFFERENT hardcoded lists on the client, which is how
  // 'toolbar-action' and 'settings-panel' came to be accepted-and-advertised here
  // while being discarded on arrival. See that module for the full measurement.
  if (!isClientComponentKind(kind))
    throw new TypeError(clientComponentKindError(kind));

  let output = {
    ...input,
    kind,
    tagName: normalizeCustomElementName(input.tagName || input.tag || input.elementName),
    moduleURL: normalizeRequiredString(input.moduleURL || input.module || input.url, 'component moduleURL'),
  };

  if (kind === 'frame')
    output.frameType = normalizeRequiredString(input.frameType || defaults.frameType, 'frameType');
  else if (kind === 'tool')
    output.toolName = normalizeRequiredString(input.toolName || defaults.toolName, 'toolName');
  else if (kind === 'agent-config-form')
    output.pluginID = normalizeRequiredString(input.pluginID || defaults.pluginID, 'pluginID');
  else
    output.surfaceID = normalizeRequiredString(input.surfaceID || input.id || defaults.surfaceID, 'surface id');

  delete output.tag;
  delete output.elementName;
  delete output.module;
  delete output.url;
  return output;
}

export function normalizeDescriptorInput(descriptor) {
  if (typeof descriptor === 'string')
    return { tagName: descriptor };

  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor))
    throw new TypeError('Component descriptor must be an object');

  return { ...descriptor };
}

export function normalizeRequiredString(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '')
    throw new TypeError(`${fieldName} must be a non-empty string`);

  return value.trim();
}

export function normalizeCustomElementName(value) {
  let name = normalizeRequiredString(value, 'component tagName');
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/.test(name))
    throw new TypeError(`Invalid custom element tagName: ${name}`);

  return name;
}
