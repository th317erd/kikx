'use strict';

import { PluginInterface } from '../plugins/index.mjs';

const MAX_BYTES_LIMIT = 1048576;

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
      maxBytes: {
        type: 'integer',
        minimum: 1,
        maximum: MAX_BYTES_LIMIT,
        description: 'Maximum bytes to read from the file.',
      },
    },
    required: [ 'path' ],
    additionalProperties: false,
  };
  static help = 'Use read-file to inspect a local file by path. It returns content, size, bytes read, and whether the content was truncated.';

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
