'use strict';

// Shared resolution of the injectable browser service used by web tools
// (web-fetch, web-search). The service exposes `withPage(callback)`; core
// provides a PuppeteerBrowserService that connects to a headed Chrome over CDP.

export function resolveBrowserService(context = {}) {
  let service = context.webBrowser
    || context.services?.webBrowser
    || resolveContextService(context, 'webBrowser');

  return service?.withPage ? service : null;
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
