'use strict';

// The Activities surface (plan §6.1, §6.4; phase P4).
//
// The sidebar is the glance — "everything important at a glance" ([D-2]) — and
// this view is the detail behind that glance: per-project and per-session stats
// with a drill-down into child sessions.
//
// Like `kikx-inbox-view.mjs`, this lives in its own module because
// `kikx-shell-builders.mjs` is already past the 500-line soft limit, and because
// the stats rendering is a self-contained concern that does not need the shell
// builder's closure.
//
// Nothing here fetches. Sessions arrive through `loadSessions`
// (`kikx-data.mjs:83`) and questions through the questions state that P3 added;
// this module only derives and renders (§6.4, [D-10] client-derived stats).

import { elements } from '../lib/aeor-ui.mjs';
import { guardClientOperation } from '../lib/error-boundary.mjs';
import {
  getCurrentSessionID,
  getQuestionsState,
  getSessions,
  isActivitiesOpen,
  navigateActivities,
  navigateThread,
} from '../state/kikx-state.mjs';
import {
  buildProjectStats,
  buildSessionStats,
  sortStatsByActivity,
} from '../state/activities-stats.mjs';

const { div, section, header, h2, h3, p, span, button, ul, li } = elements;

// --- Formatting ------------------------------------------------------------

/**
 * Compact relative age for a stats line. Deliberately local rather than shared
 * with `questionAge` (`questions-state.mjs:275`): that one is question-flavoured
 * ("asked N ago") and must keep its own wording, while stats want a neutral
 * "last activity" phrasing.
 */
