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
