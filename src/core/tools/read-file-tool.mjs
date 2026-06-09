'use strict';

import { PluginInterface } from '../plugins/index.mjs';

export class ReadFileTool extends PluginInterface {
  static pluginID = 'internal:filesystem';
  static featureName = 'read-file';
  static displayName = 'Read file';
  static description = 'Read a local file from any path visible to the Kikx server process.';
  static riskLevel = 'none';
  static inputSchema = {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Absolute path, or a path relative to the Kikx server working directory.',
      },
      encoding: {
        type: 'string',
        enum: [ 'utf8', 'base64' ],
        description: 'Output encoding for the returned file content.',
      },
      startLine: {
        type: 'integer',
        minimum: 1,
        description: 'First line to return, using 1-based line numbers. Line ranges are inclusive.',
      },
      endLine: {
        type: 'integer',
        minimum: 1,
        description: 'Last line to return, using 1-based line numbers. Line ranges are inclusive.',
      },
      startCharacter: {
        type: 'integer',
        minimum: 0,
        description: 'First character to return, using a 0-based character offset.',
      },
      endCharacter: {
        type: 'integer',
        minimum: 0,
        description: 'Exclusive character offset where reading should stop.',
      },
    },
    required: [ 'path' ],
    additionalProperties: false,
  };
  static help = 'Use read-file to inspect a local file by path. Use startLine/endLine for 1-based inclusive line ranges, or startCharacter/endCharacter for 0-based character ranges with an exclusive end. Do not mix line and character ranges. The full tool output is stored in AeorDB; very large results will be returned as a tool output pointer that you can read with tool-output-get.';

  async _execute(params = {}) {
    return await resolveFileAccess(this.context).readFile(params);
  }
}

function resolveFileAccess(context = {}) {
  let service = context.fileAccess || context.services?.fileAccess || resolveContextService(context, 'fileAccess');
  if (!service?.readFile)
    throw new Error('read-file requires a fileAccess service');

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
