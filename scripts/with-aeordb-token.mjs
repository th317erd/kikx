#!/usr/bin/env node
'use strict';

// Preflight for UI test runs: exchange the AeorDB root key for a JWT exactly
// once, then exec the given command with AEORDB_TOKEN set. AeorDB rate-limits
// auth-token exchanges (30/60s) and JWTs are valid for days, so exchanging per
// test process (Node runs one process per test file) is both wasteful and the
// cause of AeorDB 429s under parallel UI runs.
//
// Usage: node scripts/with-aeordb-token.mjs <command> [args...]

import { spawn } from 'node:child_process';

import { loadEnvFile } from '../src/core/config/env-loader.mjs';

await loadEnvFile(process.env.KIKX_ENV_FILE || '.env.dev');

let args = process.argv.slice(2);
if (args.length === 0) {
  console.error('Usage: node scripts/with-aeordb-token.mjs <command> [args...]');
  process.exit(2);
}

let token = process.env.AEORDB_TOKEN || '';

if (!token) {
  let baseURL = (process.env.AEORDB_URL || 'http://127.0.0.1:6830').replace(/\/+$/g, '');
  let rootKey = process.env.AEORDB_ROOT_KEY || '';

  if (!rootKey) {
    console.error('with-aeordb-token: AEORDB_ROOT_KEY (or AEORDB_TOKEN) is required');
    process.exit(2);
  }

  let response;
  try {
    response = await fetch(`${baseURL}/auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: rootKey }),
    });
  } catch (error) {
    console.error(`with-aeordb-token: unable to reach AeorDB at ${baseURL}: ${error.message}`);
    process.exit(2);
  }

  let body = await response.json().catch(() => ({}));
  if (!response.ok || !body.token) {
    console.error(`with-aeordb-token: AeorDB token exchange failed (HTTP ${response.status}): ${body?.error || body?.message || 'no token'}`);
    process.exit(2);
  }

  token = body.token;
}

let child = spawn(args[0], args.slice(1), {
  stdio: 'inherit',
  env: {
    ...process.env,
    AEORDB_TOKEN: token,
  },
});

for (let signal of [ 'SIGINT', 'SIGTERM' ])
  process.on(signal, () => child.kill(signal));

child.on('exit', (code, signal) => {
  if (signal)
    process.kill(process.pid, signal);
  else
    process.exit(code ?? 0);
});
