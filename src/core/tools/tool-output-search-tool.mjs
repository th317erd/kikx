'use strict';

import { PluginInterface } from '../plugins/index.mjs';
import { formatSearchResponse } from './database-tools.mjs';
import { builtInToolComponent } from './tool-client-components.mjs';

export class OutputSearchTool extends PluginInterface {
  static pluginID = 'internal:tool-output';
  static featureName = 'search';
  static displayName = 'Search stored tool outputs';
  static description = 'Search persisted tool outputs in AeorDB and return hit locators with range fetch hints.';
  static frameType = 'StoredOutputLocatorSearchToolFrame';
  static clientComponent = builtInToolComponent('kikx-output-grep-use');
  static riskLevel = 'none';
  static inputSchema = {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Broad fuzzy search query. At least one of query or where is required.',
      },
      where: {
        type: 'object',
        description: 'Structured AeorDB where clause scoped to stored tool outputs.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 1000,
        description: 'Maximum result count.',
      },
      offset: {
        type: 'integer',
        minimum: 0,
        description: 'Result offset.',
      },
      maxMatchesPerResult: {
        type: 'integer',
        minimum: 1,
        maximum: 50,
        description: 'Maximum hit locators per result.',
      },
      snippetChars: {
        type: 'integer',
        minimum: 1,
        maximum: 4096,
        description: 'Maximum snippet characters per locator.',
      },
      matchContextLines: {
        type: 'integer',
        minimum: 0,
        description: 'Line context for stored-file fetch hints.',
      },
    },
    additionalProperties: false,
  };
  static help = 'Use output-search to search persisted tool outputs. Results include toolOutputID plus locator fetch hints; use output-read by ID for byte ranges or database-fetch with locator hints.';

  async _execute(params = {}) {
    let store = resolveToolOutputStore(this.context);
    let result = await store.searchToolOutputs(params);
    let response = formatSearchResponse(result, {
      path: store.rootPath,
      query: params.query || null,
      where: params.where || null,
    });

    response.results = response.results.map((entry) => ({
      ...entry,
      toolOutputID: toolOutputIDFromPath(entry.path),
      outputReadTool: 'output-read',
    }));
    response.outputReadInstructions = 'If a result path belongs to a stored output, use output-read with toolOutputID to read byte ranges of the full serialized output.';

    return response;
  }
}

function toolOutputIDFromPath(path) {
  let match = String(path || '').match(/\/tool-outputs\/([^/]+)\//);
  return match ? decodeURIComponent(match[1]) : null;
}

function resolveToolOutputStore(context = {}) {
  let service = context.toolOutputStore || context.services?.toolOutputStore || resolveContextService(context, 'toolOutputStore');
  if (!service?.searchToolOutputs)
    throw new Error('output-search requires a toolOutputStore service');

  return service;
}

function resolveContextService(context, name) {
  let appContext = context.services?.context || context.context;
  if (appContext?.has?.(name) && typeof appContext.require === 'function')
    return appContext.require(name);

  if (typeof appContext?.require === 'function') {
    try {
      return appContext.require(name);
    } catch (_error) {
      return null;
    }
  }

  return null;
}
