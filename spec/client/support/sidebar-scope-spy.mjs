'use strict';

// A pass-through shim over `kikx-sidebar-session-objects.mjs` whose only job is
// to RECORD what `buildRunnerShell` hands the seam.
//
// Why this exists: with the descriptors as they are, every non-chip row carries
// the viewed session's own id, so a correct scope filter grants all of them and
// the rendered sidebar is byte-identical to the unfiltered one. A test that
// compares rendered output therefore CANNOT tell a wired seam from a dead one --
// which is exactly why the dead seam survived two days of green suites.
//
// So the question is not "did the output change" (it provably cannot) but "did
// the shell hand the seam a predicate at all". That is only observable at the
// module boundary, which is what this shim provides. Nothing here re-implements
// the seam: every call is forwarded to the real module, unchanged.

import * as real from '../../../src/client/components/kikx-sidebar-session-objects.mjs';

/**
 * One entry per `buildSidebarSessionObjects` call the shell makes.
 * `scopeFilter` is null when the caller passed nothing -- the dead-seam state.
 */
export const seamCalls = [];

export function resetSeamCalls() {
  seamCalls.length = 0;
}

export function buildSidebarSessionObjects(app, options = {}) {
  seamCalls.push({
    group: options.group ?? null,
    scopeFilter: typeof options.scopeFilter === 'function' ? options.scopeFilter : null,
  });

  return real.buildSidebarSessionObjects(app, options);
}

export const SESSION_OBJECT_GROUPS = real.SESSION_OBJECT_GROUPS;
export const GLOBAL_SESSION_OBJECT_IDS = real.GLOBAL_SESSION_OBJECT_IDS;
export const buildSessionObjectItems = real.buildSessionObjectItems;
export const filterSessionObjectItems = real.filterSessionObjectItems;
export const sidebarScopePredicateFor = real.sidebarScopePredicateFor;
