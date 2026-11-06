'use strict';

// Per-session view filters, persisted in localStorage.
//
// WHY THIS EXISTS (owner report, 2026-11-05). With the eyeball popup Ctrl+Clicked
// to "Child Sessions", clicking into one of those child sessions showed an EMPTY
// thread. Nothing was broken about the filter -- it was global. The child session
// has no children of its own, so a globally-held "Child Sessions" selection is
// guaranteed to match nothing there, and the user is left staring at an empty
// view wondering what they broke.
//
// A view filter describes how ONE session is being looked at. So it is scoped to
// that session:
//
//   * ISOLATION -- entering a session never inherits the previous selection. An
//     unseen session opens with every category on.
//   * SURVIVAL -- a reload restores what was deliberately narrowed, rather than
//     silently resetting to "everything on".
//
// THE EMPTY GRID IS A SCOPE OF ITS OWN. The header search box has two meanings
// depending on where you are: on the grid it filters session titles, inside a
// session it becomes a frame query. Those are different jobs over different
// data, so they must not share storage -- otherwise typing a frame query and then
// going back to the grid would silently replace the title filter with it. The
// grid's scope key is the empty session id, which cannot collide with a real one.
//
// WHY THE SWAP IS SYNCHRONOUS AND NOT A SUBSCRIPTION. Filtering is a TRANSPORT
// concern: the server decides which frames to send, and `loadFrames` reads
// `state.frameFilters` at request time. A ReactiveState subscription flushes on a
// microtask, which is after the navigation code that immediately awaits
// `_loadFrames` -- the request would go out carrying the PREVIOUS session's
// filter, which is the bug this module exists to fix. So callers apply the scope
// explicitly, at the transition, before anything fetches.

import {
  defaultFrameWindowFilters,
  normalizeWindowFilters,
  normalizeFrameQuery,
} from '../../shared/frame-window-filters.mjs';

// `kikx.viewScope.<sessionID>`. Prefixed and version-less on purpose: the stored
// payload is normalised on read, so an older or partial scope degrades to the
// defaults instead of poisoning the UI.
export const SESSION_VIEW_SCOPE_PREFIX = 'kikx.viewScope.';

// The grid's scope key. Empty string is not a session id, and `viewScopeKey`
// maps it here explicitly so the mapping is one function rather than a
// convention every caller has to remember.
export const GRID_VIEW_SCOPE = 'grid';

export function viewScopeKey(sessionID) {
  let id = typeof sessionID === 'string' ? sessionID : '';
  return id === '' ? GRID_VIEW_SCOPE : id;
}

export function storageKeyFor(sessionID) {
  return `${SESSION_VIEW_SCOPE_PREFIX}${viewScopeKey(sessionID)}`;
}

// A fresh scope every call. Callers mutate the object they get back (the popup
// assigns into `state.frameFilters`), so handing out one shared default object
// would let one session's edit leak into every future session. This is the same
// class of bug as the one being fixed, one layer down.
export function defaultViewScope() {
  return { filters: defaultFrameWindowFilters(), query: '' };
}

// Repair anything that came out of storage or off the wire. Deliberately does
// not trust the shape: `normalizeWindowFilters` coerces each known key to a
// boolean and drops unknown ones, and the query is forced back to a string.
export function normalizeViewScope(scope) {
  let source = scope && typeof scope === 'object' ? scope : {};
  return {
    filters: normalizeWindowFilters(source.filters),
    query: normalizeFrameQuery(source.query),
  };
}

// localStorage access is wrapped because it is not merely "usually available":
// in private modes it exists and throws on write, and in a sandboxed frame even
// reading it throws. A missing or hostile store must degrade to in-memory
// behaviour, never take the page down.
function safeStorage(storage) {
  if (storage)
    return storage;

  try {
    return globalThis.localStorage || null;
  } catch (_error) {
    return null;
  }
}

