'use strict';

export class ToolExecutionService {
  constructor(options = {}) {
    this.toolOutputStore = options.toolOutputStore || null;
  }

  async executeTool({ toolName, ToolClass, input = {}, context = {} } = {}) {
    if (typeof toolName !== 'string' || toolName.trim() === '')
      throw new TypeError('toolName must be a non-empty string');

    if (typeof ToolClass !== 'function')
      throw new TypeError(`ToolClass is required for ${toolName}`);

    let tool = new ToolClass(createToolExecutionContext(context));
    if (typeof tool.execute !== 'function')
      throw new TypeError(`${toolName} does not provide execute()`);

    let enrichedInput = enrichToolInput(input, context);
    let result = await tool.execute(enrichedInput);
    let toolOutputStore = resolveToolOutputStore(this, context);
    if (!toolOutputStore?.storeToolOutput)
      return result;

    let storedOutput = await toolOutputStore.storeToolOutput({
      toolName,
      input: enrichedInput,
      result,
      context,
    });

    if (typeof toolOutputStore.createAgentResult === 'function')
      return toolOutputStore.createAgentResult(storedOutput);

    return result;
  }
}

function createToolExecutionContext(context = {}) {
  return {
    ...context,
    services: context.services || {},
    permissions: context.permissions,
    fetchImpl: context.fetchImpl || context.services?.fetchImpl,
  };
}

function enrichToolInput(input, context = {}) {
  return {
    ...normalizeToolInput(input),
    _agentID: context.agent?.id || null,
    _sessionID: context.session?.id || null,
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
