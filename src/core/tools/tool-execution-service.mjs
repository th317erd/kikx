'use strict';

import { randomUUID } from 'node:crypto';

export class ToolExecutionService {
  constructor(options = {}) {
    this.toolOutputStore = options.toolOutputStore || null;
  }

  async executeTool({ toolName, ToolClass, input = {}, context = {} } = {}) {
    if (typeof toolName !== 'string' || toolName.trim() === '')
      throw new TypeError('toolName must be a non-empty string');

    if (typeof ToolClass !== 'function')
      throw new TypeError(`ToolClass is required for ${toolName}`);

    let normalizedInput = normalizeToolInput(input);
    let executionContext = await createToolExecutionContext(context, normalizedInput);
    let tool = new ToolClass(executionContext);
    if (typeof tool.execute !== 'function')
      throw new TypeError(`${toolName} does not provide execute()`);

    let enrichedInput = enrichToolInput(normalizedInput, executionContext);
    let toolCallFrame = await recordToolCallFrame({ toolName, ToolClass, input: enrichedInput, context: executionContext });
    let toolOutputStore = resolveToolOutputStore(this, executionContext);

    let result;
    try {
      result = await tool.execute(enrichedInput);
    } catch (error) {
      await recordToolErrorFrame({
        toolName,
        ToolClass,
        input: enrichedInput,
        context: executionContext,
        toolCallFrame,
        toolOutputStore,
        error,
      });
      throw error;
    }

    if (!toolOutputStore?.storeToolOutput) {
      await recordToolResultFrame({
        toolName,
        ToolClass,
        input: enrichedInput,
        context: executionContext,
        toolCallFrame,
        agentResult: result,
        status: 'success',
      });
      return result;
    }

    let storedOutput = await toolOutputStore.storeToolOutput({
      toolName,
      ToolClass,
      input: enrichedInput,
      result,
      context: executionContext,
    });

    let agentResult = typeof toolOutputStore.createAgentResult === 'function'
      ? toolOutputStore.createAgentResult(storedOutput)
      : result;

    await recordToolResultFrame({
      toolName,
      ToolClass,
      input: enrichedInput,
      context: executionContext,
      toolCallFrame,
      storedOutput,
      agentResult,
      status: 'success',
    });

    return agentResult;
  }
}

async function createToolExecutionContext(context = {}, input = {}) {
  let baseContext = {
    ...context,
    services: context.services || {},
    permissions: context.permissions,
    fetchImpl: context.fetchImpl || context.services?.fetchImpl,
  };
  let sourceSessionID = normalizeSessionID(context.session?.id || context.frame?.sessionID);
  let targetSessionID = normalizeSessionID(input.session_id || input.sessionID || input._sessionID || sourceSessionID);
  if (!targetSessionID || targetSessionID === sourceSessionID) {
    return {
      ...baseContext,
      toolTargetSessionID: targetSessionID || sourceSessionID || null,
      crossSessionToolCall: false,
    };
  }

  let runtime = resolveFrameRuntime(baseContext);
  if (!runtime?.ensureSessionEntry)
    throw new Error('Cross-session tool calls require frameRuntime.ensureSessionEntry()');

  let entry = await runtime.ensureSessionEntry(targetSessionID);
  if (!entry?.session || !entry?.frameEngine)
    throw new Error(`Unable to open target session for tool call: ${targetSessionID}`);

  return {
    ...baseContext,
    session: entry.session,
    frameEngine: entry.frameEngine,
    sourceSession: context.session || null,
    sourceFrame: context.frame || null,
    sourceResponseFrameID: context.responseFrameID || null,
    toolTargetSessionID: targetSessionID,
    crossSessionToolCall: true,
  };
}

function enrichToolInput(input, context = {}) {
  let targetSessionID = normalizeSessionID(context.toolTargetSessionID || context.session?.id || input?._sessionID);
  let sourceSessionID = normalizeSessionID(context.sourceSession?.id || context.sourceFrame?.sessionID || context.frame?.sessionID);
  return {
    ...input,
    _agentID: context.agent?.id || null,
    _sessionID: targetSessionID || null,
    _sourceSessionID: context.crossSessionToolCall ? sourceSessionID || null : null,
    _frameID: context.frame?.id || null,
  };
}

function normalizeToolInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    return { value: input };

  return input;
}

