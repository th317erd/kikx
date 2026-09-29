'use strict';

import './kikx-session-card.mjs';
import { previewsBySessionID } from './chat-view-model.mjs';

export class KikxSessionGrid extends HTMLElement {
  constructor() {
    super();
    this._sessions = [];
    this._previews = new Map();
    this._appState = {};
    this._selectedSessionID = '';
    this._loading = false;
    this._error = null;
  }

  connectedCallback() {
    this.classList.add('kikx-session-grid');
    this.setAttribute('role', 'list');
  }

  get previews() {
    return this._previews;
  }

  setPreviews(previews) {
    this._previews = previews instanceof Map ? previews : previewsBySessionID(previews);
    this._paintCards();
  }

  update(input = {}) {
    if (Array.isArray(input.sessions))
      this._sessions = input.sessions;
    if (input.previews instanceof Map)
      this._previews = input.previews;
    else if (Array.isArray(input.previews))
      this._previews = previewsBySessionID(input.previews);
    if (input.appState)
      this._appState = input.appState;
    if (Object.hasOwn(input, 'selectedSessionID'))
      this._selectedSessionID = input.selectedSessionID || '';
    if (Object.hasOwn(input, 'loading'))
      this._loading = input.loading === true;
    if (Object.hasOwn(input, 'error'))
      this._error = input.error;

    this._render();
  }

  setSelected(sessionID) {
    this._selectedSessionID = sessionID || '';
    this._paintCards();
  }

  setPreview(sessionID, preview) {
    this._previews.set(sessionID, preview);
    let card = this._cardFor(sessionID);
    if (card)
      card.update(this._cardInputFor(sessionID));
  }

  _cardFor(sessionID) {
    return Array.from(this.querySelectorAll('kikx-session-card'))
      .find((card) => card.sessionID === sessionID) || null;
  }

  _cardInputFor(sessionID) {
    let session = this._sessions.find((candidate) => candidate.id === sessionID) || null;
    let preview = this._previews.get(sessionID) || null;
    return {
      session: session || preview?.session || null,
      heads: preview?.heads || [],
      truncated: preview?.truncated === true,
      error: preview?.error || null,
      appState: this._appState,
      selected: sessionID === this._selectedSessionID,
    };
  }

  _paintCards() {
    for (let card of this.querySelectorAll('kikx-session-card'))
      card.update(this._cardInputFor(card.sessionID));
  }

  _render() {
    this.textContent = '';

    if (this._error) {
      let error = document.createElement('p');
      error.className = 'kikx-session-grid__status';
      error.textContent = `Could not load sessions: ${this._error}`;
      this.appendChild(error);
      return;
    }

    if (this._sessions.length === 0 && !this._loading) {
      let empty = document.createElement('div');
      empty.className = 'kikx-session-grid__empty';
      let message = document.createElement('p');
      message.textContent = 'No sessions yet.';
      empty.appendChild(message);
      this.appendChild(empty);
      return;
    }

    for (let session of this._sessions) {
      let card = document.createElement('kikx-session-card');
      card.setAttribute('role', 'listitem');
      card.update(this._cardInputFor(session.id));
      this.appendChild(card);
    }

    if (this._loading) {
      let loading = document.createElement('p');
      loading.className = 'kikx-session-grid__status';
      loading.textContent = 'Loading previews…';
      this.appendChild(loading);
    }
  }
}

if (typeof customElements !== 'undefined' && !customElements.get('kikx-session-grid'))
  customElements.define('kikx-session-grid', KikxSessionGrid);
