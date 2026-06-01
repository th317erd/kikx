'use strict';

import { elements, ReactiveState, $ } from '../lib/aeor-ui.mjs';

const { div, header, main, section, h1, h2, p, span, button, form, label, textarea, ul, li, strong } = elements;
const aeorInput = elements['aeor-input'];
const AUTH_STORAGE_KEY = 'kikx.auth.session';

export class KikxApp extends HTMLElement {
  constructor() {
    super();

    let savedAuth = loadSavedAuth();
    let params = new URLSearchParams(globalThis.location?.search || '');

    this._state = new ReactiveState({
      aeordbEventsURL: '',
      authEmail: '',
      authStatus: '',
      authStatusKind: 'pending',
      authToken: savedAuth.token || '',
      connectionStatus: 'Disconnected',
      connectionStatusKind: 'error',
      draft: '',
      frames: [],
      magicCode: params.get('code') || '',
      refreshToken: savedAuth.refresh_token || '',
      selectedSessionID: '',
      sessions: [],
      status: 'Checking AeorDB event stream...',
      statusKind: 'pending',
    });

    this._onMagicLinkSubmit = this._onMagicLinkSubmit.bind(this);
    this._onSubmit = this._onSubmit.bind(this);
    this._createSession = this._createSession.bind(this);
    this._signOut = this._signOut.bind(this);
  }

  connectedCallback() {
    if (this._mounted)
      return;

    this._mounted = true;
    this._render();
    if (this._state.authToken) {
      this._loadAeorDBEventsURL();
      this._loadSessions();
    } else if (this._state.magicCode) {
      this._verifyMagicLink(this._state.magicCode);
    }
  }

  _render() {
    $(this).empty();

    let shellChildren = [
      header.class('kikx-topbar')(
        div.class('kikx-brand')(
          span.class('kikx-brand__mark')('K'),
          div.class('kikx-brand__copy')(
            h1('Kikx'),
            p('Agent runner'),
          ),
        ),
        this._state.authToken
          ? button.type('button').class('kikx-sign-out-button').onClick(this._signOut)('Sign out')
          : span.class('kikx-topbar__spacer')(),
      ),
      this._state.authToken ? this._buildRunnerShell() : this._buildAuthShell(),
    ];

    if (this._state.authToken)
      shellChildren.push(this._buildStatusBar());

    let tree = div.class('kikx-shell').context(this)(shellChildren).build(document);

    this.appendChild(tree);
  }

  _buildAuthShell() {
    return main.class('kikx-auth-main')(
      section.class('kikx-auth-panel')(
        h2('Sign in'),
        p('Enter your email and AeorDB will send a sign-in link.'),
        div.class.bindState((state) => `kikx-auth-status kikx-auth-status--${state.authStatusKind}`, ['authStatusKind'])(
          span.textContent.bindState((state) => state.authStatus, ['authStatus'])(),
        ),
        form.class('kikx-auth-form').onSubmit(this._onMagicLinkSubmit)(
          label('Email'),
          aeorInput
            .type('email')
            .name('email')
            .placeholder('you@example.com')
            .value.bindState((state) => state.authEmail, ['authEmail'])
            .onInput(this._syncAuthEmail)(),
          button.type('submit').class('kikx-send-button')('Send link'),
        ),
      ),
    );
  }

  _buildRunnerShell() {
    let hasSelectedSession = Boolean(this._state.selectedSessionID);

    return [
      main.class('kikx-main')(
        section.class('kikx-sessions')(
          div.class('kikx-sessions__header')(
            h2('Sessions'),
            button.type('button').class('kikx-icon-button').title('Create session').onClick(this._createSession)('+'),
          ),
          ul.class('kikx-session-list')(
            this._buildSessionItems(),
          ),
        ),
        section.class('kikx-thread')(
          div.class('kikx-thread__header')(
            h2(this._selectedSession()?.title || 'No session'),
          ),
          this._buildFrameThread(),
          form.class('kikx-composer').onSubmit(this._onSubmit)(
            label.class('kikx-composer__label')('Message'),
            textarea
              .name('message')
              .placeholder(hasSelectedSession ? 'Send a message' : 'Create or select a session first')
              .disabled(!hasSelectedSession)
              .value.bindState((state) => state.draft, ['draft'])
              .onInput(this._syncDraft)(),
            div.class('kikx-composer__actions')(
              button.type('submit').class('kikx-send-button').disabled(!hasSelectedSession)('Send'),
            ),
          ),
        ),
      ),
    ];
  }

