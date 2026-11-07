'use strict';

// =============================================================================
// The status bar — connection, counts, tokens, instance version
// =============================================================================
// Extracted from kikx-shell-builders.mjs when that file crossed the 800-line
// hard cap (2026-11-07, the version cell pushed it to 804). Everything about
// the bar's CONTENT lives here; the shell still mounts it through
// `app._buildStatusBar()` (bound in kikx-app) and `buildStatusBar` is
// re-exported from kikx-shell-builders so existing importers are unchanged.
//
// The counts are PLAIN values, not bindings: the whole shell is rebuilt on
// every render, so they recompute by construction — see the note in
// state/statusbar-stats.mjs (a binding here would allocate listeners for
// text that is always fresh).

import { elements } from '../lib/aeor-ui.mjs';
import { createIcon } from '../lib/icons.mjs';
import { formatTokenUsageTotal } from './kikx-app-helpers.mjs';
import {
  getCurrentSessionID,
  getQuestionsState,
  getSessions,
} from '../state/kikx-state.mjs';
import { buildStatusBarStats } from '../state/statusbar-stats.mjs';

const { div, span } = elements;

export function buildStatusBar(app) {
  // Owner review 3 (2026-10-28): the Activities view and its sidebar entry are gone;
  // its four counts live here instead and follow the session on top of the stack.
  //
  // Every lookup is defensive because this runs inside the shell's error boundary: a
  // throw here blanks the entire app, not just the bar.
  let sessions = [];
  let questions = [];
  try {
    sessions = Array.isArray(getSessions(app._state)) ? getSessions(app._state) : [];
    questions = Array.isArray(getQuestionsState(app._state)?.questions)
      ? getQuestionsState(app._state).questions
      : [];
  } catch {
    // Leave both empty: the bar degrades to a zeroed row rather than killing the shell.
  }

  let stats = buildStatusBarStats({
    sessions,
    questions,
    currentSessionID: getCurrentSessionID(app._state),
  });

  // Owner change (2026-11-05): the bar collapses to bare numbers joined by
  // slashes -- `2 / 0 / 1234 / 234` -- on BOTH desktop and mobile. The labels
  // the cards used are not rendered; each value keeps its label as a hover
  // title, and the group title spells out the order, so nothing is lost for a
  // pointer. The connection TEXT is likewise dropped on mobile only (the dot
  // keeps the state), and the Debug toggle moved to the toolbar next to Raw.
  let statsTitle = `Counts for ${stats.scopeLabel}: sessions / open questions / messages / agents`;

  return div.class.bindState((state) => `kikx-statusbar kikx-statusbar--${state.connectionStatusKind}`, ['connectionStatusKind'])(
    span.class('kikx-statusbar__dot')(),
    span.class('kikx-statusbar__connection')
      .textContent.bindState((state) => state.connectionStatus, ['connectionStatus'])(),
    span.class('kikx-statusbar__spacer')(),
    // The counts sit AFTER the spacer, so the connection/dot cluster stays left and
    // the tallies read as a right-aligned group beside the token total.
    div.class('kikx-statusbar__stats').title(statsTitle)(
      stats.cells.flatMap((cell, index) => [
        index > 0 ? span.class('kikx-statusbar__stat-sep')('/') : null,
        span.class('kikx-statusbar__stat')(
          span.class('kikx-statusbar__stat-value').title(cell.label)(String(cell.value)),
        ),
      ]),
    ),
    span.class('kikx-statusbar__spacer')(),
    span
      .class('kikx-statusbar__tokens')
      .title('Total tracked tokens')(
        createIcon('tokens'),
        span
          .class('kikx-statusbar__tokens-value')
          .textContent.bindState((state) => formatTokenUsageTotal(state.totalTokensUsed), ['totalTokensUsed'])(),
      ),
    // Instance version, DEBUG MODE ONLY (owner task, 2026-11-07): plain value,
    // rendered only once /health answered — never "undefined" while in flight.
    app._state.debugMode === true
      && typeof app._state.kikxVersion === 'string'
      && app._state.kikxVersion !== ''
      ? span.class('kikx-statusbar__version').title('Kikx server version')(app._state.kikxVersion)
      : null,
  );
}
