'use strict';

// History API router for Hero V2.
// Clean URLs, route matching with params, auth guard, navigation events.

let routes                = [];
let currentRoute          = null;
let currentParams         = {};
let listeners             = [];
let authCheckFunction     = null;
let unauthorizedRedirect  = '/hero/login';

export function defineRoute(path, name, options = {}) {
  routes.push({ path, name, pattern: compilePattern(path), ...options });
}

export function setAuthCheck(checkFunction) {
  authCheckFunction = checkFunction;
}

export function setUnauthorizedRedirect(path) {
  unauthorizedRedirect = path;
}

function compilePattern(path) {
  let paramNames  = [];
  let regexString = path.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (match, paramName) => {
    paramNames.push(paramName);
    return '([^/]+)';
  });

  return { regex: new RegExp('^' + regexString + '$'), paramNames };
}

function matchRoute(pathname) {
  for (let route of routes) {
    let match = pathname.match(route.pattern.regex);
    if (!match)
      continue;

    let params = {};
    route.pattern.paramNames.forEach((name, index) => {
      params[name] = match[index + 1];
    });

    return { route, params };
  }

  return null;
}

export function navigate(path, options = {}) {
  if (options.replace)
    window.history.replaceState(null, '', path);
  else
    window.history.pushState(null, '', path);

  resolve();
}

export function resolve() {
  let pathname = window.location.pathname;
  let matched  = matchRoute(pathname);

  if (!matched) {
    currentRoute  = null;
    currentParams = {};
    notifyListeners();
    return;
  }

  if (matched.route.requiresAuthentication && typeof authCheckFunction === 'function') {
    if (!authCheckFunction()) {
      navigate(unauthorizedRedirect, { replace: true });
      return;
    }
  }

  currentRoute  = matched.route;
  currentParams = matched.params;
  notifyListeners();
}

export function onRouteChange(callback) {
  listeners.push(callback);

  return () => {
    let index = listeners.indexOf(callback);
    if (index >= 0)
      listeners.splice(index, 1);
  };
}

function notifyListeners() {
  for (let listener of listeners)
    listener({ route: currentRoute, params: currentParams });
}

export function getCurrentRoute() {
  return { route: currentRoute, params: currentParams };
}

export function getParams() {
  return { ...currentParams };
}

function onPopState() {
  resolve();
}

export function start() {
  window.addEventListener('popstate', onPopState);
  resolve();
}

export function stop() {
  window.removeEventListener('popstate', onPopState);
}

// Resets all router state. Intended for use in tests only.
export function reset() {
  routes               = [];
  currentRoute         = null;
  currentParams        = {};
  listeners            = [];
  authCheckFunction    = null;
  unauthorizedRedirect = '/hero/login';
}
