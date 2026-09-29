'use strict';

import './kikx-chat-view.mjs';
import { sessionCardLabel, sessionCardMeta } from './chat-view-model.mjs';

function createCardShell() {
  let root = document.createElement('article');
  root.className = 'kikx-session-card';

  let header = document.createElement('header');
  header.className = 'kikx-session-card__header';
  let title = document.createElement('strong');
  title.className = 'kikx-session-card__title';
  let meta = document.createElement('span');
  meta.className = 'kikx-session-card__meta';
  header.append(title, meta);

  let body = document.createElement('div');
  body.className = 'kikx-session-card__body';

  let view = document.createElement('kikx-chat-view');
  view.mode = 'mini';
  body.appendChild(view);

  let status = document.createElement('p');
  status.className = 'kikx-session-card__status';
  status.hidden = true;

  root.append(header, body, status);

  return { root, title, meta, view, status, body };
}

export class KikxSessionCard extends HTMLElement {
  constructor() {
    super();
    this._session = null;
    this._heads = [];
    this._appState = {};
    this._error = null;
    this._truncated = false;
    this._selected = false;
    this._shell = null;
  }

  get sessionID() {
    return this._session?.id || '';
  }

  connectedCallback() {
    if (!this._shell)
      this._build();
  }

  _build() {
    this.textContent = '';
    this._shell = createCardShell();
    this._shell.root.tabIndex = 0;
    this._shell.root.setAttribute('role', 'button');
    this._shell.root.addEventListener('click', () => this._emitOpen());
    this._shell.root.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        this._emitOpen();
      }
    });
    this.appendChild(this._shell.root);
    this._paint();
  }

  _emitOpen() {
    if (!this.sessionID)
      return;

    this.dispatchEvent(new CustomEvent('kikx-card-open', {
      bubbles: true,
      composed: true,
      detail: { sessionID: this.sessionID },
    }));
  }

  update(input = {}) {
    if (Object.hasOwn(input, 'session'))
      this._session = input.session;
    if (Array.isArray(input.heads))
      this._heads = input.heads;
    if (input.appState)
      this._appState = input.appState;
    if (Object.hasOwn(input, 'error'))
      this._error = input.error;
    if (Object.hasOwn(input, 'truncated'))
      this._truncated = input.truncated === true;
    if (Object.hasOwn(input, 'selected'))
      this._selected = input.selected === true;

    if (!this._shell)
      this._build();
    else
      this._paint();
  }

  _paint() {
    let shell = this._shell;
    if (!shell)
      return;

    let session = this._session;
    shell.title.textContent = sessionCardLabel(session);
    shell.meta.textContent = sessionCardMeta(session, this._heads, this._truncated);
    // Stable accessible name: the session title only, not the preview text.
    shell.root.setAttribute('aria-label', sessionCardLabel(session));

    shell.root.classList.toggle('is-selected', this._selected);
    shell.root.setAttribute('aria-pressed', this._selected ? 'true' : 'false');

    shell.view.update({ frames: this._heads, appState: this._appState });

    if (this._error) {
      shell.status.hidden = false;
      shell.status.textContent = 'Preview unavailable';
      shell.root.classList.add('has-error');
    } else {
      shell.status.hidden = true;
      shell.status.textContent = '';
      shell.root.classList.remove('has-error');
    }
  }
}

if (typeof customElements !== 'undefined' && !customElements.get('kikx-session-card'))
  customElements.define('kikx-session-card', KikxSessionCard);
