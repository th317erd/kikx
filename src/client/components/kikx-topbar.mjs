'use strict';

// Unified top toolbar (owner spec points 1-4).
//
// INVENTORY OF THE TWO BARS THIS REPLACES (file:line, HEAD e7b1739):
//
//   bar 1  `kikx-topbar`           src/client/components/kikx-shell-builders.mjs:58
//          brand :59-64 | breadcrumb :66 | top-right actions :68-74
//          actions = account chip, Account, Agents, Teams, Sign out (:69-73)
//
//   bar 2  `kikx-window__header`   src/client/components/kikx-shell-builders.mjs:307
//          lead :308-312 (back :299-305, crumb title :310, scroll-lock :311)
//          search :313 | actions :314-338 (preview status, participants popup,
//          frame-filter popup, `+ Add <noun>` :331-336)
//
//   DUPLICATED CONCEPT: `buildBreadcrumb` :177-210 (bar 1) and
//   `buildBreadcrumbTitle` :469-489 (bar 2) both answer "where am I / rename me".
//   That duplication is owner point 3.
//
// ---------------------------------------------------------------------------
// CSS CONSTRAINT (learned the hard way - it failed the gate once):
// `spec/client/stylesheet-links-spec.mjs:145-163` fails the build if any
// `kikx-*` class emitted by `src/client/components/*.mjs` has no rule in a
// stylesheet `index.html` links. That test caught 8 invented class names in the
// first draft of this module.
//
// This module writes no CSS of its own. The unified-bar layout rules - centring
// the search field (owner point 4) and the crumb pencil reveal-on-hover (owner
// point 3) - live in a SEPARATE sheet, src/client/styles/topbar-unified.css,
// registered by one <link> in src/client/index.html. Neither app.css nor this
// builder file grows.
//
// Nothing in this module mutates app state at build time. This bar is THE bar:
// there is no enable flag and no second rendering path. Rollback to the two
// stacked bars is a git checkout of e7b1739, not a runtime switch that nothing
// can flip (an earlier "default OFF" flag here was never assigned by any code).
// ---------------------------------------------------------------------------

import { elements } from '../lib/aeor-ui.mjs';
import {
  attachSessionNameEntryGestures,
  consumeNavigationClickGuard,
} from './session-name-gestures.mjs';
import { createIcon } from '../lib/icons.mjs';
import { stateHasFilters } from '../lib/frame-filters.mjs';
import { buildScrollLockToolbar } from './kikx-scroll-lock.mjs';
// ONE shared contract for the rename field's `name` (owner item 2). The bar used
// to name it `crumb-name` while `beginSessionNameEdit` looked up `session-name`,
// so the field was never focused and blur/Escape were both dead. The constant
// lives in kikx-navigation.mjs beside the lookup that has to match it, and all
// three rename builders import it rather than repeating the string.
import {
  SESSION_NAME_INPUT_NAME,
  commitSessionNameOnFocusout,
  holdSessionNameFieldFocus,
} from './kikx-navigation.mjs';
import { getCurrentEntry, getScopeNoun, getSessions, getStackDepth } from '../state/kikx-state.mjs';

// Registration side effects for the popup custom elements hosted by the bar.
// Imported here directly (not via kikx-shell-builders.mjs) so this module never
// forms an import cycle with the file that imports it.
import './kikx-participants-popup.mjs';
import './kikx-frame-filter-popup.mjs';

const { div, nav, header, h1, p, span, button, input } = elements;

// Crumb model. Mirrors buildBreadcrumb (kikx-shell-builders.mjs:177-210) crumb
// for crumb so the two stay comparable; the only addition is `sessionID`, which
// the pencil needs in order to know which path it renames. The root "Projects"
// crumb has no session, hence no pencil: there is no session row to rename.
export function buildCrumbModel(app) {
  let stack = app._state?.navigationStack || [];
  let sessions = getSessions(app._state);
  let crumbs = [{ label: 'Projects', depth: 1, active: stack.length === 1, sessionID: null }];

  for (let index = 1; index < stack.length; index++) {
    let entry = stack[index];
    let session = sessions.find((candidate) => candidate.id === entry.sessionID);
    let label = session?.title || (entry.sessionID ? String(entry.sessionID).slice(0, 8) : 'Session');
    crumbs.push({
      label,
      sessionID: entry.sessionID || null,
      depth: index + 1,
      active: index === stack.length - 1,
    });
  }

  return crumbs;
}

// The active crumb is a span (not a destination) and doubles as the bar's title.
// `kikx-window__title` is the compat alias described below; both classes have
// app.css rules, so this file still adds no CSS.
const ACTIVE_CRUMB_CLASS = 'kikx-breadcrumb__crumb kikx-breadcrumb__crumb--active kikx-window__title';

