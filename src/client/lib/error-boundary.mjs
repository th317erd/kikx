'use strict';

// S1 error containment. One bad render must never wedge the app, and a dead UI
// must never be silent.
//
// `guardClientOperation(label, operation, context)` runs a render/update
// operation inside a try/catch. It never throws and never returns a rejected
// promise (await-safe): a rejected async operation still resolves to
// `undefined`. On failure it records the error exactly once in a bounded ring
// buffer and fans it out to subscribers, defensively -- a throwing console or
// subscriber can never break the boundary or the caller.
//
// `listRecentErrors()`/`subscribeToRecentErrors()` expose the store to the UI.
// `installGlobalErrorCapture`/`uninstallGlobalErrorCapture` wire the store to
// `window.onerror` and `unhandledrejection` and tear them down again.

export const RECENT_ERROR_LIMIT = 20;
// A renderer that throws a fresh Error on every event would otherwise churn the
// bounded ring and log without bound. Identical (label + message) failures
// inside this window are counted on the existing entry instead of reported
// again.
export const REPEAT_SUPPRESSION_MS = 1000;
const REPORTED_KEY_LIMIT = 100;

const recentErrors = [];
const subscribers = new Set();
// Re-reporting the exact same Error object (an inner boundary that rethrows, a
// re-dispatched event) must not push a second entry while that entry is still in
// the ring.
const reportedErrors = new WeakMap();
// `label + message` -> { entry, at }: the bounded repeat-flood throttle.
const lastReportedByKey = new Map();

function defaultHost() {
  return typeof window !== 'undefined' ? window : globalThis;
}

function normalizeError(error) {
  if (error instanceof Error)
    return error;
  return new Error(typeof error === 'string' ? error : String(error));
}

function notify(entry) {
  try {
    console.error(`[kikx] ${entry.label}: ${entry.message}`, entry.context);
  } catch (_error) {
    // A broken console must not take down the boundary.
  }

  for (let subscriber of [ ...subscribers ]) {
    try {
      subscriber(entry);
    } catch (_error) {
      // A broken surface must not stop the others or break the caller.
    }
  }
}

// Record one failure and return its stored entry. Repeated calls with the same
// Error object return the original entry without re-reporting -- unless that
// entry has since been dismissed or evicted, in which case it is recorded again.
// Repeated calls with a new Error but the same label+message inside the throttle
// window are counted on the existing entry instead of flooding the ring.
export function reportClientError(label, error, context = {}) {
  let normalized = normalizeError(error);
  let existing = reportedErrors.get(normalized);
  if (existing && recentErrors.includes(existing))
    return existing;

  let labelText = String(label ?? 'unknown');
  let message = String(normalized.message ?? '');
  let now = Date.now();
  let key = `${labelText}\u0000${message}`;
  let throttled = lastReportedByKey.get(key);
  if (throttled && recentErrors.includes(throttled.entry) && now - throttled.at < REPEAT_SUPPRESSION_MS) {
    // The failure is already on screen: count it there, but do not push a new
    // entry or log again. This keeps both the ring and the console bounded while
    // the occurrence is still recorded.
    throttled.entry.count += 1;
    throttled.entry.at = now;
    reportedErrors.set(normalized, throttled.entry);
    return throttled.entry;
  }

  let entry = {
    at: now,
    count: 1,
    label: labelText,
    message,
    stack: typeof normalized.stack === 'string' ? normalized.stack : '',
    context: context && typeof context === 'object' && !Array.isArray(context) ? { ...context } : {},
  };

  reportedErrors.set(normalized, entry);
  recentErrors.push(entry);
  while (recentErrors.length > RECENT_ERROR_LIMIT)
    recentErrors.shift();

  lastReportedByKey.set(key, { entry, at: now });
  while (lastReportedByKey.size > REPORTED_KEY_LIMIT) {
    let oldestKey = lastReportedByKey.keys().next().value;
    lastReportedByKey.delete(oldestKey);
  }

  notify(entry);
  return entry;
}

// Run `operation`, containing any throw. Returns the operation's value on
// success, or `undefined` after reporting a failure. When `operation` returns a
// thenable the returned promise always resolves (never rejects).
export function guardClientOperation(label, operation, context = {}) {
  if (typeof operation !== 'function') {
    reportClientError(label, new TypeError('guardClientOperation requires a function'), context);
    return undefined;
  }

  let result;
  try {
    result = operation();
  } catch (error) {
    reportClientError(label, error, context);
    return undefined;
  }

  if (result && typeof result.then === 'function') {
    return Promise.resolve(result).catch((error) => {
      reportClientError(label, error, context);
      return undefined;
    });
  }

  return result;
}

export function listRecentErrors() {
  return recentErrors.slice();
}

export function subscribeToRecentErrors(listener) {
  if (typeof listener !== 'function')
    return () => {};

  subscribers.add(listener);
  return () => {
    subscribers.delete(listener);
  };
}

export function clearRecentErrors() {
  recentErrors.length = 0;
}

// Install global capture on `host`, storing teardown state on `app` so
// disconnect removes exactly these handlers and restores the previous
// `onerror`. Idempotent per app.
export function installGlobalErrorCapture(app, host = defaultHost()) {
  if (!app || app._errorCapture || !host || typeof host.addEventListener !== 'function')
    return;

  let state = {
    host,
    previousOnError: host.onerror ?? null,
    onError: (message, source, lineno, colno, error) => {
      reportClientError('window.onerror', error ?? message, { source, lineno, colno });
      // The boundary already logged it; suppress the browser's duplicate.
      return true;
    },
    onRejection: (event) => {
      reportClientError('unhandledrejection', event?.reason, {});
      // The boundary already logged it; suppress the browser's duplicate.
      event?.preventDefault?.();
    },
  };

  host.onerror = state.onError;
  host.addEventListener('unhandledrejection', state.onRejection);
  app._errorCapture = state;
}

export function uninstallGlobalErrorCapture(app) {
  let state = app?._errorCapture;
  if (!state)
    return;

  state.host.onerror = state.previousOnError;
  state.host.removeEventListener('unhandledrejection', state.onRejection);
  app._errorCapture = null;
}
