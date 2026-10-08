'use strict';

import { elements, $ } from '../lib/aeor-ui.mjs';
import { guardClientOperation } from '../lib/error-boundary.mjs';
import { createErrorSurfaceElement } from './kikx-error-surface.mjs';
import {
  getCurrentEntry,
  getScopeNoun,
  getSelectedFrames,
  getSelectedSession,
  getSessions,
  getSessionPreviews,
  getStackDepth,
} from '../state/kikx-state.mjs';
import { childSessions } from './chat-view-model.mjs';
import { formatTokenUsageTotal } from './kikx-app-helpers.mjs';
import { countRebuild } from './render-stats.mjs';

const { div, main, nav, section, header, h1, h2, p, span, button, form, input, label, textarea } = elements;
const aeorInput = elements['aeor-input'];

// S1: the app render entry point. A throwing shell builder must never wedge the
// app, so the whole build runs inside the error boundary; on failure the
// previous children are put back so the UI is not left blank.
export function renderAppShell(app) {
  countRebuild('shell');
  let renderSnapshot = app._captureRenderSnapshot();
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
      app._state.authToken ? app._buildRunnerShell() : app._buildAuthShell(),
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
    app._afterRender(renderSnapshot);
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
    if (entry.collapsed)
      label += ' (sub-sessions)';
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
  let collapsed = entry.collapsed === true;

  return [
    main.class('kikx-main')(
      section.class('kikx-sessions')(
        div.class('kikx-sessions__header')(
          h2('Workspace'),
        ),
      ),
      buildWindow(app, entry, collapsed),
    ),
  ];
}

// The unified work area: a maximized session over its parent, or the grid of
// children when collapsed. One container; the stack decides what is on top.
export function buildWindow(app, entry, collapsed) {
  let sessionID = entry.sessionID;

  if (!sessionID)
    return buildWorkspaceGrid(app);

  return collapsed
    ? buildChildGrid(app, sessionID)
    : buildThreadSection(app, sessionID);
}

export function scopeNoun(app) {
  return getScopeNoun(app._state);
}

// One window header for every level. The root grid has no Close; a nested
// session window always offers Close (minimize / pop). A session window also
// has a toggle between its chat and its sub-session grid. Add lives in the
// grid as a leading "Add" card, not in this header.
export function buildWindowHeader(app, { title, sessionID = null, collapsed = false } = {}) {
  let nested = getStackDepth(app._state) > 1;
  let backButton = nested
    ? button
      .type('button')
      .class('kikx-icon-button kikx-window__close')
      .title('Close session')
      .ariaLabel('Close session')
      .onClick(app._minimizeCurrent)('‹')
    : null;

  return div.class('kikx-window__header')(
    backButton,
    buildEditableTitle(app, title, sessionID),
    div.class('kikx-window__actions')(
      span.class.bindState((state) => `kikx-workspace__status kikx-auth-status--${state.previewsLoading ? 'pending' : 'ready'}`, ['previewsLoading', 'previewStatus'])(
        span.textContent.bindState((state) => state.previewsLoading ? 'Loading previews…' : (state.previewStatus || ''), ['previewsLoading', 'previewStatus'])(),
      ),
      sessionID
        ? button
          .type('button')
          .class(`kikx-sign-out-button kikx-window__view-toggle${collapsed ? ' is-active' : ''}`)
          .ariaPressed(collapsed ? 'true' : 'false')
          .title(collapsed ? 'Show all chat messages' : 'Show only sub-sessions')
          .onClick(app._toggleSubSessions)(
            buildGridIcon(),
            ` (${childSessionsFor(app, sessionID).length})`,
          )
        : null,
    ),
  );
}

// 6x6 grid glyph for the sub-session filter toggle, drawn as an inline SVG so
// no external asset or font is required.
export function buildGridIcon() {
  let size = 6;
  let step = 2;
  let dot = 1.1;
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

export function buildChildGrid(app, parentSessionID) {
  return section.class('kikx-workspace')(
    buildWindowHeader(app, {
      title: childGridTitle(app, parentSessionID),
      sessionID: parentSessionID,
      collapsed: true,
    }),
    buildSessionGrid(app, parentSessionID),
  );
}

export function buildWorkspaceGrid(app) {
  return section.class('kikx-workspace')(
    buildWindowHeader(app, { title: 'Projects' }),
    buildSessionGrid(app, null),
  );
}

export function childGridTitle(app, parentSessionID) {
  return getSelectedSession(app._state)?.title || `Session ${String(parentSessionID).slice(0, 8)}`;
}

export function childSessionsFor(app, parentSessionID) {
  return childSessions(getSessions(app._state), parentSessionID);
}

export function buildSessionGrid(app, parentSessionID) {
  let grid = document.createElement('kikx-session-grid');
  grid.update({
    allSessions: getSessions(app._state),
    parentSessionID,
    previews: getSessionPreviews(app._state),
    appState: app._state,
    selectedSessionID: app._state.selectedSessionID,
    loading: app._state.previewsLoading,
    addLabel: `Add ${scopeNoun(app)}`,
    deletingSessionIDs: app._deletingSessionIDs,
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
  return div.class('kikx-workspace__grid')(grid);
}

export function buildThreadSection(app, sessionID) {
  let hasSelectedSession = Boolean(sessionID);

  return section.class('kikx-thread')(
    buildWindowHeader(app, {
      title: app._selectedSession()?.title || 'No session',
      sessionID,
      collapsed: false,
    }),
    div.class('kikx-thread__body')(
      buildFrameThread(app),
    ),
    form.class('kikx-composer').onSubmit(app._onSubmit)(
      label.class('kikx-composer__label')('Message'),
      textarea
        .name('message')
        .placeholder(hasSelectedSession ? 'Send a message' : 'Create or select a session first')
        .disabled(!hasSelectedSession)
        .onKeydown(app._onComposerKeydown)
        .onInput(app._syncDraft)(app._state.draft),
      div.class('kikx-composer__actions')(
        button.type('submit').class('kikx-send-button').disabled(!hasSelectedSession)('Send'),
      ),
    ),
  );
}

export function buildStatusBar(app) {
  return div.class.bindState((state) => `kikx-statusbar kikx-statusbar--${state.connectionStatusKind}`, ['connectionStatusKind'])(
    span.class('kikx-statusbar__dot')(),
    span.textContent.bindState((state) => state.connectionStatus, ['connectionStatus'])(),
    span.class('kikx-statusbar__spacer')(),
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
export function buildFrameThread(app) {
  if (!app._state.selectedSessionID) {
    return div.class('kikx-thread__empty')(
      p('Create a session to start.'),
      button.type('button').class('kikx-inline-action').onClick(app._createSession)('+ New Session'),
    ).build(document);
  }

  let frames = getSelectedFrames(app._state).filter((frame) => frame && !frame.deleted && !frame.hidden);
  if (frames.length === 0) {
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
  view.update({ frames, appState: app._state });
  return view;
}

export function createFrameItemElement(app, frame) {
  let item = document.createElement('kikx-frame-item');
  item.updateFrame(frame, app._state);
  return item;
}
