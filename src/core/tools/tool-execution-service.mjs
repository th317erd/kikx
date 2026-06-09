'use strict';

export class ToolExecutionService {
  async executeTool({ toolName, ToolClass, input = {}, context = {} } = {}) {
    if (typeof toolName !== 'string' || toolName.trim() === '')
      throw new TypeError('toolName must be a non-empty string');

    if (typeof ToolClass !== 'function')
      throw new TypeError(`ToolClass is required for ${toolName}`);

    let tool = new ToolClass(createToolExecutionContext(context));
    if (typeof tool.execute !== 'function')
      throw new TypeError(`${toolName} does not provide execute()`);

    return await tool.execute(enrichToolInput(input, context));
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