  _buildStatusBar() {
    return div.class.bindState((state) => `kikx-statusbar kikx-statusbar--${state.connectionStatusKind}`, ['connectionStatusKind'])(
      span.class('kikx-statusbar__dot')(),
      span.textContent.bindState((state) => state.connectionStatus, ['connectionStatus'])(),
    );
  }

  _buildSessionItems() {
    if (this._state.sessions.length === 0) {
      return li.class('kikx-session-list__empty')(
        p('No Sessions.'),
        button.type('button').class('kikx-inline-action').onClick(this._createSession)('+ New Session'),
      );
    }

    return this._state.sessions.map((session) => {
      let selected = session.id === this._state.selectedSessionID;
      let count = selected ? this._state.frames.length : 0;

      return li
        .class(selected ? 'is-selected' : '')
        .onClick(() => this._selectSession(session.id))(
          strong(session.title || session.id),
          span(`${count} frame${count === 1 ? '' : 's'}`),
        );
    });
  }

  _buildFrameThread() {
    if (!this._state.selectedSessionID) {
      return div.class('kikx-thread__empty')(
        p('Create a session to start.'),
        button.type('button').class('kikx-inline-action').onClick(this._createSession)('+ New Session'),
      );
    }

    if (this._state.frames.length === 0) {
      return div.class('kikx-thread__empty')(
        p('No frames yet.'),
      );
    }

    return ul.class('kikx-frame-list')(
      this._state.frames.map((frame) => li.class(`kikx-frame kikx-frame--${frame.type}`)(
        div.class('kikx-frame__meta')(
          strong(frame.type),
          span(frame.authorID || frame.authorType || 'system'),
        ),
        p(frame.content?.text || frame.contentText || frame.id),
      )),
    );
  }

  async _loadAeorDBEventsURL() {
    try {
      let response = await fetch('/api/v1/aeordb/events-url?events=entries_created,entries_updated&path_prefix=/kikx');
      let body = await response.json();
      if (!response.ok)
        throw new Error(body?.error?.message || 'Unable to load AeorDB events URL');

      this._state.aeordbEventsURL = body.data.url;
      this._state.connectionStatus = 'Connected';
      this._state.connectionStatusKind = 'ready';
    } catch (error) {
      this._state.connectionStatus = 'Disconnected';
      this._state.connectionStatusKind = 'error';
      this._state.status = error.message;
      this._state.statusKind = 'error';
    }
  }

  async _loadSessions() {
    try {
      let result = await this._getJSON('/api/v1/sessions');
      this._state.sessions = result.data.sessions || [];

      if (!this._state.selectedSessionID && this._state.sessions.length > 0)
        this._state.selectedSessionID = this._state.sessions[0].id;

      if (this._state.selectedSessionID)
        await this._loadFrames(this._state.selectedSessionID);
      else
        this._render();
    } catch (error) {
      this._state.status = error.message;
      this._state.statusKind = 'error';
      this._render();
    }
  }

  async _loadFrames(sessionID) {
    let result = await this._getJSON(`/api/v1/sessions/${encodeURIComponent(sessionID)}/frames`);
    this._state.frames = result.data.frames || [];
    this._render();
  }

  async _onMagicLinkSubmit(event) {
    event.preventDefault();
    let email = this._state.authEmail.trim();
    if (!email) {
      this._state.authStatus = 'Email is required';
      this._state.authStatusKind = 'error';
      return;
    }

    this._state.authStatus = 'Requesting magic link...';
    this._state.authStatusKind = 'pending';

    try {
      await this._postJSON('/api/v1/auth/magic-link', { email });
      this._state.authStatus = 'If the account exists, AeorDB sent a login link.';
      this._state.authStatusKind = 'ready';
    } catch (error) {
      this._state.authStatus = error.message;
      this._state.authStatusKind = 'error';
    }
  }

