'use strict';

import { ReadFileTool } from './read-file-tool.mjs';
import { ToolOutputGetTool } from './tool-output-get-tool.mjs';
import { WebFetchTool } from './web-fetch-tool.mjs';
import { WebSearchTool } from './web-search-tool.mjs';
import { WriteFileTool } from './write-file-tool.mjs';

export const BUILT_IN_TOOLS = [
  [ 'web-search', WebSearchTool ],
  [ 'web-fetch', WebFetchTool ],
  [ 'read-file', ReadFileTool ],
  [ 'write-file', WriteFileTool ],
  [ 'tool-output-get', ToolOutputGetTool ],
];

export function registerBuiltInTools(pluginRegistry) {
  if (!pluginRegistry?.registerTool)
    throw new TypeError('registerBuiltInTools() requires a plugin registry');

  for (let [name, ToolClass] of BUILT_IN_TOOLS) {
    if (!pluginRegistry.getTool?.(name))
      pluginRegistry.registerTool(name, ToolClass);
  }
}
