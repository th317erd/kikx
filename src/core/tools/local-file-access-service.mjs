'use strict';

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export class LocalFileAccessService {
  constructor(options = {}) {
    this.cwd = options.cwd || os.homedir();
  }

  async readFile(params = {}) {
    let requestedPath = normalizeRequiredString(params.path, 'path');
    let absolutePath = path.resolve(normalizeBaseCwd(params.cwd, this.cwd), requestedPath);
    let encoding = normalizeEncoding(params.encoding);
    let rangeRequest = normalizeRangeRequest(params);
    let stat = await fs.stat(absolutePath);

    if (!stat.isFile())
      throw new Error(`read-file path is not a file: ${absolutePath}`);

    if (rangeRequest && encoding !== 'utf8')
      throw new TypeError('line and character ranges require utf8 encoding');

    let buffer = await fs.readFile(absolutePath);
    let fullContent = buffer.toString(encoding);
    let ranged = rangeRequest
      ? applyRange(fullContent, rangeRequest)
      : null;
    let content = ranged ? ranged.content : fullContent;

    return {
      requestedPath,
      path: absolutePath,
      encoding,
      sizeBytes: stat.size,
      // Hash of the WHOLE file, never of the returned range: a write precondition
      // must be satisfiable by a partial read too, or a bot that read lines 1-50
      // would hold a hash nothing else could ever match.
      contentHash: contentHashOf(buffer),
      bytesRead: Buffer.byteLength(content, encoding),
      truncated: Boolean(ranged?.truncated),
      ranged: Boolean(ranged),
      rangeType: ranged?.range.type || null,
      range: ranged?.range || null,
      content,
    };
  }

  async writeFile(params = {}) {
    let requestedPath = normalizeRequiredString(params.path, 'path');
    let absolutePath = path.resolve(normalizeBaseCwd(params.cwd, this.cwd), requestedPath);
    let encoding = normalizeEncoding(params.encoding);
    let mode = normalizeWriteMode(params.mode);
    let createDirectories = params.createDirectories !== false;
    let content = normalizeContentString(params.content);
    let buffer = encodeWriteContent(content, encoding);
    let current = await readFileBytesOrNull(absolutePath);
    let existedBefore = current !== null;

    if (mode === 'create' && existedBefore)
      throw new Error(`write-file refusing to overwrite existing file: ${absolutePath}`);

    // Optimistic concurrency (If-Match semantics). A write is only allowed once
    // the caller has proven it knows what is currently on disk: it must present
    // the hash that read-file handed it. This is what stops a bot from
    // clobbering a file it merely assumed was empty, and it also covers the
    // "I thought this file did not exist, but now it does" race, because a file
    // that exists at write time always demands a hash.
    assertWritePrecondition({
      absolutePath,
      expectedContentHash: params.expectedContentHash,
      currentHash: existedBefore ? contentHashOf(current) : null,
    });

    if (createDirectories)
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });

    await fs.writeFile(absolutePath, buffer, {
      flag: writeFlagForMode(mode),
    });

    let stat = await fs.stat(absolutePath);
    return {
      requestedPath,
      path: absolutePath,
      encoding,
      mode,
      bytesWritten: buffer.length,
      sizeBytes: stat.size,
      created: !existedBefore,
      appended: mode === 'append' && existedBefore,
      createDirectories,
    };
  }
}

function normalizeRequiredString(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '')
    throw new TypeError(`${fieldName} must be a non-empty string`);

  return value.trim();
}

function normalizeBaseCwd(value, fallback) {
  if (typeof value !== 'string' || value.trim() === '')
    return fallback;

  return value.trim();
}

