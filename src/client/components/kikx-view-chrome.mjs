'use strict';

// Header chrome for the stack views (Inbox, Activities).
//
// Why this module exists: a view entry replaces the work area
// (`kikx-shell-builders.mjs:236-238` renders `buildInboxView`/
// `buildActivitiesView` *instead of* `buildWindow`). `buildWindowHeader` is the
// only place a Back control is ever built, so entering Inbox or Activities threw
// away the one affordance that leaves it again: the user could open the Inbox
// and had no way back to Projects/Sessions. The stack primitive was always
// correct -- `pushView` stacks the view over the session and `popStack` pops it
// -- but nothing in the DOM was wired to that pop.
//
// This builds the missing control: a labelled Back button that calls the app's
// own `_minimizeCurrent`, which pops the stack, re-syncs the selected session
// and rewrites the URL. Using the existing handler matters: a bespoke pop would
// leave `selectedSessionID` and the address bar pointing at the view.
//
// The control is injected into each view's *existing* header rather than a
// header of its own -- `.kikx-inbox-header` and `.kikx-activities__header`
// already render the title, count and scope label, so a second header would
// compete with them.
//
// No `stack.length > 1` guard. `pushView` (navigation-stack.mjs) strips a
// previous view entry but always retains the root, so any stack showing a view
// is >= 2 deep and a depth check here could never fire. An unreachable guard is
// worse than none: it reads as a safety net while exercising nothing. The
// precondition that actually matters is whether the app can pop at all, which
// is what the `_minimizeCurrent` guard below tests.
//
// Lives outside `kikx-shell-builders.mjs` because that file is already past the
// 500-line soft cap (546) and must not grow.

import { elements } from '../lib/aeor-ui.mjs';
import { createIcon } from '../lib/icons.mjs';
import { guardClientOperation } from '../lib/error-boundary.mjs';

const { button } = elements;

/**
 * Build the Back control for a stack view.
 *
 * Exposed separately from the view components so specs can assert the pop is
 * wired without depending on the surrounding layout.
 */
export function buildViewBackButton(app, label = 'Projects and Sessions') {
  return guardClientOperation('kikx-view-chrome.back', () => {
    // Call through the app, not through a detached reference. Extracting
    // `app._minimizeCurrent` into a local and invoking it bare loses the
    // receiver, so `this` is undefined inside `minimizeCurrent` and the pop
    // silently never happens. The handler is a method, so it must be invoked as
    // one.
    let hasLeave = typeof app?._minimizeCurrent === 'function';
    if (!hasLeave)
      return null;

    return button
      .type('button')
      .class('kikx-icon-button kikx-view__back')
      .title(`Back to ${label}`)
      .ariaLabel(`Back to ${label}`)
      .onClick(() => app._minimizeCurrent())(createIcon('chevron-left')).build(document);
  }, { surface: 'view-chrome' });
}