// One crumb, plus its pencil. The active crumb stays a span (not clickable),
// exactly as buildBreadcrumbCrumb does at kikx-shell-builders.mjs:214-220.
//
// COMPAT CLASS, deliberate: the active crumb also carries `kikx-window__title`.
// In a merged bar the active crumb IS the window title, and three browser specs
// read the current title by querying
//   '.kikx-window__header h2, .kikx-window__header .kikx-window__title[]'
// (spec/ui/stagehand/{new-session,sub-session,session-grid}-stagehand.mjs). They
// only read textContent -- none of them clicks it -- so the class is an alias,
// not a second control. It also has an app.css rule (.kikx-window__header
// .kikx-window__title), so stylesheet-links-spec stays satisfied.
export function buildTopbarCrumb(app, crumb) {
  if (crumb.sessionID && app._state.editingSessionNameID === crumb.sessionID) {
    // Native input: aeor-input does not re-dispatch keydown/focusout, which the
    // inline rename needs for Enter/Escape and click-away commit. The name comes
    // from the shared constant so the focus lookup can never drift from it again.
    let field = input
      .type('text')
      .class('kikx-breadcrumb__title-input')
      .name(SESSION_NAME_INPUT_NAME)
      .value(app._state.editingSessionNameValue || '')
      .onInput((event) => { app._state.editingSessionNameValue = event.target.value; })
      .onKeydown((event) => app._onSessionNameKeydown(event, crumb.sessionID))
      .onFocusout((event) => commitSessionNameOnFocusout(app, event, crumb.sessionID))();

    // Owner item 2b: "if I change my mind, I am fucked... there is NO WAY to
    // leave edit mode". Blur, Esc and navigation are all fixed in
    // kikx-navigation.mjs, but a VISIBLE control is the part that needs no
    // knowledge of any key. Both buttons are real buttons so they are keyboard
    // reachable, and both live inside `.kikx-breadcrumb__editor`, which is what
    // tells the focus guard not to yank focus back to the field before the click
    // lands.
    return div.class('kikx-breadcrumb__editor')(
      field,
      button
        .type('button')
        .class('kikx-breadcrumb__editor-action kikx-icon-button')
        .title('Save name')
        .ariaLabel('Save name')
        .onMousedown(holdSessionNameFieldFocus)
        .onClick(() => app._commitSessionName(crumb.sessionID))(createIcon('check')),
      button
        .type('button')
        .class('kikx-breadcrumb__editor-action kikx-icon-button')
        .title('Cancel rename')
        .ariaLabel('Cancel rename (Esc)')
        .onMousedown(holdSessionNameFieldFocus)
        .onClick(() => app._cancelSessionNameEdit())(createIcon('circle-x')),
    );
  }

  if (!crumb.sessionID) {
    return crumb.active
      ? span.class(crumb.active ? ACTIVE_CRUMB_CLASS : 'kikx-breadcrumb__crumb')(crumb.label)
      : button.type('button').class('kikx-breadcrumb__crumb')
        .onClick(() => app._navigateToDepth(crumb.depth))(crumb.label);
  }

  // A session crumb: just the label. The rename is a GESTURE now, not a button
  // (owner change of mind, 2026-10-27), so nothing sits beside the label.
  //
  // The gesture is attached to the BUILT node, not declared in the DSL: it is
  // imperative listener wiring with a timer and a teardown, which the element DSL
  // has no shape for. `.build(document)` here is deliberate and is the only place
  // in this module that forces a build, because the listener needs a real node.
  // Attaching before the node is wrapped is safe: a real DOM node passes through
  // the DSL unchanged, so the node nav is given is the same node the listeners
  // are on.
  // The ancestor's click consults `consumeNavigationClickGuard()` because a
  // long-press on an ancestor crumb opens the editor at 450ms and the click that
  // follows the release would otherwise navigate and destroy it. See the guard's
  // comment in session-name-gestures.mjs for why it cannot be done with
  // stopPropagation or a capture-phase listener.
  let label = (crumb.active
    ? span.class(ACTIVE_CRUMB_CLASS)(crumb.label)
    : button.type('button').class('kikx-breadcrumb__crumb')
      .onClick(() => {
        if (consumeNavigationClickGuard(crumb.sessionID))
          return;
        app._navigateToDepth(crumb.depth);
      })(crumb.label)).build(document);

  attachSessionNameEntryGestures(app, label, crumb);

  // The pencil was the only keyboard-reachable entry, and it is gone. `tabindex`
  // plus F2 keeps the rename reachable without a mouse, and the title attribute
  // is the tooltip that makes the gesture discoverable at all -- nothing else on
  // screen advertises that the title can be edited.
  label.setAttribute('tabindex', '0');
  // The tooltip must not promise a gesture the crumb does not have: double-click
  // is active-crumb only (see the dblclick handler), so an ancestor advertises
  // just the two entries it really supports.
  label.setAttribute('title', crumb.active
    ? `Double-click or hold to rename "${crumb.label}" (F2)`
    : `Hold to rename "${crumb.label}" (F2)`);

  // NOTE: wrap in `nav`, not `kikx-breadcrumb__crumb`. That class is a pill -
  // app.css:2799-2811 gives it border and radius - so nesting it around a
  // second control would render a pill inside a pill and paint a second
  // clickable-looking target. `nav` already carries a rule and is the correct
  // semantic home for a navigation affordance that is also editable.
  return nav.class('kikx-breadcrumb')(label);
}