function normalizeContentString(value) {
  if (typeof value !== 'string')
    throw new TypeError('content must be a string');

  return value;
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

function normalizeWriteMode(value) {
  if (value == null || value === '')
    return 'overwrite';

  if (value !== 'overwrite' && value !== 'append' && value !== 'create')
    throw new TypeError('mode must be overwrite, append, or create');

  return value;
}

function encodeWriteContent(content, encoding) {
  if (encoding === 'base64')
    return Buffer.from(content, 'base64');

  return Buffer.from(content, 'utf8');
}

function writeFlagForMode(mode) {
  if (mode === 'append')
    return 'a';

  if (mode === 'create')
    return 'wx';

  return 'w';
}

async function readFileBytesOrNull(filePath) {
  try {
    return await fs.readFile(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT')
      return null;

    throw error;
  }
}

/**
 * sha256 over raw file bytes. The digest covers the whole file so that it is a
 * property of the file, not of the range the caller happened to read.
 */
export function contentHashOf(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

const CONTENT_HASH_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Refuse the write unless the caller proved it read the current contents.
 *
 * Three distinct failures, each with its own message because the remedy
 * differs: read first, re-read because it moved, or supply the hash you were
 * already given.
 */
export function assertWritePrecondition({ absolutePath, expectedContentHash, currentHash }) {
  let provided = normalizeOptionalContentHash(expectedContentHash);

  if (currentHash === null) {
    // Creating a file. Nothing is being overwritten, so there is nothing to
    // prove; a hash here means the caller expected a file that is now gone.
    if (provided)
      throw new Error(
        `write-file expected an existing file to overwrite, but it no longer exists: ${absolutePath}`,
      );

    return;
  }

  if (!provided) {
    throw new Error(
      `write-file requires expectedContentHash because the file already exists: ${absolutePath}. `
      + 'Call read-file first and pass the contentHash it returns.',
    );
  }

  if (provided !== currentHash) {
    throw new Error(
      `File has changed since last read. Please read it again, and provide the correct write content hash: ${absolutePath}`,
    );
  }
}

function normalizeOptionalContentHash(value) {
  if (value == null || value === '')
    return null;

  if (typeof value !== 'string')
    throw new TypeError('expectedContentHash must be a string');

  let normalized = value.trim().toLowerCase();
  if (!CONTENT_HASH_PATTERN.test(normalized))
    throw new TypeError('expectedContentHash must be a 64-character sha256 hex digest, as returned by read-file');

  return normalized;
}

function normalizeRangeRequest(params = {}) {
  let hasLineRange = params.startLine != null || params.endLine != null;
  let hasCharacterRange = params.startCharacter != null || params.endCharacter != null;

  if (hasLineRange && hasCharacterRange)
    throw new TypeError('read-file accepts either a line range or a character range, not both');

  if (hasLineRange) {
    let startLine = normalizePositiveInteger(params.startLine ?? 1, 'startLine');
    let endLine = params.endLine == null ? null : normalizePositiveInteger(params.endLine, 'endLine');
    if (endLine != null && endLine < startLine)
      throw new TypeError('endLine must be greater than or equal to startLine');

    return {
      type: 'line',
      startLine,
      endLine,
    };
  }

  if (hasCharacterRange) {
    let startCharacter = normalizeNonNegativeInteger(params.startCharacter ?? 0, 'startCharacter');
    let endCharacter = params.endCharacter == null ? null : normalizeNonNegativeInteger(params.endCharacter, 'endCharacter');
    if (endCharacter != null && endCharacter < startCharacter)
      throw new TypeError('endCharacter must be greater than or equal to startCharacter');

    return {
      type: 'character',
      startCharacter,
      endCharacter,
    };
  }

  return null;
}

function applyRange(content, rangeRequest) {
  if (rangeRequest.type === 'line')
    return applyLineRange(content, rangeRequest);

  return applyCharacterRange(content, rangeRequest);
}

function applyLineRange(content, { startLine, endLine }) {
  let lines = splitLinesPreservingEndings(content);
  let totalLines = lines.length;
  let normalizedEndLine = endLine == null ? totalLines : endLine;
  let startIndex = Math.min(totalLines, startLine - 1);
  let endIndex = Math.min(totalLines, normalizedEndLine);
  let rangeContent = lines.slice(startIndex, endIndex).join('');

  return {
    content: rangeContent,
    truncated: startLine > 1 || normalizedEndLine < totalLines,
    range: {
      type: 'line',
      startLine,
      endLine: normalizedEndLine,
      totalLines,
    },
  };
}

function applyCharacterRange(content, { startCharacter, endCharacter }) {
  let characters = Array.from(content);
  let totalCharacters = characters.length;
  let normalizedEndCharacter = endCharacter == null ? totalCharacters : Math.min(endCharacter, totalCharacters);
  let normalizedStartCharacter = Math.min(startCharacter, totalCharacters);

  return {
    content: characters.slice(normalizedStartCharacter, normalizedEndCharacter).join(''),
    truncated: normalizedStartCharacter > 0 || normalizedEndCharacter < totalCharacters,
    range: {
      type: 'character',
      startCharacter,
      endCharacter: endCharacter == null ? totalCharacters : endCharacter,
      totalCharacters,
    },
  };
}

function splitLinesPreservingEndings(content) {
  if (content === '')
    return [];

  let lines = [];
  let lineStart = 0;
  for (let index = 0; index < content.length; index++) {
    if (content[index] !== '\n')
      continue;

    lines.push(content.slice(lineStart, index + 1));
    lineStart = index + 1;
  }

  if (lineStart < content.length)
    lines.push(content.slice(lineStart));

  return lines;
}

function normalizePositiveInteger(value, fieldName) {
  let number = Number(value);
  if (!Number.isFinite(number) || number < 1)
    throw new TypeError(`${fieldName} must be a positive integer`);

  return Math.trunc(number);
}

function normalizeNonNegativeInteger(value, fieldName) {
  let number = Number(value);
  if (!Number.isFinite(number) || number < 0)
    throw new TypeError(`${fieldName} must be a non-negative integer`);

  return Math.trunc(number);
}
