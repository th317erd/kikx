'use strict';

// Load vendor/component modules that are nice-to-have rather than essential.
// A missing asset (for example a vendored component that was not shipped to
// production) must never reject the module graph and brick the whole client;
// each import is attempted independently and every failure is reported.

function messageFor(error) {
  if (error && typeof error.message === 'string' && error.message)
    return error.message;
  return String(error);
}

function reportFailure(onError, failure, error) {
  if (typeof onError !== 'function')
    return;
  try {
    onError({ url: failure.url, error });
  } catch (_ignored) {
    // A throwing onError callback must never abort the remaining imports.
  }
}

export async function loadOptionalModules(urls, options = {}) {
  let importModule = options.importModule || ((url) => import(url));
  let onError = options.onError;
  let failures = [];

  if (!urls || typeof urls[Symbol.iterator] !== 'function')
    return failures;

  for (let url of urls) {
    try {
      await importModule(url);
    } catch (error) {
      let failure = { url, message: messageFor(error) };
      failures.push(failure);
      reportFailure(onError, failure, error);
    }
  }

  return failures;
}

export function formatOptionalLoadFailure({ url, message }) {
  return `Optional module failed to load: ${url} — ${message}`;
}
