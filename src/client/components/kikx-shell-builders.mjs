'use strict';

import { elements, $ } from '../lib/aeor-ui.mjs';
import { createIcon } from '../lib/icons.mjs';
import { stateHasFilters } from '../lib/frame-filters.mjs';
import { buildScrollLockFloatingButton, buildScrollLockToolbar } from './kikx-scroll-lock.mjs';
import { activateComposerDraftSession } from './composer-drafts.mjs';
import './kikx-composer-history.mjs';
import './kikx-participants-popup.mjs';
import './kikx-frame-filter-popup.mjs';
import { guardClientOperation } from '../lib/error-boundary.mjs';
import { createErrorSurfaceElement } from './kikx-error-surface.mjs';
import { reattachAnswerNotice } from './answer-notice.mjs';
import './kikx-thinking-rack.mjs';
import {
  getCurrentEntry,
  getDeletedSessions,
  getScopeNoun,
  getSelectedFrames,
  getSelectedSession,
  getSessionPreviews,
  getSessions,
  getStackDepth,
  getVisibleSessions,
} from '../state/kikx-state.mjs';
import { hasAnyFrames, threadRenderFrames } from '../state/thinking-state.mjs';
import { childSessions } from './chat-view-model.mjs';
import { formatTokenUsageTotal, hasSessionDeepLink } from './kikx-app-helpers.mjs';
import { countRebuild } from './render-stats.mjs';
import { buildInboxSidebarEntry, buildInboxView } from './kikx-inbox-view.mjs';
import {
  buildActivitiesSidebarEntry,
  buildActivitiesView,
} from './kikx-activities-view.mjs';

const { div, main, nav, section, header, h1, h2, p, span, button, form, input, label, textarea } = elements;
const aeorInput = elements['aeor-input'];

// S1: the app render entry point. A throwing shell builder must never wedge the
// app, so the whole build runs inside the error boundary; on failure the
// previous children are put back so the UI is not left blank.
export function renderAppShell(app) {
  countRebuild('shell');
  let renderSnapshot = app._captureRenderSnapshot();
  if (!app._frameWindowStartFrameID && renderSnapshot.preserveWindowStartFrameID)
    app._frameWindowStartFrameID = renderSnapshot.preserveWindowStartFrameID;
  let previousChildren = Array.from(app.childNodes);

  // If the app currently has no error surface (the very first render, or a
  // previous render that left none), mount a standalone one OUTSIDE the shell
  // before building. A throwing builder must not leave a blank, silent app; on
  // success the shell's own surface supersedes it.
  if (!app.querySelector('kikx-error-surface'))
    app.appendChild(createErrorSurfaceElement());

  let rendered = guardClientOperation('kikx-app.render', () => {
    let shellChildren = [
      header.class('kikx-topbar')(
        div.class('kikx-brand')(
          span.class('kikx-brand__mark')('K'),
          div.class('kikx-brand__copy')(
            h1('Kikx'),
            p('Agent runner'),
          ),
        ),
        app._state.authToken ? app._buildBreadcrumb() : null,
        app._state.authToken
          ? div.class('kikx-topbar__actions')(
            span.class('kikx-account-chip')(app._state.account?.name || 'User'),
            button.type('button').class('kikx-sign-out-button').onClick(app._openAccountEditor)('Account'),
            button.type('button').class('kikx-sign-out-button').onClick(app._openAgentManager)('Agents'),
            button.type('button').class('kikx-sign-out-button').onClick(app._openTeamManager)('Teams'),
            button.type('button').class('kikx-sign-out-button').onClick(app._signOut)('Sign out'),
          )
          : span.class('kikx-topbar__spacer')(),
      ),
      app._state.authToken
        ? (hasSessionDeepLink() && app._deepLinkReady !== true
          ? buildStartupLoading()
          : app._buildRunnerShell())
        : app._buildAuthShell(),
    ];

    if (app._state.authToken)
      shellChildren.push(app._buildStatusBar());

    if (app._state.editingSessionID)
      shellChildren.push(app._buildSessionEditor());

    if (app._state.accountEditorOpen)
      shellChildren.push(app._buildAccountEditor());

    if (app._state.managingAgents)
      shellChildren.push(app._buildAgentManager());

    if (app._state.agentEditorOpen)
      shellChildren.push(app._buildAgentEditor());

    if (app._state.managingTeams)
      shellChildren.push(app._buildTeamManager());

    if (app._state.teamEditorOpen)
      shellChildren.push(app._buildTeamEditor());

    shellChildren.push(createErrorSurfaceElement());

    let tree = div.class('kikx-shell').context(app)(shellChildren).build(document);

    // Only touch the live DOM once the whole new shell built successfully; a
    // throwing builder must leave the previous DOM and its bindings untouched.
    app._disconnectFrameListObserver();
    app._cleanupReactiveBindings();
    $(app).empty();

    app.appendChild(tree);
    // The rebuild above emptied the app element. The answer notice is mounted
    // beside the app rather than inside it for exactly that reason, but a view
    // swap can replace the parent too; re-attach from the live node so a
    // confirmation on screen when the send resolved is not silently dropped.
    reattachAnswerNotice(app);
    app._afterRender(renderSnapshot);
    activateComposerDraftSession(app, app._state.selectedSessionID).catch((error) => {
      app._state.status = error.message;
      app._state.statusKind = 'error';
    });
    return true;
  }, { sessionID: app._state.selectedSessionID });

  if (!rendered) {
    if (app.childNodes.length === 0) {
      for (let child of previousChildren)
        app.appendChild(child);
    }

    // First-render (or post-teardown) failure: nothing survived to show the
    // error, so mount a standalone surface now.
    if (!app.querySelector('kikx-error-surface'))
      app.appendChild(createErrorSurfaceElement());
  }
}

