'use strict';

// =============================================================================
// Which view names are addressable right now
// =============================================================================
// A leaf module on purpose: it imports nothing.
//
// Both `navigation-stack.mjs` and `client-view-surfaces.mjs` need the same answer
// to "may the stack hold this view name?", and the naive arrangement is a cycle --
// view-surfaces imports the view builders, which import state, which imports
// navigation-stack. Keeping the vocabulary here means one definition, no cycle,
// and no second copy to drift.
//
// Campaign P4 requires a plugin view to render with no core shell edit, so the
// name set cannot be a frozen literal in the stack. It is written by the single
// place that already learns the descriptors (`setClientComponents`), which also
// makes removal work: uninstalling a plugin shrinks the set again, so the stack
// cannot hold a view nothing renders.
//
// Why a module-level "current" set rather than threading `state` into every stack
// helper: `pushView`/`normalizeNavigationStack`/`isViewEntry` are called from many
// places without a state argument, and a wrong/omitted argument would silently
// fall back to the core-only vocabulary -- reintroducing the exact bug. One writer
// (`syncViewNames`) keeps the answer honest for every reader.

// The surfaces core still owns. This is both the fallback vocabulary and the
// reserved set: a plugin descriptor may not take one of these ids, because "the
// Inbox" is not a thing a plugin gets to redefine by registering a colliding id.
export const CORE_VIEW_SURFACE_IDS = Object.freeze([ 'inbox', 'agents', 'teams' ]);

// Names contributed by the descriptors currently served. null means "nothing has
// been served yet", which is distinct from "served and empty" only for the sake of
// the tests that assert shrinking; readers treat both as core-only.
let descriptorViewNames = null;

// Names added through `registerViewNames()`, for a caller holding a view name
// before any descriptors exist (a test, or a static bootstrap). Kept separate so
// `setClientComponents([])` clearing the descriptor set does not silently keep one
// of these alive.
let moduleRegisteredNames = null;

export function isCoreViewSurface(viewName) {
  return CORE_VIEW_SURFACE_IDS.includes(viewName);
}

export function isReservedViewSurfaceID(surfaceID) {
  return isCoreViewSurface(surfaceID);
}

// The single writer for descriptor-contributed names. Called from
// `setClientComponents()`. Additive to core, never subtractive from it, and it
// clears when passed nothing -- that clearing is the unload path.
export function syncViewNames(names = null) {
  let input = Array.isArray(names) ? names : [];
  let extra = input
    .filter((name) => typeof name === 'string' && name.trim() !== '')
    .map((name) => name.trim())
    .filter((name) => !isCoreViewSurface(name));

  descriptorViewNames = extra.length > 0 ? new Set(extra) : null;
  return getRegisteredViewNames();
}

// Backwards-compatible alias used by callers that think of this as registration.
export function registerViewNames(names = null) {
  return syncViewNames(names);
}

// Every view name the stack may hold right now: the core ids, plus whatever
// `syncViewNames` last recorded. Reserved ids are filtered on the way in, so a
// colliding descriptor is invisible here rather than looking registered.
export function getRegisteredViewNames() {
  let names = [ ...CORE_VIEW_SURFACE_IDS ];

  if (descriptorViewNames) {
    for (let name of [ ...descriptorViewNames ].sort()) {
      if (!names.includes(name))
        names.push(name);
    }
  }

  if (moduleRegisteredNames) {
    for (let name of [ ...moduleRegisteredNames ].sort()) {
      if (!names.includes(name))
        names.push(name);
    }
  }

  return names;
}

// Kept as an alias so a reader of either module sees the same function name; the
// state argument is accepted and ignored on purpose (see the header note).
export function listAddressableViewNames(_state = null) {
  return getRegisteredViewNames();
}

export function isRegisteredViewName(viewName, _state = null) {
  if (typeof viewName !== 'string' || viewName.trim() === '')
    return false;
  return getRegisteredViewNames().includes(viewName.trim());
}

// Derive the descriptor-contributed names from a component list, applying the
// reserved-id rule. Exported so `setClientComponents` does not re-implement it.
export function viewNamesFromComponents(components = []) {
  let names = [];

  for (let component of Array.isArray(components) ? components : []) {
    let candidate = null;
    if (component?.kind === 'view')
      candidate = component.surfaceID;
    else if (component?.kind === 'sidebar-item')
      // A sidebar row exists to navigate somewhere, so its destination has to be
      // addressable even though the row itself is not a view surface.
      candidate = component.view;

    if (typeof candidate !== 'string' || candidate.trim() === '')
      continue;
    if (isReservedViewSurfaceID(candidate.trim()))
      continue;
    if (!names.includes(candidate.trim()))
      names.push(candidate.trim());
  }

  return names;
}