function resolveToolOutputStore(executor, context = {}) {
  return executor.toolOutputStore
    || context.toolOutputStore
    || context.services?.toolOutputStore
    || resolveContextService(context, 'toolOutputStore');
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

function resolveFrameRuntime(context = {}) {
  return context.services?.frameRuntime || resolveContextService(context, 'frameRuntime');
}

async function recordToolCallFrame({ toolName, ToolClass = null, input, context = {} } = {}) {
  let frameEngine = await resolveFrameEngine(context);
  let sessionID = context.session?.id || input?._sessionID;
  if (!frameEngine || !sessionID)
    return null;

  let now = resolveClock(context)();
  let toolCallID = randomUUID();
  let frame = {
    id: frameEngine.idGenerator?.() || randomUUID(),
    type: resolveToolFrameType(toolName, ToolClass),
    sessionID,
    interactionID: context.frame?.interactionID || context.interactionID || null,
    parentID: resolveToolCallParentID(context),
    authorType: 'agent',
    authorID: context.agent?.id || input?._agentID || null,
    authorDisplayName: context.agent?.name || context.agent?.id || input?._agentID || null,
    timestamp: now,
    createdAt: now,
    updatedAt: now,
    hidden: false,
    deleted: false,
    content: {
      toolName,
      phase: 'call',
      toolCallID,
      status: 'running',
      input: sanitizeVisibleToolInput(input),
      startedAt: now,
      ...crossSessionToolMetadata(context, input),
    },
    state: {
      status: 'running',
    },
  };

  let merged = frameEngine.merge([ frame ], {
    authorType: 'agent',
    authorID: context.agent?.id || input?._agentID || null,
  });
  await flushFrameStore(context);
  return merged[0] || frameEngine.get?.(frame.id) || frame;
}

async function recordToolResultFrame({
  toolName,
  ToolClass = null,
  input,
  context = {},
  toolCallFrame = null,
  storedOutput = null,
  agentResult = null,
  status = 'success',
  error = null,
} = {}) {
  let frameEngine = await resolveFrameEngine(context);
  let sessionID = context.session?.id || input?._sessionID;
  if (!frameEngine || !sessionID)
    return null;

  let now = resolveClock(context)();
  let content = createToolResultContent({
    toolName,
    toolCallFrame,
    input,
    storedOutput,
    agentResult,
    status,
    error,
    finishedAt: now,
    context,
  });
  let frame = {
    id: frameEngine.idGenerator?.() || randomUUID(),
    type: resolveToolFrameType(toolName, ToolClass),
    sessionID,
    interactionID: context.frame?.interactionID || context.interactionID || null,
    parentID: toolCallFrame?.id || context.responseFrameID || context.frame?.id || null,
    authorType: 'tool',
    authorID: toolName,
    authorDisplayName: toolName,
    timestamp: now,
    createdAt: now,
    updatedAt: now,
    hidden: false,
    deleted: false,
    content,
    state: {
      status,
    },
  };

  let merged = frameEngine.merge([ frame ], {
    authorType: 'tool',
    authorID: toolName,
  });
  await flushFrameStore(context);
  return merged[0] || frameEngine.get?.(frame.id) || frame;
}

async function recordToolErrorFrame({ toolName, ToolClass = null, input, context, toolCallFrame, toolOutputStore, error }) {
  let storedOutput = null;
  if (toolOutputStore?.storeToolOutput) {
    try {
      storedOutput = await toolOutputStore.storeToolOutput({
        toolName,
        input,
        result: serializeToolError(error),
        context,
      });
    } catch (_storeError) {
      storedOutput = null;
    }
  }

  await recordToolResultFrame({
    toolName,
    ToolClass,
    input,
    context,
    toolCallFrame,
    storedOutput,
    status: 'error',
    error,
  });
}

async function resolveFrameEngine(context = {}) {
  if (context.frameEngine)
    return context.frameEngine;

  if (context.services?.frameEngine)
    return context.services.frameEngine;

  let sessionID = context.session?.id || context.frame?.sessionID;
  let runtime = context.services?.frameRuntime || resolveContextService(context, 'frameRuntime');
  if (!sessionID || typeof runtime?.ensureSessionEntry !== 'function')
    return null;

  let entry = await runtime.ensureSessionEntry(sessionID);
  return entry?.frameEngine || null;
}

function resolveClock(context = {}) {
  if (typeof context.clock === 'function')
    return context.clock;

  if (typeof context.services?.clock === 'function')
    return context.services.clock;

  return Date.now;
}

async function flushFrameStore(context = {}) {
  await context.services?.frameRuntime?.frameStore?.flush?.();
  await resolveContextService(context, 'frameRuntime')?.frameStore?.flush?.();
}

function createToolResultContent({ toolName, toolCallFrame, input, storedOutput, agentResult, status, error, finishedAt, context = {} }) {
  let metadata = storedOutput?.metadata || {};
  let outputID = storedOutput?.id || agentResult?.toolOutputID || null;
  let sizeBytes = normalizeNonNegativeInteger(storedOutput?.sizeBytes ?? metadata.sizeBytes ?? agentResult?.sizeBytes, 0);
  let preview = typeof metadata.contentPreview === 'string'
    ? metadata.contentPreview
    : previewString(agentResult || serializeToolError(error));

  return {
    toolName,
    phase: 'result',
    toolCallID: toolCallFrame?.content?.toolCallID || null,
    toolCallFrameID: toolCallFrame?.id || null,
    input: sanitizeVisibleToolInput(input),
    toolOutputID: outputID,
    status,
    inline: agentResult?.inline === true,
    stored: Boolean(outputID),
    sizeBytes,
    resultType: metadata.resultType || null,
    format: metadata.format || null,
    preview: truncate(preview, 8192),
    message: status === 'error'
      ? (error?.message || 'Tool execution failed')
      : agentResult?.message || '',
    retrieval: agentResult?.retrieval || metadata.retrieval || null,
    finishedAt,
    ...crossSessionToolMetadata(context, input),
    ...(status === 'error' ? {
      error: serializeToolError(error),
    } : {}),
  };
}

function resolveToolCallParentID(context = {}) {
  if (context.crossSessionToolCall === true)
    return null;

  return context.responseFrameID || context.frame?.id || null;
}

function crossSessionToolMetadata(context = {}, input = {}) {
  if (context.crossSessionToolCall !== true)
    return {};

  return {
    targetSessionID: normalizeSessionID(context.session?.id || input?._sessionID),
    sourceSessionID: normalizeSessionID(context.sourceSession?.id || context.sourceFrame?.sessionID || input?._sourceSessionID),
    sourceFrameID: normalizeSessionID(context.sourceFrame?.id || context.frame?.id || input?._frameID),
    sourceResponseFrameID: normalizeSessionID(context.sourceResponseFrameID || context.responseFrameID),
  };
}

function sanitizeVisibleToolInput(input) {
  return truncateDeep(stripInternalKeys(input), 4000);
}

function stripInternalKeys(value) {
  if (Array.isArray(value))
    return value.map((item) => stripInternalKeys(item));

  if (!value || typeof value !== 'object')
    return value;

  let output = {};
  for (let [key, item] of Object.entries(value)) {
    if (key.startsWith('_'))
      continue;

    if (isSensitiveKey(key)) {
      output[key] = '[redacted]';
      continue;
    }

    output[key] = stripInternalKeys(item);
  }

  return output;
}

function truncateDeep(value, maxChars) {
  let text;
  try {
    text = JSON.stringify(value);
  } catch (_error) {
    text = String(value);
  }

  if (text.length <= maxChars)
    return value;

  return {
    truncated: true,
    preview: `${text.slice(0, maxChars)}...`,
  };
}

function serializeToolError(error) {
  return {
    name: error?.name || 'Error',
    message: error?.message || String(error || 'Tool execution failed'),
    code: error?.code || null,
    status: error?.status || null,
  };
}

function previewString(value) {
  if (typeof value === 'string')
    return value;

  try {
    return JSON.stringify(value, null, 2);
  } catch (_error) {
    return String(value ?? '');
  }
}

function truncate(value, maxLength) {
  let text = String(value ?? '');
  if (text.length <= maxLength)
    return text;

  return `${text.slice(0, maxLength)}...`;
}

function isSensitiveKey(key) {
  return /secret|token|password|api[-_]?key|credential/i.test(key);
}

function normalizeNonNegativeInteger(value, fallback) {
  let number = Number(value);
  if (!Number.isFinite(number) || number < 0)
    return fallback;

  return Math.trunc(number);
}

function normalizeSessionID(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : '';
}

function resolveToolFrameType(toolName, ToolClass) {
  let explicit = typeof ToolClass?.frameType === 'string' ? ToolClass.frameType.trim() : '';
  if (explicit)
    return explicit;

  return `${toolNameToPascal(toolName)}ToolFrame`;
}

function toolNameToPascal(toolName) {
  return String(toolName || 'tool')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join('') || 'Tool';
}