export function buildStartupLoading() {
  return main.class('kikx-startup-loading').ariaBusy('true')(
    section.class('kikx-startup-loading__panel').role('status').ariaLive('polite')(
      div.class('kikx-startup-loading__spinner').ariaHidden('true')(),
      h2('Loading session'),
      p('Restoring messages and scroll position…'),
      div.class('kikx-startup-loading__track').ariaHidden('true')(
        span.class('kikx-startup-loading__fill')(),
      ),
    ),
  );
}

export function buildAuthShell(app) {
  return main.class('kikx-auth-main')(
    section.class('kikx-auth-panel')(
      h2('Sign in'),
      p('Enter your email and AeorDB will send a sign-in link.'),
      div.class.bindState((state) => `kikx-auth-status kikx-auth-status--${state.authStatusKind}`, ['authStatusKind'])(
        span.textContent.bindState((state) => state.authStatus, ['authStatus'])(),
      ),
      form.class('kikx-auth-form').onSubmit(app._onMagicLinkSubmit)(
        label('Email'),
        aeorInput
          .type('email')
          .name('email')
          .placeholder('you@example.com')
          .value.bindState((state) => state.authEmail, ['authEmail'])
          .onInput(app._syncAuthEmail)(),
        button.type('submit').class('kikx-send-button')('Send link'),
      ),
    ),
  );
}

export function buildBreadcrumb(app) {
  let stack = app._state.navigationStack || [];
  let crumbs = [];

  crumbs.push({
    label: 'Projects',
    depth: 1,
    active: stack.length === 1,
  });

  for (let index = 1; index < stack.length; index++) {
    let entry = stack[index];
    let session = getSessions(app._state).find((candidate) => candidate.id === entry.sessionID);
    let label = session?.title || (entry.sessionID ? String(entry.sessionID).slice(0, 8) : 'Session');
    crumbs.push({
      label,
      sessionTitle: session?.title || '',
      sessionID: entry.sessionID,
      depth: index + 1,
      active: index === stack.length - 1,
    });
  }

  return nav.class('kikx-breadcrumb').ariaLabel('Session navigation')(
    crumbs.flatMap((crumb, index) => {
      let nodes = [];
      if (index > 0)
        nodes.push(span.class('kikx-breadcrumb__sep')('›'));
      nodes.push(buildBreadcrumbCrumb(app, crumb));
      return nodes;
    }),
  );
}

