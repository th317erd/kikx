'use strict';

import { elements, ReactiveState, $ } from '../lib/aeor-ui.mjs';

const { div, header, main, section, h1, h2, h3, p, span, button, form, label, textarea, ul, li, strong } = elements;
const aeorInput = elements['aeor-input'];
const AUTH_STORAGE_KEY = 'kikx.auth.session';

export class KikxApp extends HTMLElement {
  constructor() {
    super();

    let savedAuth = loadSavedAuth();
    let params = new URLSearchParams(globalThis.location?.search || '');

    this._state = new ReactiveState({
      aeordbEventsURL: '',
      apiKey: '',
      authEmail: '',
      authStatus: '',
      authStatusKind: 'pending',
      authToken: savedAuth.token || '',
      draft: '',
      magicCode: params.get('code') || '',
      refreshToken: savedAuth.refresh_token || '',
      status: 'Checking AeorDB event stream...',
      statusKind: 'pending',
    });

    this._onAPIKeySubmit = this._onAPIKeySubmit.bind(this);
    this._onMagicCodeSubmit = this._onMagicCodeSubmit.bind(this);
    this._onMagicLinkSubmit = this._onMagicLinkSubmit.bind(this);
    this._onSubmit = this._onSubmit.bind(this);
  }

  connectedCallback() {
    if (this._mounted)
      return;

    this._mounted = true;
    this._render();
    if (this._state.authToken)
      this._loadAeorDBEventsURL();
    else if (this._state.magicCode)
      this._verifyMagicLink(this._state.magicCode);
  }

  _render() {
    $(this).empty();

    let tree = div.class('kikx-shell').context(this)(
      header.class('kikx-topbar')(
        div.class('kikx-brand')(
          span.class('kikx-brand__mark')('K'),
          div.class('kikx-brand__copy')(
            h1('Kikx'),
            p('Agent runner'),
          ),
        ),
        div.class.bindState((state) => `kikx-status kikx-status--${state.statusKind}`, ['statusKind'])(
          span.class('kikx-status__dot')(),
          span.textContent.bindState((state) => state.status, ['status'])(),
        ),
      ),
      this._state.authToken ? this._buildRunnerShell() : this._buildAuthShell(),
    ).build(document);

    this.appendChild(tree);
  }

  _buildAuthShell() {
    return main.class('kikx-auth-main')(
      section.class('kikx-auth-panel')(
        h2('Sign in'),
        p('Use an AeorDB magic link or exchange an AeorDB API key for a session token.'),
        div.class.bindState((state) => `kikx-auth-status kikx-auth-status--${state.authStatusKind}`, ['authStatusKind'])(
          span.textContent.bindState((state) => state.authStatus, ['authStatus'])(),
        ),
        form.class('kikx-auth-form').onSubmit(this._onMagicLinkSubmit)(
          h3('Magic link'),
          label('Email'),
          aeorInput
            .type('email')
            .name('email')
            .placeholder('you@example.com')
            .value.bindState((state) => state.authEmail, ['authEmail'])
            .onInput(this._syncAuthEmail)(),
          button.type('submit').class('kikx-send-button')('Send link'),
        ),
        form.class('kikx-auth-form').onSubmit(this._onMagicCodeSubmit)(
          h3('Verify code'),
          label('Code'),
          aeorInput
            .type('text')
            .name('code')
            .placeholder('Magic link code')
            .value.bindState((state) => state.magicCode, ['magicCode'])
            .onInput(this._syncMagicCode)(),
          button.type('submit').class('kikx-send-button')('Verify'),
        ),
        form.class('kikx-auth-form').onSubmit(this._onAPIKeySubmit)(
          h3('API key'),
          label('API key'),
          aeorInput
            .type('password')
            .name('api-key')
            .placeholder('aeor_...')
            .value.bindState((state) => state.apiKey, ['apiKey'])
            .onInput(this._syncAPIKey)(),
          button.type('submit').class('kikx-send-button')('Sign in'),
        ),
      ),
    );
  }

  _buildRunnerShell() {
    return [
      main.class('kikx-main')(
        section.class('kikx-sessions')(
          h2('Sessions'),
          ul.class('kikx-session-list')(
            li.class('is-selected')(
              strong('Scratch'),
              span('No frames yet'),
            ),
          ),
        ),
        section.class('kikx-thread')(
          div.class('kikx-thread__header')(
            h2('Scratch'),
            div.class('kikx-thread__tools')(
              button.type('button').class('kikx-icon-button').title('Create session').onClick(this._openCreateSession)(
                '+',
              ),
              button.type('button').class('kikx-sign-out-button').onClick(this._signOut)('Sign out'),
            ),
          ),
          div.class('kikx-thread__empty')(
            p('Frame queue will render here once the store lands.'),
          ),
          form.class('kikx-composer').onSubmit(this._onSubmit)(
            label.class('kikx-composer__label')('Message'),
            textarea
              .name('message')
              .placeholder('Send a message')
              .value.bindState((state) => state.draft, ['draft'])
              .onInput(this._syncDraft)(),
            div.class('kikx-composer__actions')(
              button.type('submit').class('kikx-send-button')('Send'),
            ),
          ),
        ),
      ),
    ];
  }

  async _loadAeorDBEventsURL() {
    try {
      let response = await fetch('/api/v1/aeordb/events-url?events=entries_created,entries_updated&path_prefix=/kikx');
      let body = await response.json();
      if (!response.ok)
        throw new Error(body?.error?.message || 'Unable to load AeorDB events URL');

      this._state.aeordbEventsURL = body.data.url;
      this._state.status = 'AeorDB event stream configured';
      this._state.statusKind = 'ready';
    } catch (error) {
      this._state.status = error.message;
      this._state.statusKind = 'error';
    }
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

  async _onMagicCodeSubmit(event) {
    event.preventDefault();
    await this._verifyMagicLink(this._state.magicCode.trim());
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

  async _onAPIKeySubmit(event) {
    event.preventDefault();
    let apiKey = this._state.apiKey.trim();
    if (!apiKey) {
      this._state.authStatus = 'API key is required';
      this._state.authStatusKind = 'error';
      return;
    }

    this._state.authStatus = 'Signing in...';
    this._state.authStatusKind = 'pending';

    try {
      let result = await this._postJSON('/api/v1/auth/token', { api_key: apiKey });
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
    this._state.apiKey = '';
    this._state.status = 'Signed in';
    this._state.statusKind = 'ready';
    sessionStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(auth));
    this._render();
    this._loadAeorDBEventsURL();
  }

  _signOut() {
    sessionStorage.removeItem(AUTH_STORAGE_KEY);
    this._state.authToken = '';
    this._state.refreshToken = '';
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

  _syncMagicCode(event) {
    this._state.magicCode = event.target.value;
  }

  _syncAPIKey(event) {
    this._state.apiKey = event.target.value;
  }

  _onSubmit(event) {
    event.preventDefault();
    let draft = this._state.draft.trim();
    if (!draft) {
      this._state.status = 'Write a message before sending';
      this._state.statusKind = 'error';
      return;
    }

    this._state.status = 'Message queue is not wired yet';
    this._state.statusKind = 'pending';
  }

  _openCreateSession() {
    let modal = elements['aeor-modal'].title('Create session')(
      p('Session creation will connect once FrameStore lands.'),
    ).build(document);
    modal.addEventListener('close', () => modal.remove());
    modal.open();
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
