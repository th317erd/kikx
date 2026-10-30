'use strict';

// Redirect every import of the sidebar-seam module to the recording shim, except
// the shim's own import of the real module (which must reach the original or the
// redirection would recurse forever).

const TARGET = 'kikx-sidebar-session-objects.mjs';
const SHIM = new URL('./sidebar-scope-spy.mjs', import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith(TARGET) && !String(context.parentURL || '').includes('sidebar-scope-spy'))
    return { url: SHIM, shortCircuit: true };

  return nextResolve(specifier, context);
}
