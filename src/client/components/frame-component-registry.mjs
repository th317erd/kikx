'use strict';

let loadedModuleURLs = new Set();

export async function loadClientComponentDescriptors(components = []) {
  let descriptors = normalizeDescriptors(components);
  for (let descriptor of descriptors) {
    if (!descriptor.moduleURL || loadedModuleURLs.has(descriptor.moduleURL))
      continue;

    await import(descriptor.moduleURL);
    loadedModuleURLs.add(descriptor.moduleURL);
  }

  return descriptors;
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

function normalizeDescriptors(components) {
  return (Array.isArray(components) ? components : [])
    .filter((component) => (
      component
      && typeof component.tagName === 'string'
      && typeof component.moduleURL === 'string'
      && (component.kind === 'frame' || component.kind === 'tool')
    ));
}
