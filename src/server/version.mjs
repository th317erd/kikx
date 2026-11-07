'use strict';

// =============================================================================
// Instance version identity (owner task, 2026-11-07) — GET /health carries it
// =============================================================================
// One string per boot so the owner can tell many Kikx instances apart:
//   KIKX_VERSION (operator-set, wins) > git short hash (+dirty) > 'unknown'.
//
// Memoized because /health is a probe that must not shell out per request.
// Ambient env reads go through snapshotEnvironment (the no-process-env gate
// keeps raw process.env inside core/config), and the exec seam is injectable
// so spec/server/server-version-spec.mjs tests the rules without a git binary.

import { execFileSync } from 'node:child_process';

import { snapshotEnvironment } from '../core/config/env-loader.mjs';

let memo = null;

function defaultExec(command, args) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: [ 'ignore', 'pipe', 'ignore' ],
    timeout: 2000,
  }).trim();
}

export function resolveKikxVersion(options = {}) {
  if (memo !== null && options.force !== true)
    return memo;

  const exec = typeof options.exec === 'function' ? options.exec : defaultExec;
  const env = options.env || snapshotEnvironment();
  const override = typeof env.KIKX_VERSION === 'string' && env.KIKX_VERSION.trim() !== ''
    ? env.KIKX_VERSION.trim()
    : '';

  if (override) {
    memo = override;
    return memo;
  }

  try {
    const hash = exec('git', [ 'rev-parse', '--short=8', 'HEAD' ]);
    if (typeof hash === 'string' && hash !== '') {
      let dirty = false;
      try {
        dirty = exec('git', [ 'status', '--porcelain' ]) !== '';
      } catch {
        dirty = false;
      }
      memo = dirty ? `${hash}+dirty` : hash;
      return memo;
    }
  } catch {
    // No git (containers, tarball deploys): fall through.
  }

  memo = 'unknown';
  return memo;
}

// Tests only: force a fresh resolution after changing the injected seams.
export function resetKikxVersionForTests() {
  memo = null;
}
