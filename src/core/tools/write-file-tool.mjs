'use strict';

import { PluginInterface } from '../plugins/index.mjs';
import { resolveContextService, resolveFileToolParams } from './file-tool-cwd.mjs';
import { builtInToolComponent } from './tool-client-components.mjs';

export class WriteFileTool extends PluginInterface {
  static pluginID = 'internal:filesystem';
  static featureName = 'write-file';
  static displayName = 'Write file';
  static description = 'Write a local file to any path visible to the Kikx server process.';
  static frameType = 'WriteFileToolFrame';
  static clientComponent = builtInToolComponent('kikx-write-file-use');
  static riskLevel = 'none';
  static inputSchema = {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Absolute path, or a path relative to your session cwd when set with cwd-set.',
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
      expectedContentHash: {
        type: 'string',
        description: 'Required when the file already exists: the contentHash returned by read-file for the current contents. The write is refused if it does not match, which proves you read the file before overwriting it.',
      },
    },
    required: [ 'path', 'content' ],
    additionalProperties: false,
  };
  static help = [
    'Use write-file to write content to a local file. Relative paths resolve from',
    'your session cwd when one is set with cwd-set; otherwise they resolve from the',
    'Kikx server base cwd. mode defaults to overwrite; use append to add to an',
    'existing file, or create to fail if the file already exists. The tool returns',
    'write metadata only, while the full tool result is stored in AeorDB.',
    '',
    'You must LOOK before you write. read-file returns contentHash for the file it',
    'read; pass that value as expectedContentHash whenever the file may already',
    'exist. The write is refused, with the file untouched, if the contents changed',
    'since that read, or if the file exists and you supplied no hash at all. This',
    'is deliberate: it is what prevents you from silently overwriting a file you',
    'only assumed was empty. Omitting the hash is correct only when the file does',
    'not exist yet.',
  ].join('\n');

  async _execute(params = {}) {
    return await resolveFileAccess(this.context).writeFile(await resolveFileToolParams(params, this.context));
  }
}

function resolveFileAccess(context = {}) {
  let service = context.fileAccess || context.services?.fileAccess || resolveContextService(context, 'fileAccess');
  if (!service?.writeFile)
    throw new Error('write-file requires a fileAccess service');

  return service;
}
