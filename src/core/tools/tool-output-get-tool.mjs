'use strict';

import { PluginInterface } from '../plugins/index.mjs';
import { DEFAULT_TOOL_OUTPUT_READ_BYTES } from './tool-output-store.mjs';

export class ToolOutputGetTool extends PluginInterface {
  static pluginID = 'internal:tool-output';
  static featureName = 'get';
  static displayName = 'Get tool output';
  static description = 'Read a stored tool output by ID, optionally bounded to a byte range.';
  static riskLevel = 'none';
  static inputSchema = {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'Tool output ID returned by a previous tool call.',
      },
      start: {
        type: 'integer',
        minimum: 0,
        description: 'Inclusive byte offset to start reading from.',
      },
      end: {
        type: 'integer',
        minimum: 0,
        description: 'Exclusive byte offset to stop reading at.',
      },
      maxBytes: {
        type: 'integer',
        minimum: 1,
        description: 'Maximum bytes to return. Defaults to a safe chunk size when no end is provided.',
      },
      full: {
        type: 'boolean',
        description: 'Set true to request the entire stored output. Large full reads may return another pointer.',
      },
    },
    required: [ 'id' ],
    additionalProperties: false,
  };
  static help = 'Use tool-output-get when a prior tool result was too large to include inline. Pass id to read the first chunk, or pass start/end byte offsets to read a range.';

  async _execute(params = {}) {
    return await resolveToolOutputStore(this.context).getToolOutput({
      id: params.id,
      start: params.start,
      end: params.end,
      maxBytes: params.full === true
        ? undefined
        : params.end == null ? params.maxBytes ?? DEFAULT_TOOL_OUTPUT_READ_BYTES : params.maxBytes,
    });
  }
}

function resolveToolOutputStore(context = {}) {
  let service = context.toolOutputStore || context.services?.toolOutputStore || resolveContextService(context, 'toolOutputStore');
  if (!service?.getToolOutput)
    throw new Error('tool-output-get requires a toolOutputStore service');

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
