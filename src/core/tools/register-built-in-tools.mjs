'use strict';

import { WebFetchTool } from './web-fetch-tool.mjs';
import { WebSearchTool } from './web-search-tool.mjs';

export const BUILT_IN_TOOLS = [
  [ 'web-search', WebSearchTool ],
  [ 'web-fetch', WebFetchTool ],
];

export function registerBuiltInTools(pluginRegistry) {
  if (!pluginRegistry?.registerTool)
    throw new TypeError('registerBuiltInTools() requires a plugin registry');

  for (let [name, ToolClass] of BUILT_IN_TOOLS) {
    if (!pluginRegistry.getTool?.(name))
      pluginRegistry.registerTool(name, ToolClass);
  }
}