  async _verifyMagicLink(code) {
    if (!code) {
      this._state.authStatus = 'Code is required';
      this._state.authStatusKind = 'error';
      return;
    }

    this._state.authStatus = 'Verifying magic link...';
    this._state.authStatusKind = 'pending';

    try {
      let result = await this._getJSON(`/api/v1/auth/magic-link/verify?code=${encodeURIComponent(code)}`);
      this._applyAuth(result.data);
    } catch (error) {
      this._state.authStatus = error.message;
      this._state.authStatusKind = 'error';
    }
  }

  _applyAuth(auth) {
    if (!auth?.token)
      throw new Error('AeorDB did not return an auth token');

    this._state.authToken = auth.token;
    this._state.refreshToken = auth.refresh_token || '';
    this._state.status = 'Signed in';
    this._state.statusKind = 'ready';
    sessionStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(auth));
    this._render();
    this._loadAeorDBEventsURL();
    this._loadSessions();
  }

  _signOut() {
    sessionStorage.removeItem(AUTH_STORAGE_KEY);
    this._state.authToken = '';
    this._state.refreshToken = '';
    this._state.sessions = [];
    this._state.frames = [];
    this._state.selectedSessionID = '';
    this._state.connectionStatus = 'Disconnected';
    this._state.connectionStatusKind = 'error';
    this._state.status = 'Signed out';
    this._state.statusKind = 'pending';
    this._render();
  }

  async _getJSON(url) {
    let response = await fetch(url);
    return readResponse(response);
  }

  async _postJSON(url, body) {
    let response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    return readResponse(response);
  }

  _syncDraft(event) {
    this._state.draft = event.target.value;
  }

  _syncAuthEmail(event) {
    this._state.authEmail = event.target.value;
  }

  async _onSubmit(event) {
    event.preventDefault();
    let draft = this._state.draft.trim();
    if (!draft) {
      this._state.status = 'Write a message before sending';
      this._state.statusKind = 'error';
      return;
    }

    if (!this._state.selectedSessionID) {
      this._state.status = 'Create a session before sending';
      this._state.statusKind = 'error';
      return;
    }

    this._state.status = 'Committing message...';
    this._state.statusKind = 'pending';

    try {
      await this._postJSON(`/api/v1/sessions/${encodeURIComponent(this._state.selectedSessionID)}/messages`, {
        text: draft,
      });
      this._state.draft = '';
      await this._loadFrames(this._state.selectedSessionID);
      this._state.status = 'Message committed';
      this._state.statusKind = 'ready';
      this._render();
    } catch (error) {
      this._state.status = error.message;
      this._state.statusKind = 'error';
      this._render();
    }
  }

  async _createSession() {
    this._state.status = 'Creating session...';
    this._state.statusKind = 'pending';

    try {
      let result = await this._postJSON('/api/v1/sessions', {
        title: 'Scratch',
      });
      this._state.selectedSessionID = result.data.session.id;
      await this._loadSessions();
      this._state.status = 'Session created';
      this._state.statusKind = 'ready';
      this._render();
    } catch (error) {
      this._state.status = error.message;
      this._state.statusKind = 'error';
      this._render();
    }
  }

  async _selectSession(sessionID) {
    this._state.selectedSessionID = sessionID;
    this._state.status = 'Loading session...';
    this._state.statusKind = 'pending';

    try {
      await this._loadFrames(sessionID);
      this._state.status = 'Session loaded';
      this._state.statusKind = 'ready';
      this._render();
    } catch (error) {
      this._state.status = error.message;
      this._state.statusKind = 'error';
      this._render();
    }
  }

  _selectedSession() {
    return this._state.sessions.find((session) => session.id === this._state.selectedSessionID) || null;
  }
}

async function readResponse(response) {
  let body = await response.json();
  if (!response.ok)
    throw new Error(body?.error?.message || `HTTP ${response.status}`);

  return body;
}

function loadSavedAuth() {
  try {
    return JSON.parse(sessionStorage.getItem(AUTH_STORAGE_KEY) || '{}') || {};
  } catch (_error) {
    return {};
  }
}

if (!customElements.get('kikx-app'))
  customElements.define('kikx-app', KikxApp);