// Back + breadcrumb MERGED into one control (owner point 3). The chevron leads
// the trail instead of standing as a separate button; it exists only when there
// is somewhere to go back to, which is exactly when the legacy back button
// rendered (kikx-shell-builders.mjs:298-299 `nested`).
export function buildTopbarBreadcrumb(app) {
  let nested = getStackDepth(app._state) > 1;
  let crumbs = buildCrumbModel(app);

  let trail = crumbs.flatMap((crumb, index) => {
    let nodes = [];
    if (index > 0)
      nodes.push(span.class('kikx-breadcrumb__sep')('›'));
    nodes.push(buildTopbarCrumb(app, crumb));
    return nodes;
  });

  let children = [];

  if (nested)
    children.push(
      button
        .type('button')
        .class('kikx-icon-button kikx-window__close')
        .title('Close session')
        .ariaLabel('Close session')
        .onClick(app._minimizeCurrent)(createIcon('chevron-left')),
    );

  children.push(nav.class('kikx-breadcrumb').ariaLabel('Session navigation')(trail));

  // The reserved session-toolbar slot. Legacy kept it in the second bar's lead
  // (kikx-shell-builders.mjs:319, `buildScrollLockToolbar`); the scroll-lock
  // button itself floats over the thread, but the slot is where session-level
  // tools land. Carrying it across means deleting the second bar cannot strand
  // that slot. `buildScrollLockToolbar` returns an empty div today, so this is
  // currently a no-op node - kept deliberately, not cargo-culted.
  let entry = getCurrentEntry(app._state);
  if (entry?.sessionID)
    children.push(buildScrollLockToolbar(app, entry.sessionID));

  return div.class('kikx-window__lead')(...children);
}

// The freed centre (owner point 4). Same behaviour as buildSessionSearch
// (kikx-shell-builders.mjs:437-458) - a query input plus one "clear all filters"
// action - carried here so the merged bar owns its own centre and app.css is not
// grown. Native input for the same reason the legacy builder uses one.
export function buildTopbarSearch(app, sessionID = null) {
  let searchInput = document.createElement('input');
  searchInput.type = 'search';
  searchInput.className = 'kikx-session-search__input';
  searchInput.name = 'session-search';
  searchInput.placeholder = 'Search';
  searchInput.setAttribute('aria-label', 'Search sessions and frames');
  searchInput.value = app._state.sessionSearch || '';
  searchInput.addEventListener('input', (event) => app._onSessionSearchInput(event.target.value));
  searchInput.addEventListener('keydown', (event) => event.stopPropagation());

  // Clearing is a filter control, not a searchbox affordance: one press drops
  // the text query *and* every row in the frame-filter popup.
  let clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'kikx-session-search__clear';
  clear.title = 'Clear all filters';
  clear.setAttribute('aria-label', 'Clear all filters');
  clear.setAttribute('data-search-action', 'clear-filters');
  clear.appendChild(createIcon('circle-x'));
  clear.addEventListener('click', () => app._clearFrameFilters?.());
  clear.hidden = !stateHasFilters(app._state);

  let container = document.createElement('div');
  container.className = 'kikx-session-search';
  container.append(searchInput, clear);

  // Owner item 3 (2026-10-27): "I would like the 'eye' filter to be hugged up next
  // to the 'Search' field, to the right, just next to it (group 'search' items
  // together on the UI)."
  //
  // The eyeball used to live in the trailing `kikx-window__actions`, past the
  // participants popup and `+ Add` -- so the two controls that both narrow
  // visible content sat at opposite ends of the bar. It is now a sibling of the
  // field inside ONE group, which is what makes "search items together" true
  // structurally rather than by eyeballing pixel gaps: there is no element
  // between them that a later change could grow.
  //
  // The ROOT case is the reason this takes `sessionID` at all, and why it does
  // NOT gate the popup on it. The Projects grid is exactly where soft-deleted
  // sessions are listed (see buildTopbarActions' note and
  // kikx-shell-builders.mjs:326-331), so an eyeball that only rendered inside a
  // session would strand "show deleted" on the one screen that needs it. The
  // popup is created on every level; only the participants popup is
  // session-scoped.
  let frameFilter = document.createElement('kikx-frame-filter-popup');
  frameFilter.configure({ app, appState: app._state, sessionID });

  return div.class('kikx-topbar__search-group')(container, frameFilter);
}

