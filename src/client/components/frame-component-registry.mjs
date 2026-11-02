'use strict';

import { isClientComponentKind } from '../../shared/client-component-kinds.mjs';

let loadedModuleURLs = new Set();

// G22: module URLs were only ever added to this set. Descriptor URLs can carry
// cache-busting query strings across reloads, so the set can grow for the life
// of the tab. Keep the most recently loaded URLs; a URL evicted here is simply
// re-imported later and ESM returns the already-evaluated module (no re-run).
export const MAX_LOADED_MODULE_URLS = 200;

export function recordLoadedModuleURL(moduleURL) {
  if (typeof moduleURL !== 'string' || moduleURL === '')
    return;

  // Re-insert so `Set` iteration order (oldest-first) tracks recency.
  loadedModuleURLs.delete(moduleURL);
  loadedModuleURLs.add(moduleURL);
  while (loadedModuleURLs.size > MAX_LOADED_MODULE_URLS)
    loadedModuleURLs.delete(loadedModuleURLs.values().next().value);
}

export function loadedModuleURLCount() {
  return loadedModuleURLs.size;
}

export async function loadClientComponentDescriptors(components = []) {
  let descriptors = normalizeDescriptors(components);
  for (let descriptor of descriptors) {
    if (!descriptor.moduleURL || loadedModuleURLs.has(descriptor.moduleURL))
      continue;

    await import(descriptor.moduleURL);
    recordLoadedModuleURL(descriptor.moduleURL);
  }

  return descriptors;
}

export function selectMainAppDescriptor(components = []) {
  return normalizeDescriptors(components).find((component) => component.kind === 'main-app') || null;
}

export function resolveFrameComponentDescriptor(frame, state = {}) {
  if (!frame)
    return null;

  let toolName = frame.content?.toolName;
  let isGenericToolFrame = frame.type === 'ToolCall' || frame.type === 'ToolResult';
  if (toolName && isGenericToolFrame) {
    let toolDescriptor = state.clientToolComponentsByName?.[toolName];
    if (toolDescriptor)
      return toolDescriptor;
  }

  let frameDescriptor = state.clientFrameComponentsByType?.[frame.type] || null;
  if (frameDescriptor)
    return frameDescriptor;

  if (toolName)
    return state.clientToolComponentsByName?.[toolName] || null;

  return null;
}

// Every known kind passes. There is deliberately no local list here: the
// vocabulary is imported so this file and the server registry cannot disagree
// about what a kind is. When they did disagree, this function was a .filter() --
// a descriptor for a kind missing from the list was dropped, and because
// loadClientComponentDescriptors() iterates THIS result, its moduleURL was never
// imported. No error, no log, no module. 'toolbar-action' and 'settings-panel'
// lived in that hole while the server advertised both.
export function normalizeClientComponentDescriptors(components) {
  return (Array.isArray(components) ? components : [])
    .filter((component) => (
      component
      && typeof component === 'object'
      && isClientComponentKind(component.kind)
      && typeof component.tagName === 'string'
      && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/.test(component.tagName)
      && typeof component.moduleURL === 'string'
      && component.moduleURL.trim() !== ''
    ));
}

const normalizeDescriptors = normalizeClientComponentDescriptors;
