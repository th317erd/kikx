'use strict';

// Every non-session surface the stack can address. Order is the URL/UI order.
export const VIEW_NAMES = [ 'inbox', 'activities' ];

// A navigation stack of "windows" over a single work area. Each entry is either
// the root (top-level projects) or an entered session. A session entry always
// shows its thread; child sessions render inside that thread. Entries therefore
// carry no view mode -- there is no second surface to be in.
// Entry: { sessionID: string | null, collapsed: boolean, view?: VIEW_NAMES[number] }
// Root:  { sessionID: null, collapsed: true }
//
// `view` marks a non-session surface pushed on top of the stack. The pinned
// Inbox ('inbox', plan §6) and the Activities rollup ('activities', §6.4) are
// both places you enter from the sidebar and leave with Back, so they have to be
// stack entries rather than app-global state — otherwise Back would skip over
// them and deep links could not address them.

export function createNavigationStack() {
  return [ { sessionID: null, collapsed: true } ];
}

export function normalizeNavigationStack(stack) {
  if (!Array.isArray(stack) || stack.length === 0)
    return createNavigationStack();

  let normalized = stack.map((entry) => {
    let normalizedEntry = {
      sessionID: typeof entry?.sessionID === 'string' && entry.sessionID.trim() !== '' ? entry.sessionID.trim() : null,
      collapsed: entry?.collapsed === true,
    };

    if (VIEW_NAMES.includes(entry?.view))
      normalizedEntry.view = entry.view;

    return normalizedEntry;
  });

  // The root entry must always be the null-session root.
  if (normalized[0].sessionID !== null)
    normalized.unshift({ sessionID: null, collapsed: true });

  return normalized;
}

export function currentEntry(stack) {
  return normalizeNavigationStack(stack).at(-1);
}

export function currentSessionID(stack) {
  return currentEntry(stack).sessionID;
}

export function stackDepth(stack) {
  return normalizeNavigationStack(stack).length;
}

// Scope noun for user-facing labels: Project (root) -> Session -> Sub-Session.
export function scopeNounForDepth(depth) {
  if (depth <= 1)
    return 'Project';
  if (depth === 2)
    return 'Session';

  return 'Sub-Session';
}

export function pushThread(stack, sessionID) {
  let base = normalizeNavigationStack(stack);
  if (typeof sessionID !== 'string' || sessionID.trim() === '')
    return base;

  return [ ...base, { sessionID: sessionID.trim(), collapsed: false } ];
}

export function popStack(stack) {
  let base = normalizeNavigationStack(stack);
  if (base.length <= 1)
    return base;

  return base.slice(0, -1);
}

// --- Inbox view ---------------------------------------------------------
// The Inbox is a surface, not a session. Pushing it puts a view entry on top of
// whatever the user was looking at, so Back returns them there instead of to the
// root. It is idempotent: entering the Inbox twice must not stack two copies
// (that would make Back appear broken).
export function isViewEntry(entry) {
  return VIEW_NAMES.includes(entry?.view);
}

// The view name on top of the stack, or null when the top is a session surface.
export function currentViewName(stack) {
  let entry = currentEntry(stack);
  return isViewEntry(entry) ? entry.view : null;
}

export function isViewOpen(stack, view) {
  return currentViewName(stack) === view;
}

export function pushView(stack, view) {
  if (!VIEW_NAMES.includes(view))
    throw new TypeError(`pushView() unknown view: ${view}`);

  let base = normalizeNavigationStack(stack);
  // Idempotent: entering the same view twice must not stack two copies (Back
  // would then appear broken). Entering a *different* view replaces the current
  // one, so Inbox <-> Activities never buries the session underneath.
  if (isViewOpen(base, view))
    return base;

  let withoutView = isViewEntry(base.at(-1)) ? base.slice(0, -1) : base;
  return [ ...withoutView, { sessionID: null, collapsed: true, view } ];
}

export function isInboxEntry(entry) {
  return entry?.view === 'inbox';
}

export function isInboxView(stack) {
  return isInboxEntry(currentEntry(stack));
}

export function pushInbox(stack) {
  return pushView(stack, 'inbox');
}

export function isActivitiesView(stack) {
  return isViewOpen(stack, 'activities');
}

export function pushActivities(stack) {
  return pushView(stack, 'activities');
}

// The parent session ID for the current level's grid, i.e. the session whose
// children the current entry lists. Root lists top-level (parentSessionID null).
export function gridParentSessionID(stack) {
  let entry = currentEntry(stack);
  if (isViewEntry(entry))
    return null;

  return entry.sessionID;
}

// --- URL encoding for the navigation stack -------------------------------
// Encodes the current stack into a search string so a reload restores the
// exact view. Format:
//   ?session=<root>&session=<child>&...   (one per entered session, root first)
//   &collapsed=1                        (legacy: parsed and ignored, see below)
// The root entry (sessionID null) is implicit and never encoded.
export function stackToSearchParams(stack, existing = '') {
  let base = normalizeNavigationStack(stack);
  let params = new URLSearchParams(existing);
  params.delete('session');
  params.delete('view');
  params.delete('collapsed');

  for (let entry of base.slice(1)) {
    // A view entry carries no session; it is encoded as `view=<name>` below.
    if (isViewEntry(entry))
      continue;

    params.append('session', entry.sessionID);
  }

  let viewName = currentViewName(base);
  if (viewName)
    params.set('view', viewName);


  return params;
}

export function stackToURL(stack, options = {}) {
  let { origin = '', pathname = '/', search = '' } = options;
  let params = stackToSearchParams(stack, search);
  let query = params.toString();
  return `${origin}${pathname}${query ? `?${query}` : ''}`;
}

// Rebuild a stack from URL search params. `session` may repeat (root first).
// Preserves any non-navigation params (for example the magic-link `code`).
// Legacy: `view=thread` with no session means "open the first session".
export function stackFromSearchParams(search) {
  let params = new URLSearchParams(search || '');
  let sessionIDs = params.getAll('session')
    .filter((id) => typeof id === 'string' && id.trim() !== '')
    .map((id) => id.trim());
  // Old links carry `collapsed=1` (or `view=sub-sessions`) from when a session
  // window could be swapped for its child grid. That view is gone, so the flags
  // are read and deliberately discarded: a bookmark made while trapped in the
  // grid must land on the thread, not on a view that no longer exists. Reading
  // them at all keeps the URL round-trip silent instead of erroring.
  params.delete('collapsed');

  let stack = [ { sessionID: null, collapsed: true } ];
  for (let sessionID of sessionIDs)
    stack.push({ sessionID, collapsed: false });

  let viewParam = params.get('view');
  let view = VIEW_NAMES.includes(viewParam) ? viewParam : null;
  if (view)
    stack = pushView(stack, view);

  return {
    stack,
    viewThread: sessionIDs.length === 0 && viewParam === 'thread',
    // Kept for existing callers that only care about the inbox (§6.6).
    viewInbox: view === 'inbox',
    view,
  };
}
