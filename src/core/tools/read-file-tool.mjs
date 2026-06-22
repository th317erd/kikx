'use strict';

import { PluginInterface } from '../plugins/index.mjs';
import { resolveContextService, resolveFileToolParams } from './file-tool-cwd.mjs';
import { builtInToolComponent } from './tool-client-components.mjs';

export class ReadFileTool extends PluginInterface {
  static pluginID = 'internal:filesystem';
  static featureName = 'read-file';
  static displayName = 'Read file';
  static description = 'Read a local file from any path visible to the Kikx server process.';
  static frameType = 'ReadFileToolFrame';
  static clientComponent = builtInToolComponent('kikx-read-file-use');
  static riskLevel = 'none';
  static inputSchema = {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Absolute path, or a path relative to your session cwd when set with cwd-set.',
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
  static help = 'Use read-file to inspect a local file by path. Relative paths resolve from your session cwd when one is set with cwd-set; otherwise they resolve from the Kikx server base cwd. Use startLine/endLine for 1-based inclusive line ranges, or startCharacter/endCharacter for 0-based character ranges with an exclusive end. Do not mix line and character ranges. The full tool output is stored in AeorDB; very large results will be returned as a tool output pointer that you can read with output-read.';

  async _execute(params = {}) {
    return await resolveFileAccess(this.context).readFile(await resolveFileToolParams(params, this.context));
  }
}

function resolveFileAccess(context = {}) {
  let service = context.fileAccess || context.services?.fileAccess || resolveContextService(context, 'fileAccess');
  if (!service?.readFile)
    throw new Error('read-file requires a fileAccess service');

  return service;
}
