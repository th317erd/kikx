'use strict';

export const BUILT_IN_TOOL_COMPONENT_MODULE = '/client/components/tool-renderers/built-in-tool-uses.mjs';

export function builtInToolComponent(tagName) {
  return {
    tagName,
    moduleURL: BUILT_IN_TOOL_COMPONENT_MODULE,
  };
}
