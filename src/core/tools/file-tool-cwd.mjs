'use strict';

export async function resolveFileToolParams(params = {}, context = {}) {
  if (params.cwd != null && params.cwd !== '')
    return params;

  let cwdStore = resolveAgentCwdStore(context);
  let agentID = normalizeOptionalString(context.agent?.id || params._agentID);
  let sessionID = normalizeOptionalString(params._sessionID || context.session?.id || context.frame?.sessionID);
  if (!cwdStore?.getCWD || !agentID || !sessionID)
    return params;

  let state = await cwdStore.getCWD(agentID, sessionID);
  if (!state?.cwd)
    return params;

  return {
    ...params,
    cwd: state.cwd,
  };
}

export function resolveContextService(context, name) {
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

function resolveAgentCwdStore(context = {}) {
  return context.agentCwdStore || context.services?.agentCwdStore || resolveContextService(context, 'agentCwdStore');
}

function normalizeOptionalString(value) {
  if (value == null)
    return '';

  return String(value).trim();
}
