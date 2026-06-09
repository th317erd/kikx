'use strict';

import fs from 'node:fs/promises';
import path from 'node:path';

export class LocalFileAccessService {
  constructor(options = {}) {
    this.cwd = options.cwd || process.cwd();
  }

  async readFile(params = {}) {
    let requestedPath = normalizeRequiredString(params.path, 'path');
    let absolutePath = path.resolve(this.cwd, requestedPath);
    let encoding = normalizeEncoding(params.encoding);
    let stat = await fs.stat(absolutePath);

    if (!stat.isFile())
      throw new Error(`read-file path is not a file: ${absolutePath}`);

    let buffer = await fs.readFile(absolutePath);
    return {
      requestedPath,
      path: absolutePath,
      encoding,
      sizeBytes: stat.size,
      bytesRead: buffer.length,
      truncated: false,
      content: buffer.toString(encoding),
    };
  }
}

function normalizeRequiredString(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '')
    throw new TypeError(`${fieldName} must be a non-empty string`);

  return value.trim();
}

function normalizeEncoding(value) {
  if (value == null || value === '')
    return 'utf8';

  if (value === 'utf-8')
    return 'utf8';

  if (value !== 'utf8' && value !== 'base64')
    throw new TypeError('encoding must be utf8 or base64');

  return value;
}
