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
      bytesRead: Buffer.byteLength(content, encoding),
      truncated: Boolean(ranged?.truncated),
      ranged: Boolean(ranged),
      rangeType: ranged?.range.type || null,
      range: ranged?.range || null,
      content,
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
