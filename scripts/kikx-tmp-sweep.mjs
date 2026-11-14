'use strict';

// Stale test-scratch sweeper — see spec/scripts/kikx-tmp-sweep-spec.mjs.
//
// Dozens of specs mkdtemp into /tmp without teardown; 14,400+ orphaned
// kikx-* fixture dirs accumulated across runs and sessions. The lane runner
// calls this ONCE per invocation. Two gates keep it safe for everyone:
//   - NAME: mkdtemp's exact shape — ^kikx-.+-[A-Za-z0-9]{6}$ (fixed names
//     like kikx-arms-854e and foreign prefixes never match).
//   - AGE: older than 6 hours (default) — a concurrent run's fresh dirs
//     (this host or any other bot's) are never candidates.
// Returns the basenames removed (for logging/tests).

import { readdirSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const MKDMTMP_SHAPE = /^kikx-.+-[A-Za-z0-9]{6}$/;
const DEFAULT_MAX_AGE_SECONDS = 6 * 3600;

export function sweepStaleKikxScratch({ root = tmpdir(), now = Date.now() / 1000, maxAgeSeconds = DEFAULT_MAX_AGE_SECONDS } = {}) {
  const removed = [];
  let entries;
  try {
    entries = readdirSync(root);
  } catch (_error) {
    return removed;
  }

  for (const name of entries) {
    if (!MKDMTMP_SHAPE.test(name))
      continue;

    const target = path.join(root, name);
    try {
      const info = statSync(target);
      if (!info.isDirectory())
        continue;
      if (now - info.mtimeMs / 1000 < maxAgeSeconds)
        continue;
      rmSync(target, { recursive: true, force: true });
      removed.push(name);
    } catch (_error) {
      // A dir racing away (another sweeper, a cleanup) is fine — skip it.
    }
  }

  return removed;
}

// Lane-runner entry: one sweep per invocation, real tmpdir, default gate.
export function sweepOnce() {
  const removed = sweepStaleKikxScratch();
  if (removed.length > 0)
    console.log(`[tmp-sweep] removed ${removed.length} stale kikx scratch dir(s)`);
  return removed;
}