// The session-object cluster (User / Account / Agents / Teams / Sign out) USED to
// be built here. Owner point 2 moves it into the session-tree overview pane, so it
// now has exactly one definition, in ./kikx-sidebar-session-objects.mjs, and this
// bar deliberately renders no copy of it: two definitions would be two answers to
// "where does Account live", which is the drift this mission exists to remove.
// The cluster is mounted unconditionally by buildRunnerShell, so all five controls
// have exactly one home and can never appear on neither surface or both.

// Trailing cluster. This is the legacy `kikx-window__actions` content
// (kikx-shell-builders.mjs:314-338) lifted in one piece, so the merge cannot
// silently drop a control that lives only in the second bar.
export function buildTopbarActions(app, sessionID = null) {
  // NOTE: there is deliberately NO `if (!sessionID) return ...` shortcut here.
  // The legacy second bar rendered preview status, the frame-filter eyeball and
  // `+ Add Project` on EVERY level including the root grid, and
  // kikx-shell-builders.mjs:326-331 spells out why the eyeball matters most
  // there: the Projects grid is exactly where soft-deleted sessions are listed,
  // so a root header without it strands "show deleted" on the one screen that
  // needs it. Only the participants popup is genuinely session-scoped.
  let previewSpan = span.class.bindState(
    (state) => `kikx-workspace__status kikx-auth-status--${state.previewsLoading ? 'pending' : 'ready'}`,
    ['previewsLoading', 'previewStatus'],
  )(
    span.textContent.bindState(
      (state) => state.previewsLoading ? 'Loading previews…' : (state.previewStatus || ''),
      ['previewsLoading', 'previewStatus'],
    )(),
  );

  let participants = document.createElement('kikx-participants-popup');
  participants.configure({ app, appState: app._state, sessionID });
  let raw = app._state.rawMarkdown === true;

  return div.class('kikx-window__actions')(
    previewSpan,
    button
      .type('button')
      .class(`kikx-raw-toggle${raw ? ' is-on' : ''}`)
      .title('Show Markdown source with inline formatting (Raw mode)')
      .ariaPressed(raw ? 'true' : 'false')
      .onClick(app._toggleRawMarkdown)('Raw'),
    sessionID ? participants : null,
    // Label from the same scope noun the inline Add card uses, so the two can
    // never disagree about what this level creates.
    button
      .type('button')
      .class('kikx-window__add')
      .title(sessionID ? 'Add a session inside this one' : 'Add a project')
      .onClick(() => app._createSession())(`+ Add ${sessionID ? scopeNounForTopbar(app) : 'Project'}`),
    // Owner point 2: no session-object cluster here -- it lives in the sidebar
    // (./kikx-sidebar-session-objects.mjs). The spacer keeps `justify-content`
    // honest so the trailing actions stay right-aligned when the sidebar owns them.
    span.class('kikx-topbar__spacer')(),
  );
}

// The merged bar: ONE <header> for the whole app - brand, merged back+crumbs,
// centred search, trailing actions - replacing the stacked pair. It carries both
// `kikx-topbar` and `kikx-window__header` so the existing layout rules for each
// still apply and nothing has to be restyled in order to look sane.
//
// Returns a builder; the caller `.build(document)`s it like the legacy header.
export function buildUnifiedTopbar(app) {
  let authed = Boolean(app._state.authToken);
  let entry = getCurrentEntry(app._state);
  let sessionID = authed ? (entry?.sessionID || null) : null;

  return header.class('kikx-topbar kikx-window__header')(
    div.class('kikx-brand')(
      span.class('kikx-brand__mark')('K'),
      div.class('kikx-brand__copy')(h1('Kikx'), p('Agent runner')),
    ),
    // Owner item 1 (2026-10-27): the bar is a grid whose tracks are identical to
    // .kikx-main (app.css:177-181), so column 2 begins exactly where the sidebar
    // ends and the breadcrumb lines up with the sidebar's right edge at every
    // width. That only works if the three remaining children live in column 2 as
    // one row -- as direct grid children they would auto-place the search into
    // column 1 of a second row and reinstate the two-row bar the owner rejected.
    div.class('kikx-topbar__rest')(
      authed ? buildTopbarBreadcrumb(app) : null,
      authed ? buildTopbarSearch(app, sessionID) : null,
      authed ? buildTopbarActions(app, sessionID) : span.class('kikx-topbar__spacer')(),
    ),
  );
}

// The create label's noun comes from state, not from a local copy.
export function scopeNounForTopbar(app) {
  return getScopeNoun(app._state);
}