// The breadcrumb is a navigation control: every crumb (including the active
// one) navigates to that depth. Renaming happens on the window header title,
// which is where users expect to click.
export function buildBreadcrumbCrumb(app, crumb) {
  if (crumb.active)
    return span.class('kikx-breadcrumb__crumb kikx-breadcrumb__crumb--active')(crumb.label);

  return button.type('button').class('kikx-breadcrumb__crumb').onClick(() => app._navigateToDepth(crumb.depth))(crumb.label);
}

// Editable window title: click the session name to rename it in place. This is
// the prominent title; the breadcrumb stays purely navigational.
export function buildEditableTitle(app, title, sessionID) {
  if (!sessionID)
    return h2(title);

  if (app._state.editingSessionNameID === sessionID) {
    // A native input: aeor-input does not re-dispatch keydown/focusout, which
    // this inline editor needs for Enter/Escape and click-away commit.
    return input
      .type('text')
      .class('kikx-window__title-input')
      .name('session-name')
      .value(app._state.editingSessionNameValue || '')
      .onInput((event) => { app._state.editingSessionNameValue = event.target.value; })
      .onKeydown((event) => app._onSessionNameKeydown(event, sessionID))
      .onFocusout(() => app._commitSessionName(sessionID))();
  }

  return button
    .type('button')
    .class('kikx-window__title kikx-window__title--editable')
    .title('Rename session')
    .onClick(() => app._beginSessionNameEdit(sessionID, title))(title);
}

export function buildRunnerShell(app) {
  let entry = getCurrentEntry(app._state);
  // A view entry displaces the work area; the stack decides which one is on top
  // (plan §6: Inbox, §6.4: Activities).
  let viewName = entry.view || null;

  return [
    main.class('kikx-main')(
      section.class('kikx-sessions')(
        div.class('kikx-sessions__header')(
          h2('Workspace'),
        ),
        // Pinned at the top of the sidebar header (plan §6.1): the Inbox is the
        // one thing that must be visible from anywhere, above the project tree.
        buildInboxSidebarEntry(app),
        // Activities sits directly under it (§6.4): the same glance-then-drill
        // relationship, one level out from the questions themselves.
        buildActivitiesSidebarEntry(app),
      ),
      // A view replaces the work area while it is the top stack entry; Back pops
      // to whatever window was underneath.
      viewName === 'inbox'
        ? buildInboxView(app)
        : (viewName === 'activities' ? buildActivitiesView(app) : buildWindow(app, entry)),
    ),
  ];
}

// The work area. The root renders the project grid; an entered session renders
// its own thread, and its children render inside that same window. There is no
// second surface a session can switch into, so there is no state in which the
// children are reachable and the conversation is not.
export function buildWindow(app, entry) {
  let sessionID = entry.sessionID;

  if (!sessionID)
    return buildWorkspaceGrid(app);

  return buildThreadSection(app, sessionID);
}

export function scopeNoun(app) {
  return getScopeNoun(app._state);
}

// One window header for every level. The root grid has no Close; a nested
// session window always offers Close (minimize / pop).
//
// Creating is not a mode, so it is not behind a view switch: every level carries
// the same create button, immediately to the right of the eyeball. The eye
// narrows what you are already looking at; this adds to where you are.
export function buildWindowHeader(app, { title, sessionID = null } = {}) {
  let nested = getStackDepth(app._state) > 1;
  let backButton = nested
    ? button
      .type('button')
      .class('kikx-icon-button kikx-window__close')
      .title('Close session')
      .ariaLabel('Close session')
      .onClick(app._minimizeCurrent)(createIcon('chevron-left'))
    : null;

  return div.class('kikx-window__header')(
    div.class('kikx-window__lead')(
      backButton,
      buildBreadcrumbTitle(app, title, sessionID),
      sessionID ? buildScrollLockToolbar(app, sessionID) : null,
    ),
    buildSessionSearch(app),
    div.class('kikx-window__actions')(
      span.class.bindState((state) => `kikx-workspace__status kikx-auth-status--${state.previewsLoading ? 'pending' : 'ready'}`, ['previewsLoading', 'previewStatus'])(
        span.textContent.bindState((state) => state.previewsLoading ? 'Loading previews…' : (state.previewStatus || ''), ['previewsLoading', 'previewStatus'])(),
      ),
      sessionID ? buildParticipantsPopup(app, sessionID) : null,
      // One eyeball on every level, including the root Projects grid. The popup
      // is where "show deleted" now lives, and the grid is exactly where
      // soft-deleted sessions are listed, so a header without it would strand
      // that control on the one screen that needs it.
      buildFrameFilterPopup(app, sessionID),
      // The label comes from the same scope noun the inline Add card uses, so the
      // two can never disagree about what this level creates. A hardcoded
      // "Add Session" would contradict the card's "Add Sub-Session" two levels in.
      // The root takes its label from the level itself rather than the ambient
      // depth: the root entry is always the bottom of the stack, but a header
      // should not change its own name because of where the stack happens to be.
      button
        .type('button')
        .class('kikx-window__add')
        .title(sessionID ? 'Add a session inside this one' : 'Add a project')
        .onClick(() => app._createSession())(`+ Add ${sessionID ? scopeNoun(app) : 'Project'}`),
    ),
  );
}

