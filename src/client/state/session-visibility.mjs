'use strict';

// Pure, DOM-free view helpers for the session workspace. The workspace lists
// live sessions; when "show deleted" is on it also lists soft-deleted ones, and
// a title query filters whichever set is being shown. Kept separate from
// session-state-utils so the filtering rules are unit-testable without a DOM.

export function normalizeSessionQuery(query) {
  return typeof query === 'string' ? query.trim().toLowerCase() : '';
}

export function matchesSessionTitle(session, query) {
  let needle = normalizeSessionQuery(query);
  if (!needle)
    return true;

  let title = typeof session?.title === 'string' ? session.title.toLowerCase() : '';
  return title.includes(needle);
}

// A stable, add-only filter: an empty query returns a copy of the list in the
// caller's order (never re-sorts), and a query keeps the matching sessions in
// that same order.
export function filterSessionsByTitle(sessions, query) {
  let list = Array.isArray(sessions) ? sessions : [];
  let needle = normalizeSessionQuery(query);
  if (!needle)
    return list.slice();

  return list.filter((session) => matchesSessionTitle(session, needle));
}

// Live sessions first (filtered), then — only when the eye is on — the deleted
// sessions (filtered). The two buckets are disjoint by construction, so no
// session is ever listed twice.
export function visibleSessions({ liveSessions = [], deletedSessions = [], showDeleted = false, query = '' } = {}) {
  let visible = filterSessionsByTitle(liveSessions, query);
  if (showDeleted)
    visible = visible.concat(filterSessionsByTitle(deletedSessions, query));

  return visible;
}