export function formatActivityAge(updatedAt, now = Date.now()) {
  if (!Number.isFinite(updatedAt) || updatedAt <= 0)
    return 'no activity';

  let delta = now - updatedAt;
  // Clock skew (a server stamp slightly ahead of this tab) reads as "just now"
  // rather than a negative age.
  if (delta < 0)
    return 'just now';

  let seconds = Math.floor(delta / 1000);
  if (seconds < 60)
    return 'just now';

  let minutes = Math.floor(seconds / 60);
  if (minutes < 60)
    return `${minutes}m ago`;

  let hours = Math.floor(minutes / 60);
  if (hours < 24)
    return `${hours}h ago`;

  let days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function plural(count, singular, pluralForm = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

// --- Stat derivation over shell state --------------------------------------

/**
 * Build the stats for whatever the navigation stack currently points at.
 *
 * At the root (no current session) every root project is summarised. Inside a
 * session, that session's project is summarised plus its direct children, which
 * is the "stats -> drill-down" chain in §6.1 without adding another stack entry
 * type.
 */
export function deriveActivities(app, now = Date.now()) {
  let sessions = getSessions(app._state) || [];
  let questions = getQuestionsState(app._state).questions || [];
  let currentSessionID = getCurrentSessionID(app._state);

  let projects = sortStatsByActivity(buildProjectStats(sessions, questions));

  if (!currentSessionID)
    return { scope: 'workspace', current: null, projects, children: [] };

  // A project is identified by its root ancestor, so a session three levels
  // deep still reports the project it belongs to.
  let project = projects.find((stats) => stats.sessionIDs?.includes(currentSessionID))
    || buildSessionStats(
      sessions.find((session) => session.id === currentSessionID) || { id: currentSessionID },
      { questions },
    );

  let children = sortStatsByActivity(
    buildProjectStats(
      sessions.filter((session) => session.parentSessionID === currentSessionID),
      questions,
    ),
  );

  return { scope: 'session', current: project, currentSessionID, projects, children, now };
}

// --- Rendering -------------------------------------------------------------

function stat(label, value) {
  return div.class('kikx-activities__stat')(
    span.class('kikx-activities__stat-value')(String(value)),
    span.class('kikx-activities__stat-label')(label),
  );
}

function renderStatCard(app, stats, options = {}) {
  let title = stats.title || 'Untitled';
  let open = stats.openQuestions || 0;

  let card = div.class(`kikx-activities__card${open > 0 ? ' kikx-activities__card--attention' : ''}`)(
    div.class('kikx-activities__card-head')(
      h3.class('kikx-activities__card-title')(title),
      span.class('kikx-activities__card-age')(formatActivityAge(stats.lastActivity ?? stats.updatedAt, options.now)),
    ),
    div.class('kikx-activities__stats')(
      stat('sessions', stats.sessionCount ?? 1),
      stat('open questions', open),
      stat('messages', stats.messageCount || 0),
      stat('agents', stats.agentCount ?? (stats.agentIDs || []).length),
    ),
  );

  // Drill-down: only sessions are enterable. At the root the cards are project
  // rollups, and clicking one enters its root session (§6.1 tree).
  //
  // The click lives on an inner wrapper rather than a second card: nesting a
  // node with the same `kikx-activities__card` class inside itself would make
  // every "how many cards?" query return double and would double the border.
  let target = options.enterSessionID;
  if (target) {
    card = div.class('kikx-activities__enterable')
      .onClick(() => {
        navigateThread(target, app._state);
        app._requestRender?.();
      })(card);
  }

  return card;
}

/**
 * The Activities panel, rendered in the main column in place of the window.
 * Mirrors `buildInboxView`'s containment: a render failure surfaces in-app and
 * must never wedge the shell (plan §11 S1).
 */
export function buildActivitiesView(app, options = {}) {
  return guardClientOperation('kikx-activities.view', () => {
    let derived = options.derived || deriveActivities(app, options.now ?? Date.now());
    let now = options.now ?? derived.now ?? Date.now();

    if (derived.scope === 'workspace') {
      return section.class('kikx-activities')(
        header.class('kikx-activities__header')(h2('Activities')),
        derived.projects.length === 0
          ? buildActivitiesEmptyState()
          : div.class('kikx-activities__grid')(
            derived.projects.map((project) => renderStatCard(app, project, {
              now,
              enterSessionID: project.sessionID,
            })),
          ),
      ).build(document);
    }

    let current = derived.current || {};

    return section.class('kikx-activities')(
      header.class('kikx-activities__header')(
        h2(current.title || 'Activities'),
        span.class('kikx-activities__scope')('project rollup'),
      ),
      div.class('kikx-activities__summary')(renderStatCard(app, current, { now })),
      derived.children.length === 0
        ? p.class('kikx-activities__hint')('No sub-sessions yet.')
        : div.class('kikx-activities__children')(
          h3.class('kikx-activities__section-title')('Sub-sessions'),
          ul.class('kikx-activities__child-list')(
            derived.children.map((child) => li.class('kikx-activities__child')(
              renderStatCard(app, child, { now, enterSessionID: child.sessionID }),
            )),
          ),
        ),
    ).build(document);
  }, { surface: 'activities' })
    || section.class('kikx-activities')(h2('Activities')).build(document);
}

export function buildActivitiesEmptyState() {
  return div.class('kikx-activities__empty')(
    p('No projects yet.'),
    p.class('kikx-activities__empty-hint')('Create a session to see activity here.'),
  );
}

/**
 * Sidebar entry, sitting under the pinned Inbox. Same button shape as
 * `buildInboxSidebarEntry` (`kikx-inbox-view.mjs:49`) so the two read as a pair.
 */
export function buildActivitiesSidebarEntry(app) {
  return guardClientOperation('kikx-activities.sidebar', () => {
    let selected = isActivitiesOpen(app._state);
    let derived = deriveActivities(app);
    let open = derived.projects.reduce((total, project) => total + (project.openQuestions || 0), 0);

    return button
      .type('button')
      .class(`kikx-sidebar__activities${selected ? ' kikx-sidebar__activities--active' : ''}`)
      .ariaLabel(open > 0 ? `Activities, ${open} open questions` : 'Activities')
      .onClick(() => {
        navigateActivities(app._state);
        app._requestRender?.();
      })(
        span.class('kikx-sidebar__activities-label')('Activities'),
      ).build(document);
  }, { surface: 'sidebar' }) || div.class('kikx-sidebar__activities')().build(document);
}