export function readSessionViewScope(sessionID, storage) {
  let store = safeStorage(storage);
  if (!store)
    return defaultViewScope();

  let raw;
  try {
    raw = store.getItem(storageKeyFor(sessionID));
  } catch (_error) {
    return defaultViewScope();
  }

  if (typeof raw !== 'string' || raw === '')
    return defaultViewScope();

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_error) {
    return defaultViewScope();
  }

  return normalizeViewScope(parsed);
}

export function writeSessionViewScope(sessionID, scope, storage) {
  let store = safeStorage(storage);
  if (!store)
    return false;

  let normal = normalizeViewScope(scope);
  try {
    store.setItem(storageKeyFor(sessionID), JSON.stringify(normal));
    return true;
  } catch (_error) {
    // Quota or a locked-down profile. The in-memory state is already correct;
    // failing to persist costs the reload case, not the current session.
    return false;
  }
}

export function clearSessionViewScope(sessionID, storage) {
  let store = safeStorage(storage);
  if (!store)
    return false;

  try {
    store.removeItem(storageKeyFor(sessionID));
    return true;
  } catch (_error) {
    return false;
  }
}

// Record the CURRENT state as the given session's scope. Call this before the
// selection moves away from it -- after that, `state.frameFilters` belongs to
// the destination and there is nothing left to save.
export function captureSessionViewScope(state, sessionID, storage) {
  if (!state)
    return false;

  return writeSessionViewScope(sessionID, {
    filters: state.frameFilters,
    query: state.sessionSearch,
  }, storage);
}

// Load the given session's scope into the live state.
//
// This REPLACES both fields, including the "nothing stored" case -- that is the
// whole point. A missing entry means "this session has never been filtered", and
// the correct answer is the default view, not the leftovers of wherever the user
// just came from.
// Debounce window for persisting a typed filter query. One input event per
// keystroke against a synchronous localStorage.setItem is not worth it; a reload
// within the window loses at most the last few characters, which is the same
// trade the frame query itself already makes.
const VIEW_SCOPE_PERSIST_MS = 250;

// Persist the app's CURRENT selection under the session it belongs to. Reads
// `app._state`, so it lives here rather than in the navigation component: it is
// a fact about the scope, not about navigating.
export function persistAppViewScope(app) {
  if (!app?._state)
    return false;

  if (app._viewScopePersistTimer) {
    clearTimeout(app._viewScopePersistTimer);
    app._viewScopePersistTimer = 0;
  }

  return captureSessionViewScope(app._state, app._state.selectedSessionID);
}

// Coalesced variant, for the per-keystroke query path.
export function persistAppViewScopeSoon(app) {
  if (!app)
    return;

  if (app._viewScopePersistTimer)
    clearTimeout(app._viewScopePersistTimer);

  app._viewScopePersistTimer = setTimeout(() => {
    app._viewScopePersistTimer = 0;
    persistAppViewScope(app);
  }, VIEW_SCOPE_PERSIST_MS);
}

export function applySessionViewScope(state, sessionID, storage) {
  if (!state)
    return defaultViewScope();

  let scope = readSessionViewScope(sessionID, storage);
  state.frameFilters = scope.filters;
  state.sessionSearch = scope.query;
  return scope;
}

// Seed the cold-start view scope from the URL, before anything can fetch.
//
// Called once while the initial state object is built -- the EARLIEST moment the
// app can know a filter, which is why it must happen here rather than later.
// `loadFrames` builds its URL from `state.frameFilters`, so a state left at the
// all-on default sends an unfiltered first request and paints frames the stored
// scope excludes. See state/view-scope-bootstrap.mjs for the full chain.
//
// `session` absent means the thread window with no session in it, which is the
// grid -- a scope of its own, keyed by the empty id.
//
// Deliberately tolerant: a throw here is a white screen, because this runs during
// evaluation of the global state object. A sandboxed storage or a hostile URL
// must degrade to the default view, never to no app.
export function seedInitialViewScope(search, storage) {
  try {
    let params = new URLSearchParams(search || '');
    return readSessionViewScope(params.get('session') || '', storage);
  } catch (_error) {
    return defaultViewScope();
  }
}
