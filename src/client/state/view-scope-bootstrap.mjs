'use strict';

// Resolve a session's view filters at COLD START, before the first frame fetch.
//
// WHY THIS EXISTS (owner report, 2026-11-05, follow-up). Scoping filters per
// session and persisting them introduced a second, worse bug than the one it
// fixed: on reload the thread showed a message for about a second and then the
// message VANISHED. Nothing was lost -- the frame was excluded by a filter that
// arrived late.
//
// The race, precisely:
//
//   1. `kikxState.frameFilters` seeds as `null`, which the window filters all-on.
//      That is a lie whenever the stored scope narrows anything.
//   2. The bootstrap fetch in `connectedCallback` builds its URL from
//      `state.frameFilters`, so it goes out UNFILTERED and the excluded frame
//      arrives and paints.
//   3. The session resolves from the URL, `syncViewScopeForSelection` applies the
//      stored scope, `pageContext.key` changes and the paged source remounts --
//      now the store-side predicate excludes that frame. It leaves the DOM.
//
// Every later page load is filtered server-side, so the frame cannot come back
// by scrolling. It looks like data loss and it is not.
//
// There are two structurally different ways to close it, and they are not
// equivalent:
//
//   (a) Do not paint until the scope has been resolved. This still sends an
//       unfiltered request and still holds the frame transiently in memory.
//   (b) Do not FETCH until the scope has been resolved. The excluded frame never
//       crosses the wire.
//
// This module does (b), and the distinction is the whole point. The requirement
// is that an excluded frame is never in the DOM -- not even for one frame of
// paint. Deferring only the paint satisfies the letter of "it stops flashing"
// while leaving the frame in a loaded page source that a remount will read.
// Deferring the FETCH makes the transient state unrepresentable: the frame was
// never requested with a filter that would keep it.
//
// ORDER DEPENDENCY, deliberately explicit. The request cannot be built before,
// because the request carries the filter. So boot must resolve in this order:
//
//   read URL -> learn which session -> load that session's scope -> make request
//
// Which is why this lives in its own module instead of inline in the app: the
// cold-start path had no session identity at the moment it fired its first
// fetch, and that absence is the bug. Naming it makes it testable without a
// browser, a network, or a store.

import { applySessionViewScope, readSessionViewScope } from './session-view-filters.mjs';
import { windowFiltersAreDefault } from '../../shared/frame-window-filters.mjs';

// Read the session a cold start is opening, from its own URL.
//
// This mirrors `hasSessionDeepLink` in `kikx-app-helpers.mjs`, and the two must
// agree: that helper decides whether the grid is suppressed while a deep link
// resolves, this one decides which scope to resolve. `?view=thread` without a
// `?session` is a real case -- it restores the thread WINDOW with no session in
// it, which is the empty grid, and the grid is a scope of its own.
export function coldStartSessionID(search = globalThis.location?.search || '') {
  let params = new URLSearchParams(search);
  let sessionID = params.get('session');
  if (typeof sessionID === 'string' && sessionID !== '')
    return sessionID;

  // `?view=thread` with no session selects no thread, so the answer is the grid
  // (the empty session id), not "unknown".
  return '';
}

// Resolve a session's stored scope into `state`, and report what was found.
//
// Synchronous on purpose. Callers are about to build a request; anything that
// yields -- a subscription, a microtask, an `await` -- lets that request go out
// first, which is exactly the bug. The return value is the applied scope so a
// caller can see that it resolved something narrower than the default (useful
// for an assertion, and for a log line that answers "why is this thread
// empty?" without a debugger).
export function resolveColdStartViewScope(state, sessionID, storage) {
  if (!state)
    return null;

  let scope = applySessionViewScope(state, sessionID, storage);
  // The Deleted gate selects whether the server may return soft-deleted frames,
  // and it is per-session now, so the grid's bucket flag has to agree with it.
  // `syncViewScopeForSelection` keeps these two in step on every navigation;
  // cold start bypasses that function (it sets state before the app exists), so
  // the same pairing has to be made here or a session persisted with the gate
  // on would render its hidden frames while the eye showed them off.
  state.showDeletedSessions = state.frameFilters?.deleted === true;
  return scope;
}

// True when `sessionID` has a stored scope that narrows the default view. Used
// to tell "this thread is legitimately empty because you filtered it" from "this
// thread is empty because something is broken" -- two states that are otherwise
// indistinguishable on screen, and the reason the original report read as data
// loss.
export function storedScopeIsNarrowing(sessionID, storage) {
  let scope = readSessionViewScope(sessionID, storage);
  // Compared against the actual default view, not against "any key is false".
  // The `deleted` gate defaults to OFF, so a plain "some value is false" test
  // reported EVERY fresh scope as narrowing -- it would have flagged every
  // untouched session as "you filtered this", which is the opposite of useful.
  return !windowFiltersAreDefault(scope.filters, scope.query);
}
