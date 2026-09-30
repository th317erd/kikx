'use strict';

import fsp from 'node:fs/promises';

import { normalizeRegexFlags } from './process-manager-normalizers.mjs';

async function readWholeFile(filePath) {
  try {
    return await fsp.readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT')
      return '';

    throw error;
  }
}

async function readFileRange(filePath, range) {
  let content = await readWholeFile(filePath);
  return sliceTextByByteRange(content, range);
}

async function readCombined(record, range) {
  let stdout = await readWholeFile(record.stdoutPath);
  let stderr = await readWholeFile(record.stderrPath);
  let combined = stderr ? `${stdout}\n--- stderr ---\n${stderr}` : stdout;
  return sliceTextByByteRange(combined, range);
}

function sliceTextByByteRange(content, range) {
  let buffer = Buffer.from(String(content ?? ''), 'utf8');
  let start = Math.min(range.start, buffer.length);
  let end = range.hasEnd ? Math.min(range.end, buffer.length) : buffer.length;
  if (range.maxBytes != null)
    end = Math.min(end, start + range.maxBytes);

  return buffer.subarray(start, end).toString('utf8');
}

function grepText(content, pattern, flags, maxMatches) {
  let regex = new RegExp(pattern, normalizeRegexFlags(flags));
  let matches = [];
  let byteOffset = 0;
  let lines = String(content ?? '').split(/\n/g);

  for (let index = 0; index < lines.length; index++) {
    let line = lines[index];
    regex.lastIndex = 0;
    let match = regex.exec(line);
    if (match) {
      matches.push({
        lineNumber: index + 1,
        byteOffset,
        match: match[0],
        line,
      });
      if (matches.length >= maxMatches)
        break;
    }
    byteOffset += Buffer.byteLength(line) + 1;
  }

  return matches;
}

export {
  grepText,
  readCombined,
  readFileRange,
  readWholeFile,
  sliceTextByByteRange,
};
