'use strict';

import { PluginInterface } from '../plugins/index.mjs';

export class WriteFileTool extends PluginInterface {
  static pluginID = 'internal:filesystem';
  static featureName = 'write-file';
  static displayName = 'Write file';
  static description = 'Write a local file to any path visible to the Kikx server process.';
  static riskLevel = 'none';
  static inputSchema = {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Absolute path, or a path relative to the Kikx server working directory.',
      },
      content: {
        type: 'string',
        description: 'File content to write. For base64 encoding, this must be a base64 string.',
      },
      encoding: {
        type: 'string',
        enum: [ 'utf8', 'base64' ],
        description: 'Encoding of the provided content. Defaults to utf8.',
      },
      mode: {
        type: 'string',
        enum: [ 'overwrite', 'append', 'create' ],
        description: 'Write mode. overwrite replaces the file, append adds to the end, create fails if the file already exists.',
      },
      createDirectories: {
        type: 'boolean',
        description: 'Create missing parent directories before writing. Defaults to true.',
      },
    },
    required: [ 'path', 'content' ],
    additionalProperties: false,
  };
  static help = 'Use write-file to write content to a local file. mode defaults to overwrite; use append to add to an existing file, or create to fail if the file already exists. The tool returns write metadata only, while the full tool result is still stored in AeorDB.';

  async _execute(params = {}) {
    return await resolveFileAccess(this.context).writeFile(params);
  }
}

function resolveFileAccess(context = {}) {
  let service = context.fileAccess || context.services?.fileAccess || resolveContextService(context, 'fileAccess');
  if (!service?.writeFile)
    throw new Error('write-file requires a fileAccess service');

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
