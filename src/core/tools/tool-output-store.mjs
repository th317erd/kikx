'use strict';

import { randomBytes } from 'node:crypto';

export const DEFAULT_TOOL_OUTPUT_ROOT = '/kikx/tool-outputs';
export const DEFAULT_TOOL_OUTPUT_INLINE_LIMIT_BYTES = 192 * 1024;
export const DEFAULT_TOOL_OUTPUT_READ_BYTES = 128 * 1024;
export const TOOL_OUTPUT_GET_TOOL_NAME = 'tool-output-get';

export class ToolOutputStore {
  constructor(options = {}) {
    let {
      aeordb,
      rootPath = DEFAULT_TOOL_OUTPUT_ROOT,
      inlineLimitBytes = DEFAULT_TOOL_OUTPUT_INLINE_LIMIT_BYTES,
      defaultReadBytes = DEFAULT_TOOL_OUTPUT_READ_BYTES,
      clock = () => new Date().toISOString(),
      idGenerator = createToolOutputID,
    } = options;

    if (!aeordb)
      throw new TypeError('ToolOutputStore requires an aeordb client');

    this.aeordb = aeordb;
    this.rootPath = normalizeRootPath(rootPath);
    this.inlineLimitBytes = normalizePositiveInteger(inlineLimitBytes, 'inlineLimitBytes');
    this.defaultReadBytes = normalizePositiveInteger(defaultReadBytes, 'defaultReadBytes');
    this.clock = clock;
    this.idGenerator = idGenerator;
    this._indexesReady = false;
  }

  async storeToolOutput({ toolName, input = {}, result, context = {} } = {}) {
    let normalizedToolName = normalizeRequiredString(toolName, 'toolName');
    let id = normalizeToolOutputID(this.idGenerator());
    let now = normalizeTimestamp(this.clock());
    let paths = this.pathsFor(id);
    let formatted = formatToolOutputContent(result);
    let sizeBytes = byteLength(formatted.content);
    let metadata = {
      id,
      toolName: normalizedToolName,
      agentID: context.agent?.id || input?._agentID || null,
      sessionID: context.session?.id || input?._sessionID || null,
      frameID: context.frame?.id || input?._frameID || null,
      createdAt: now,
      updatedAt: now,
      format: formatted.format,
      resultType: formatted.resultType,
      sizeBytes,
      contentPath: paths.contentPath,
      metadataPath: paths.metadataPath,
      input: sanitizeToolInput(input),
      contentPreview: formatted.content.slice(0, 8192),
      retrieval: this.createRetrievalInstructions(id, sizeBytes),
    };

    if (formatted.serializationWarning)
      metadata.serializationWarning = formatted.serializationWarning;

    await this.ensureIndexConfig();
    await this.aeordb.putFile(paths.contentPath, formatted.content, {
      contentType: 'text/plain; charset=utf-8',
    });
    await this.aeordb.putFile(paths.metadataPath, metadata);

    return {
      id,
      toolName: normalizedToolName,
      result,
      metadata,
      paths,
      sizeBytes,
    };
  }

  async getToolOutput({ id, start, end, maxBytes } = {}) {
    let normalizedID = normalizeToolOutputID(id);
    let metadata = await this.readMetadata(normalizedID);
    let range = normalizeReadRange({
      start,
      end,
      maxBytes,
      defaultReadBytes: null,
      sizeBytes: metadata.sizeBytes,
    });
    let content = await this.readContentRange(metadata.contentPath, range);
    let returnedBytes = byteLength(content);
    let contentEnd = Math.min(metadata.sizeBytes, range.start + returnedBytes);

    return {
      id: metadata.id,
      toolName: metadata.toolName,
      format: metadata.format,
      sizeBytes: metadata.sizeBytes,
      start: range.start,
      end: contentEnd,
      returnedBytes,
      truncated: contentEnd < metadata.sizeBytes,
      content,
      metadata: {
        agentID: metadata.agentID,
        sessionID: metadata.sessionID,
        frameID: metadata.frameID,
        createdAt: metadata.createdAt,
        updatedAt: metadata.updatedAt,
        contentPath: metadata.contentPath,
        metadataPath: metadata.metadataPath,
      },
    };
  }

