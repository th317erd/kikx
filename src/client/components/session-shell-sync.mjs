'use strict';

// Session shell sync (extracted 2026-11-12 from kikx-frame-scroll.mjs to
// stay under the 800-line hard cap): the hot-path per-event title + grid
// repaint. Returns true when it handled the event — a false made callers
// rebuild the whole shell (the Inbox-jump / caret-loss defect documented
// below). The crumb-title write is SKIPPED while System Settings owns the
// crumb (owner 2026-11-12: session-title writes were stomping
// "Settings › section" with "No session").
//
// Re-exported from kikx-frame-scroll for every existing importer.

import { getDeletedSessions, getGridParentSessionID, getSessionPreviews, getVisibleSessions } from '../state/kikx-state.mjs';
import { currentViewName } from '../state/navigation-stack.mjs';

export function syncSessionShell(app) {
  // The title can be an h2 (root), the relocated breadcrumb title (session
  // window), or an inline input while editing (left alone).
  // The unified topbar renders the active crumb as
  // `.kikx-breadcrumb__crumb--active.kikx-window__title`, not as
  // `.kikx-breadcrumb__title`. Missing that class made this function report
  // `false` on every session event in a drilled-in thread, which forced a full
  // shell rebuild (and replaced the composer under the user's caret).
  let threadTitle = app.querySelector('.kikx-breadcrumb__title, .kikx-breadcrumb__crumb--active, .kikx-window__header h2');
  let editingTitle = app.querySelector('.kikx-breadcrumb__title-input, .kikx-breadcrumb__crumb--editing, .kikx-window__header .kikx-window__title-input');
  // Owner mode (settings, 2026-11-12): the crumb is MODE-OWNED
  // ('Settings › section'). Writing a session title over it produced
  // 'No session' (sessionless) or the stale session name — probe-confirmed
  // ('Settings', 'No session'). Only session surfaces own this text.
  const modeOwnsCrumb = currentViewName(app._state?.navigationStack || []) === 'settings';
  if (threadTitle && !editingTitle && !modeOwnsCrumb) {
    let selectedSession = app._selectedSession();
    let nextTitle = selectedSession?.title || 'No session';
    // session.saved fires repeatedly while an agent is busy. Rewriting the same
    // title on every event mutates (and relayouts) the breadcrumb under the
    // composer for no visual change.
    if (threadTitle.textContent !== nextTitle)
      threadTitle.textContent = nextTitle;
  }

  let grid = app.querySelector('kikx-session-grid');
  if (grid) {
    // Respect the current level's parent filter; the grid shows direct
    // children of the active session, never the unfiltered list.
    //
    // S3: use the coalesced grid sync. A burst of `session.saved` events used to
    // call grid.update() (a full grid + card rebuild) once per event; sync()
    // reconciles cards by id and repaints at most once per animation frame.
    grid.sync({
      allSessions: getVisibleSessions(app._state),
      parentSessionID: getGridParentSessionID(app._state),
      previews: getSessionPreviews(app._state),
      appState: app._state,
      selectedSessionID: app._state.selectedSessionID,
      loading: app._state.previewsLoading,
      deletedSessionIDs: new Set(getDeletedSessions(app._state).map((session) => session.id)),
    });
    return true;
  }

  // A view (currently just the Inbox) displaces `buildWindow` entirely -- see
  // `buildRunnerShell` -- so while one is on top there is deliberately no thread
  // title, no session grid and no frame list to repaint.
  //
  // That is not "I could not handle it". The only surface an event could still
  // affect here is the sidebar Inbox badge, and that is owned by
  // `syncQuestionShell` -- called by the `question.*` branch of the event
  // dispatcher, and again by `fetchQuestions`. It deliberately does NOT run
  // here: a badge repaint on every `session.saved` would be work with nothing to
  // do, and this function is on the hot path for every frame event.
  //
  // Reporting `false` here made every `session.saved` -- a title edit, a new
  // session, a soft delete in another tab -- trigger a full shell rebuild, which
  // tore down and re-created the Inbox underneath the user. That is why an
  // entirely unrelated page jumped on any runtime event, and why typing in an
  // answer box lost its caret: the textarea was replaced by a new node, not
  // edited in place.
  if (currentViewName(app._state.navigationStack) !== null)
    return true;

  // While the inline title editor is open there is no title button/h2, but the
  // window shell is still present. Returning false here would force a full app
  // rebuild on every `session.saved`, destroying the editor and its focus.
  return Boolean(threadTitle || editingTitle);
}
