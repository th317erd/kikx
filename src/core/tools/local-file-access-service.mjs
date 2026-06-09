'use strict';

import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_MAX_BYTES = 65536;
const MAX_BYTES_LIMIT = 1048576;

export class LocalFileAccessService {
  constructor(options = {}) {
    this.cwd = options.cwd || process.cwd();
  }

  async readFile(params = {}) {
    let requestedPath = normalizeRequiredString(params.path, 'path');
    let absolutePath = path.resolve(this.cwd, requestedPath);
    let encoding = normalizeEncoding(params.encoding);
    let maxBytes = clampInteger(params.maxBytes, DEFAULT_MAX_BYTES, 1, MAX_BYTES_LIMIT);
    let stat = await fs.stat(absolutePath);

    if (!stat.isFile())
      throw new Error(`read-file path is not a file: ${absolutePath}`);

    let { buffer, bytesRead } = await readFilePrefix(absolutePath, maxBytes);
    return {
      requestedPath,
      path: absolutePath,
      encoding,
      sizeBytes: stat.size,
      bytesRead,
      truncated: stat.size > bytesRead,
      content: buffer.toString(encoding),
    };
  }
}

async function readFilePrefix(filePath, maxBytes) {
  let handle = await fs.open(filePath, 'r');
  try {
    let buffer = Buffer.alloc(maxBytes);
    let { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return {
      buffer: buffer.subarray(0, bytesRead),
      bytesRead,
    };
  } finally {
    await handle.close();
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

function clampInteger(value, defaultValue, min, max) {
  let number = Number(value);
  if (!Number.isFinite(number))
    number = defaultValue;

  number = Math.trunc(number);
  return Math.min(max, Math.max(min, number));
}