  async readMetadata(id) {
    let metadata = await this.aeordb.getFile(this.pathsFor(id).metadataPath);
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))
      throw new Error(`tool output metadata is invalid for ${id}`);

    return metadata;
  }

  async readContentRange(contentPath, range) {
    let headers = {};
    if (range.hasRange)
      headers.Range = `bytes=${range.start}-${range.end - 1}`;

    let content = await this.aeordb.getFile(contentPath, {
      expectJSON: false,
      headers,
    });

    content = String(content ?? '');
    if (!range.hasRange)
      return content;

    let returnedBytes = byteLength(content);
    let requestedBytes = range.end - range.start;
    if (returnedBytes <= requestedBytes)
      return content;

    return Buffer.from(content, 'utf8')
      .subarray(range.start, range.end)
      .toString('utf8');
  }

  async searchToolOutputs({ query, limit = 20, offset = 0 } = {}) {
    let normalizedQuery = normalizeRequiredString(query, 'query');
    await this.ensureIndexConfig();
    return await this.aeordb.searchFiles({
      path: this.rootPath,
      query: normalizedQuery,
      limit: clampInteger(limit, 20, 1, 100),
      offset: clampInteger(offset, 0, 0, Number.MAX_SAFE_INTEGER),
    });
  }

  createAgentResult(storedOutput) {
    let retrieval = this.createRetrievalInstructions(storedOutput.id, storedOutput.sizeBytes);
    let inline = {
      type: 'ToolOutput',
      toolName: storedOutput.toolName,
      toolOutputID: storedOutput.id,
      stored: true,
      inline: true,
      sizeBytes: storedOutput.sizeBytes,
      retrieval,
      result: storedOutput.result,
    };

    if (byteLength(stableStringify(inline)) <= this.inlineLimitBytes)
      return inline;

    return {
      type: 'ToolOutputPointer',
      toolName: storedOutput.toolName,
      toolOutputID: storedOutput.id,
      stored: true,
      inline: false,
      sizeBytes: storedOutput.sizeBytes,
      inlineLimitBytes: this.inlineLimitBytes,
      message: this.createPointerMessage(storedOutput.id, storedOutput.sizeBytes),
      retrieval,
    };
  }

  createPointerMessage(id, sizeBytes) {
    let firstEnd = Math.min(sizeBytes, this.defaultReadBytes);
    return [
      `The tool call output was too large to include inline (${sizeBytes} bytes; inline limit ${this.inlineLimitBytes} bytes).`,
      `The full output was stored in AeorDB with tool output ID ${id}.`,
      `To read the first chunk, call ${TOOL_OUTPUT_GET_TOOL_NAME} with {"id":"${id}","start":0,"end":${firstEnd}}.`,
      `To request a different byte range, call ${TOOL_OUTPUT_GET_TOOL_NAME} with {"id":"${id}","start":<inclusive_byte_offset>,"end":<exclusive_byte_offset>}.`,
      `To attempt the full output, call ${TOOL_OUTPUT_GET_TOOL_NAME} with {"id":"${id}","full":true}.`,
    ].join(' ');
  }

  createRetrievalInstructions(id, sizeBytes) {
    let firstEnd = Math.min(sizeBytes, this.defaultReadBytes);
    return {
      getTool: TOOL_OUTPUT_GET_TOOL_NAME,
      getAll: {
        tool: TOOL_OUTPUT_GET_TOOL_NAME,
        arguments: { id, full: true },
      },
      getRange: {
        tool: TOOL_OUTPUT_GET_TOOL_NAME,
        arguments: { id, start: 0, end: firstEnd },
      },
      rangeSemantics: 'start is inclusive, end is exclusive, both are byte offsets in the stored serialized tool output.',
    };
  }

  async ensureIndexConfig() {
    if (this._indexesReady)
      return;

    await this.aeordb.putFile(`${this.rootPath}/.aeordb-config/indexes.json`, {
      glob: '*/metadata.json',
      indexes: [
        { name: 'id', type: 'string' },
        { name: 'toolName', type: [ 'string', 'trigram' ] },
        { name: 'agentID', type: 'string' },
        { name: 'sessionID', type: 'string' },
        { name: 'frameID', type: 'string' },
        { name: 'createdAt', type: 'timestamp' },
        { name: 'updatedAt', type: 'timestamp' },
        { name: 'format', type: 'string' },
        { name: 'sizeBytes', type: 'u64' },
        { name: 'contentPreview', type: [ 'string', 'trigram' ] },
      ],
    });
    this._indexesReady = true;
  }

  pathsFor(id) {
    let encodedID = encodeSegment(normalizeToolOutputID(id));
    return {
      metadataPath: `${this.rootPath}/${encodedID}/metadata.json`,
      contentPath: `${this.rootPath}/${encodedID}/result.txt`,
    };
  }
}

