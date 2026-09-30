'use strict';

// A navigation stack of "windows" over a single work area. Each entry is either
// the root (top-level projects) or an entered session. `collapsed` shows only
// sub-sessions (a grid); expanded shows the full chat.
//
// Entry: { sessionID: string | null, collapsed: boolean }
// Root:  { sessionID: null, collapsed: true }

export function createNavigationStack() {
  return [ { sessionID: null, collapsed: true } ];
}

export function normalizeNavigationStack(stack) {
  if (!Array.isArray(stack) || stack.length === 0)
    return createNavigationStack();

  let normalized = stack.map((entry) => ({
    sessionID: typeof entry?.sessionID === 'string' && entry.sessionID.trim() !== '' ? entry.sessionID.trim() : null,
    collapsed: entry?.collapsed === true,
  }));

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

export function pushGrid(stack, parentSessionID) {
  let base = normalizeNavigationStack(stack);
  if (typeof parentSessionID !== 'string' || parentSessionID.trim() === '')
    return base;

  return [ ...base, { sessionID: parentSessionID.trim(), collapsed: true } ];
}

export function popStack(stack) {
  let base = normalizeNavigationStack(stack);
  if (base.length <= 1)
    return base;

  return base.slice(0, -1);
}

export function setCollapsed(stack, collapsed) {
  let base = normalizeNavigationStack(stack);
  let top = base.at(-1);
  let next = base.slice(0, -1);
  next.push({ ...top, collapsed: collapsed === true });
  return next;
}

// The parent session ID for the current level's grid, i.e. the session whose
// children the current entry lists. Root lists top-level (parentSessionID null).
export function gridParentSessionID(stack) {
  let entry = currentEntry(stack);
  return entry.sessionID;
}

// --- URL encoding for the navigation stack -------------------------------
// Encodes the current stack into a search string so a reload restores the
// exact view. Format:
//   ?session=<root>&session=<child>&...   (one per entered session, root first)
//   &collapsed=1                          (the top entry is collapsed)
// The root entry (sessionID null) is implicit and never encoded.
export function stackToSearchParams(stack, existing = '') {
  let base = normalizeNavigationStack(stack);
  let params = new URLSearchParams(existing);
  params.delete('session');
  params.delete('view');
  params.delete('collapsed');

  for (let entry of base.slice(1))
    params.append('session', entry.sessionID);

  if (base.length > 1 && base.at(-1).collapsed)
    params.set('collapsed', '1');

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
  let collapsed = params.get('collapsed') === '1'
    || params.get('view') === 'sub-sessions';

  let stack = [ { sessionID: null, collapsed: true } ];
  for (let sessionID of sessionIDs)
    stack.push({ sessionID, collapsed: false });

  if (collapsed && stack.length > 1)
    stack[stack.length - 1] = { ...stack[stack.length - 1], collapsed: true };

  return {
    stack,
    viewThread: sessionIDs.length === 0 && params.get('view') === 'thread',
  };
}
