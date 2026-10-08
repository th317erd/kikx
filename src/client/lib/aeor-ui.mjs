'use strict';

import { loadOptionalModules } from './optional-import.mjs';

// The element helpers and query bridge are essential; a failure here is a real
// boot failure. Keep them as hard re-exports.
export { elements } from '/vendor/aeor-web-components/elements.js';
export { ReactiveState } from '/vendor/aeor-web-components/reactive-state.js';
export { $ } from '/vendor/aeor-web-components/query.js';

// Component definitions are optional: if a vendored component is missing the
// app must still boot and render (the session card falls back to plain
// buttons). Load them independently and record any failures for diagnostics.
//
// Every URL below must exist in the vendor tree staged by kikx-docker's
// deploy.sh, which archives *committed* refs. In dev the server reads the live
// checkout, so an uncommitted component works locally and is missing in prod.
// See kikx-docker/README.md "Vendor components (aeor-web-components)".
const OPTIONAL_COMPONENT_URLS = [
  '/vendor/aeor-web-components/components/aeor-input.js',
  '/vendor/aeor-web-components/components/aeor-modal.js',
  '/vendor/aeor-web-components/components/aeor-select.js',
  '/vendor/aeor-web-components/components/aeor-checkbox.js',
  '/vendor/aeor-web-components/components/aeor-confirm-button.js',
  '/vendor/aeor-web-components/components/aeor-progress-button.js',
];

const optionalComponentFailures = await loadOptionalModules(OPTIONAL_COMPONENT_URLS, {
  onError: ({ url, error }) => {
    console.warn(`[aeor-ui] Optional component failed to load: ${url}`, error);
  },
});

export function optionalComponentLoadFailures() {
  return optionalComponentFailures.map((failure) => ({ ...failure }));
}