function formatToolOutputContent(result) {
  if (typeof result === 'string') {
    return {
      content: result,
      format: 'text',
      resultType: 'string',
    };
  }

  try {
    return {
      content: JSON.stringify(result, null, 2),
      format: 'json',
      resultType: result === null ? 'null' : Array.isArray(result) ? 'array' : typeof result,
    };
  } catch (error) {
    return {
      content: String(result),
      format: 'text',
      resultType: typeof result,
      serializationWarning: error.message,
    };
  }
}

function normalizeReadRange({ start, end, maxBytes, defaultReadBytes, sizeBytes }) {
  let normalizedStart = normalizeNonNegativeInteger(start, 0);
  let normalizedEnd = end == null ? null : normalizePositiveInteger(end, 'end');
  let normalizedMaxBytes = maxBytes == null && defaultReadBytes == null
    ? null
    : normalizePositiveInteger(maxBytes ?? defaultReadBytes, 'maxBytes');
  let outputSize = normalizeNonNegativeInteger(sizeBytes, 0);

  if (normalizedStart > outputSize)
    normalizedStart = outputSize;

  if (normalizedEnd != null && normalizedEnd < normalizedStart)
    throw new TypeError('end must be greater than or equal to start');

  if (normalizedMaxBytes != null) {
    let maxEnd = normalizedStart + normalizedMaxBytes;
    normalizedEnd = normalizedEnd == null ? maxEnd : Math.min(normalizedEnd, maxEnd);
  }

  if (normalizedEnd == null)
    normalizedEnd = outputSize;

  normalizedEnd = Math.min(outputSize, normalizedEnd);

  return {
    start: normalizedStart,
    end: normalizedEnd,
    hasRange: normalizedStart > 0 || normalizedEnd < outputSize,
  };
}

function sanitizeToolInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    return input ?? null;

  let output = {};
  for (let [key, value] of Object.entries(input)) {
    if (key.startsWith('_'))
      continue;

    output[key] = value;
  }

  return output;
}

function stableStringify(value) {
  try {
    return JSON.stringify(value);
  } catch (_error) {
    return String(value);
  }
}

function createToolOutputID() {
  return randomBytes(8).toString('hex').toUpperCase();
}

function normalizeToolOutputID(value) {
  let normalized = normalizeRequiredString(value, 'tool output id');
  if (!/^[A-Za-z0-9_-]+$/.test(normalized))
    throw new TypeError('tool output id may only contain letters, numbers, underscores, and hyphens');

  return normalized;
}

function normalizeRootPath(value) {
  let path = normalizeRequiredString(value, 'rootPath').replace(/\/+$/g, '');
  return path.startsWith('/') ? path : `/${path}`;
}

function normalizeTimestamp(value) {
  if (typeof value === 'string' && value.trim() !== '')
    return value;

  if (typeof value === 'number' && Number.isFinite(value))
    return new Date(value).toISOString();

  return new Date().toISOString();
}

function normalizeRequiredString(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '')
    throw new TypeError(`${fieldName} must be a non-empty string`);

  return value.trim();
}

function normalizePositiveInteger(value, fieldName) {
  let number = Number(value);
  if (!Number.isFinite(number) || number <= 0)
    throw new TypeError(`${fieldName} must be a positive integer`);

  return Math.trunc(number);
}

function normalizeNonNegativeInteger(value, defaultValue) {
  let number = Number(value);
  if (!Number.isFinite(number) || number < 0)
    return defaultValue;

  return Math.trunc(number);
}

function clampInteger(value, defaultValue, min, max) {
  let number = Number(value);
  if (!Number.isFinite(number))
    number = defaultValue;

  number = Math.trunc(number);
  return Math.min(max, Math.max(min, number));
}

function byteLength(value) {
  return Buffer.byteLength(String(value ?? ''), 'utf8');
}

function encodeSegment(value) {
  return encodeURIComponent(value);
}
