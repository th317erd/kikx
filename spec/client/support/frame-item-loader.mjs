'use strict';

// Node module-resolution hook that redirects the browser-only
// `/vendor/aeor-web-components/*` imports used by src/client/lib/aeor-ui.mjs to
// local jsdom-free stand-ins. Register it before dynamically importing a client
// component that reaches aeor-ui.
//
// This installs a process-global `module.register` hook and mutates globalThis
// (via installDom). It relies on `node --test`'s default per-file process
// isolation: each spec file gets its own process, so the hook cannot leak into
// unrelated specs. Do not run this spec together with `--test-isolation=none`,
// because the global DOM/hook would then be shared across all spec files.

const VENDOR_PREFIX = '/vendor/aeor-web-components/';

const SHIMS = new Map([
  [ 'elements.js', './vendor-elements.mjs' ],
  [ 'query.js', './vendor-query.mjs' ],
  [ 'reactive-state.js', './vendor-reactive-state.mjs' ],
]);

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith(VENDOR_PREFIX)) {
    let rest = specifier.slice(VENDOR_PREFIX.length);
    let target = SHIMS.get(rest) || './vendor-empty.mjs';
    return {
      url: new URL(target, import.meta.url).href,
      shortCircuit: true,
    };
  }

  return nextResolve(specifier, context);
}
