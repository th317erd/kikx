'use strict';

// =============================================================================
// The element each plugin view surface stands on
// =============================================================================
// A leaf module on purpose: it imports nothing.
//
// `client-view-surfaces.mjs` (a component) creates and reuses these elements;
// `setClientComponents` (the state layer) is the single writer of the view
// vocabulary and the only place that learns when a surface has been uninstalled.
// Both need the same cache. Putting it behind an import of `client-view-surfaces`
// from the state layer would drag the view builders -- and therefore the whole
// shell -- into every module that touches state, so the cache lives here instead
// and each side imports this leaf. Same reasoning as `view-name-registry.mjs`.
//
// Why an element is cached at all:
//
//   The shell empties and rebuilds its tree on every paint, and a paint is what a
//   state change causes. Creating the view element per resolve therefore threw
//   away the view the user was standing on and rebuilt it from scratch each time,
//   taking its scroll position, its open row and its caret with it.
//
//   Reuse is what makes focus/selection preservation possible at all -- there has
//   to be a surviving node to preserve into. It is NOT sufficient on its own:
//   detaching a node blurs it, so the caret and `document.activeElement` still
//   have to be restored separately around the rebuild. This module only holds the
//   nodes; it does not restore focus.

const VIEW_SURFACE_ELEMENTS = new Map();

// Look up the element a surface already has, if any.
export function getViewSurfaceElement(surfaceID) {
  if (typeof surfaceID !== 'string')
    return null;
  return VIEW_SURFACE_ELEMENTS.get(surfaceID) || null;
}

// Record the element a surface is rendered with.
export function setViewSurfaceElement(surfaceID, element) {
  if (typeof surfaceID !== 'string' || !surfaceID)
    return false;
  if (!element)
    return false;

  VIEW_SURFACE_ELEMENTS.set(surfaceID, element);
  return true;
}

// Forget one surface, for a plugin upgrade that changes its tag or an explicit
// teardown.
export function forgetViewSurfaceElement(surfaceID) {
  if (typeof surfaceID !== 'string')
    return false;
  return VIEW_SURFACE_ELEMENTS.delete(surfaceID);
}

// Keep only the surfaces named in `liveSurfaceIDs`, and report what was dropped.
//
// Called when the descriptor inventory changes, so an uninstalled plugin cannot
// leave an element -- and whatever state it was holding -- alive behind a name
// nothing resolves any more.
export function pruneViewSurfaceElements(liveSurfaceIDs) {
  let live = liveSurfaceIDs instanceof Set ? liveSurfaceIDs : new Set(liveSurfaceIDs || []);
  let dropped = [];

  for (let surfaceID of VIEW_SURFACE_ELEMENTS.keys()) {
    if (live.has(surfaceID))
      continue;

    VIEW_SURFACE_ELEMENTS.delete(surfaceID);
    dropped.push(surfaceID);
  }

  return dropped;
}

// The surface ids currently holding an element, in insertion order. For tests and
// diagnostics; mutating the returned array cannot corrupt the cache.
export function listViewSurfaceElementIDs() {
  return Array.from(VIEW_SURFACE_ELEMENTS.keys());
}
