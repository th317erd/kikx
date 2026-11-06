'use strict';

// Test-run environment (campaign S4): the PRODUCTION default is fail-closed
// `required` (plan §5-S4), but the development default — and therefore the
// default every pre-existing loader-driven spec runs under — is `unsafe`,
// mirroring .env.dev. Specs that exercise the gate inject their own config
// context and are unaffected by this fallback; this file only stops twelve
// unrelated lifecycle specs from each having to restate the dev mode.
//
// Setting the value ONLY when unset keeps an explicit mode (CI matrix, a
// future required-in-CI run) authoritative.
if (!process.env.KIKX_PLUGIN_SIGNATURE_MODE)
  process.env.KIKX_PLUGIN_SIGNATURE_MODE = 'unsafe';