// 3x3 dot grid glyph, drawn as an inline SVG so no external asset or font is
// required. No longer rendered: the header's frame-filter popup replaced the
// grid-of-dots sub-session toggle. Kept (with buildGridIcon's spec) until the
// renderQuestionCard cleanup lands, so this change stays reviewable on its own.
export function buildGridIcon() {
  let size = 3;
  let step = 4;
  let dot = 2.2;
  let span = (size - 1) * step + dot;
  let svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${span} ${span}`);
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.classList.add('kikx-grid-icon');

  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) {
      let rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('x', String(column * step));
      rect.setAttribute('y', String(row * step));
      rect.setAttribute('width', String(dot));
      rect.setAttribute('height', String(dot));
      svg.appendChild(rect);
    }
  }

  return svg;
}

export function buildFrameFilterPopup(app, sessionID) {
  let popup = document.createElement('kikx-frame-filter-popup');
  popup.configure({
    app,
    appState: app._state,
    sessionID,
  });
  return popup;
}

export function buildParticipantsPopup(app, sessionID) {
  let popup = document.createElement('kikx-participants-popup');
  popup.configure({
    app,
    appState: app._state,
    sessionID,
  });
  return popup;
}

export function buildWorkspaceGrid(app) {
  return section.class('kikx-workspace')(
    buildWindowHeader(app, { title: 'Projects' }),
    buildSessionGrid(app, null),
  );
}

// The inline child-session row. It reuses the project grid narrowed by
// parentSessionID, so children need no component and no view of their own.
export function buildChildSessionsRegion(app, sessionID) {
  return div.class('kikx-thread__children')(buildSessionGrid(app, sessionID));
}

export function buildSessionGrid(app, parentSessionID) {
  let grid = document.createElement('kikx-session-grid');
  // getVisibleSessions applies the title filter and (while the eye is on) the
  // soft-deleted bucket; childSessions inside the grid narrows to this level.
  let visible = getVisibleSessions(app._state);
  let deletedSessionIDs = new Set(getDeletedSessions(app._state).map((session) => session.id));
  grid.update({
    allSessions: visible,
    parentSessionID,
    previews: getSessionPreviews(app._state),
    appState: app._state,
    selectedSessionID: app._state.selectedSessionID,
    loading: app._state.previewsLoading,
    addLabel: `Add ${scopeNoun(app)}`,
    deletingSessionIDs: app._deletingSessionIDs,
    deletedSessionIDs,
  });
  grid.addEventListener('kikx-card-open', (event) => {
    if (event.detail?.sessionID)
      app._openSessionFromCard(event.detail.sessionID);
  });
  grid.addEventListener('kikx-card-add', () => app._createSession());
  grid.addEventListener('kikx-card-delete', (event) => {
    if (event.detail?.sessionID)
      app._deleteSession(event.detail.sessionID);
  });
  grid.addEventListener('kikx-card-restore', (event) => {
    if (event.detail?.sessionID)
      app._restoreSession(event.detail.sessionID);
  });
  return div.class('kikx-workspace__grid')(grid);
}

// The centered session-workspace controls: a title filter. Placed in the window
// header (decision A: the search takes the header center; the editable name
// relocates to the breadcrumb's active crumb).
//
// The floating eye that used to sit here is gone: "show deleted" moved into the
// frame-filter popup, so there is one idiom for every kind of visibility rather
// than a second control bolted onto the search field.
export function buildSessionSearch(app) {
  let input = document.createElement('input');
  input.type = 'search';
  input.className = 'kikx-session-search__input';
  input.name = 'session-search';
  input.placeholder = 'Search';
  input.setAttribute('aria-label', 'Search sessions and frames');
  input.value = app._state.sessionSearch || '';
  input.addEventListener('input', (event) => app._onSessionSearchInput(event.target.value));
  input.addEventListener('keydown', (event) => event.stopPropagation());

  // Clearing is a filter control, not a searchbox affordance: one press has to
  // drop the text query *and* every row in the frame-filter popup, so a person
  // never has to hunt through a menu to get back to "show me everything".
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
  container.append(input, clear);
  return container;
}

// The editable session name, relocated off the header center. Click to rename;
// an inline input while editing. Returns an h2 for non-session headers.
export function buildBreadcrumbTitle(app, title, sessionID) {
  if (!sessionID)
    return h2(title);

  if (app._state.editingSessionNameID === sessionID) {
    return input
      .type('text')
      .class('kikx-breadcrumb__title-input')
      .name('session-name')
      .value(app._state.editingSessionNameValue || '')
      .onInput((event) => { app._state.editingSessionNameValue = event.target.value; })
      .onKeydown((event) => app._onSessionNameKeydown(event, sessionID))
      .onFocusout(() => app._commitSessionName(sessionID))();
  }

  return button
    .type('button')
    .class('kikx-breadcrumb__title')
    .title('Rename session')
    .onClick(() => app._beginSessionNameEdit(sessionID, title))(title);
}

export function buildThreadSection(app, sessionID) {
  let hasSelectedSession = Boolean(sessionID);

  // Pinned to the lower-left (participant space): per-agent "thinking" panels,
  // so the thread never grows/collapses as an agent streams.
  let thinkingRack = document.createElement('kikx-thinking-rack');
  let composerHistory = document.createElement('kikx-composer-history');
  composerHistory.configure({ app, sessionID });
  let historyChevron = createIcon('chevron-left');
  historyChevron.classList.add('kikx-composer-history-button__chevron');

  return section.class('kikx-thread')(
    buildWindowHeader(app, {
      title: app._selectedSession()?.title || 'No session',
      sessionID,
    }),
    // Child sessions belong to this window, so they render inside it: one row of
    // cards between the header and the thread, with its Add card in the same row.
    // They are not a separate view you travel to and back from -- the grid-of-dots
    // toggle made them exactly that, and it offered no route back to this thread.
    // The row is always rendered for a session, because its Add card is the inline
    // route to creating a child; hiding it on a childless session would hide
    // creation itself.
    sessionID ? buildChildSessionsRegion(app, sessionID) : null,
    div.class('kikx-thread__body')(
      buildFrameThread(app),
      sessionID ? buildScrollLockFloatingButton(app, sessionID) : null,
    ),
    div.class('kikx-thinking-dock')(
      thinkingRack,
    ),
    form.class('kikx-composer').onSubmit(app._onSubmit)(
      composerHistory,
      div.class('kikx-composer__input-row')(
        button
          .type('button')
          .class('kikx-composer-history-button')
          .title('Message history (Ctrl+R)')
          .ariaLabel('Message history')
          .disabled(!hasSelectedSession)
          .onClick(() => app._toggleComposerHistory?.())(historyChevron),
        textarea
          .name('message')
          .placeholder(hasSelectedSession ? 'Send a message' : 'Create or select a session first')
          .disabled(!hasSelectedSession)
          .onKeydown(app._onComposerKeydown)
          .onInput(app._syncDraft)(app._activeComposerDraftSessionID === sessionID ? app._state.draft : ''),
        div.class('kikx-composer__actions')(
          button
            .type('button')
            .class('kikx-stop-button')
            .title('Cancel all active agents in this session')
            .ariaLabel('Stop all active agents')
            .onClick(() => app._cancelAgents?.())( 'STOP'),
          button
            .type('submit')
            .class('kikx-send-button')
            .title('Send message (Enter). Shift+Enter inserts a new line.')
            .ariaLabel('Send message')
            .disabled(!hasSelectedSession)('Send (Enter)'),
        ),
      ),
    ),
  );
}

export function buildStatusBar(app) {
  return div.class.bindState((state) => `kikx-statusbar kikx-statusbar--${state.connectionStatusKind}`, ['connectionStatusKind'])(
    span.class('kikx-statusbar__dot')(),
    span.textContent.bindState((state) => state.connectionStatus, ['connectionStatus'])(),
    span.class('kikx-statusbar__spacer')(),
    button
      .type('button')
      .class(`kikx-debug-toggle${app._state.debugMode === true ? ' is-on' : ''}`)
      .ariaPressed(app._state.debugMode === true ? 'true' : 'false')
      .title('Toggle client debug mode')
      .onClick(app._toggleDebugMode)('Debug'),
    span
      .class('kikx-statusbar__tokens')
      .title('Total tracked tokens')
      .textContent.bindState((state) => formatTokenUsageTotal(state.totalTokensUsed), ['totalTokensUsed'])(),
  );
}

// Always returns a built ELEMENT — never a builder. Callers use the result both
// as a DOM node (body.replaceChildren(...)) and as a builder child (the DSL
// passes pre-built nodes through unchanged), so the previous mixed return type
// (a builder for some branches, an element for others) broke both call styles.

// The one real way out of an empty thread. Calls the app handler that is
// already bound (kikx-app.mjs:245) - no new plumbing, no second render path.
function clearFrameFiltersAction(app) {
  return button.type('button').class('kikx-inline-action')
    .onClick(() => app._clearFrameFilters?.())('Show all frames');
}

export function buildFrameThread(app) {
  if (!app._state.selectedSessionID) {
    return div.class('kikx-thread__empty')(
      p('Create a session to start.'),
      button.type('button').class('kikx-inline-action').onClick(app._createSession)('+ New Session'),
    ).build(document);
  }

  let allFrames = getSelectedFrames(app._state);
  let frames = threadRenderFrames(allFrames, app._state.frameFilters)
    .filter((frame) => frame && !frame.deleted);
  if (frames.length === 0) {
    // A failed load leaves no frames behind, so this state used to fall through
    // to "No messages yet" and tell the user the session was empty when in fact
    // it could not be read at all. The statusline is easy to miss, so say it
    // here and offer a real way out.
    if (app._state.statusKind === 'error') {
      return div.class('kikx-thread__empty kikx-thread__empty--error')(
        p('This session could not be loaded: ' + (app._state.status || 'unknown error')),
        p.class('kikx-thread__empty-hint')('Nothing was lost - the frames are still stored. Showing all frames loads whatever did read successfully.'),
        clearFrameFiltersAction(app),
      ).build(document);
    }

    // Frames exist but every filter is off: say so, rather than claiming the
    // session is empty. A real control, not a sentence pointing at the header
    // popup - prose is not an affordance, and this state previously offered the
    // user nothing to press.
    if (hasAnyFrames(allFrames)) {
      return div.class('kikx-thread__empty kikx-thread__empty--filtered')(
        p('No frames match the current filters.'),
        p.class('kikx-thread__empty-hint')('Every frame in this session is currently filtered out.'),
        clearFrameFiltersAction(app),
      ).build(document);
    }

    return div.class('kikx-thread__empty')(
      p('No messages yet.'),
      p.class('kikx-thread__empty-hint')("Type /invite 'name of party' to invite an agent, or other party"),
    ).build(document);
  }

  return createChatViewElement(app, frames);
}

export function createChatViewElement(app, frames, mode = 'full') {
  let view = document.createElement('kikx-chat-view');
  view.mode = mode;
  let startFrameID = app._frameWindowStartFrameID;
  let startIndex = startFrameID ? frames.findIndex((frame) => frame?.id === startFrameID) : -1;
  app._frameWindowStartFrameID = null;
  view.update({
    frames,
    appState: app._state,
    windowStart: startIndex >= 0 ? startIndex : undefined,
  });
  return view;
}

export function createFrameItemElement(app, frame) {
  let item = document.createElement('kikx-frame-item');
  item.updateFrame(frame, app._state);
  return item;
}
