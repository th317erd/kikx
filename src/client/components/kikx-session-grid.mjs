'use strict';

import './kikx-session-card.mjs';
import { childSessions, previewsBySessionID } from './chat-view-model.mjs';

export class KikxSessionGrid extends HTMLElement {
  constructor() {
    super();
    this._allSessions = [];
    this._parentSessionID = null;
    this._previews = new Map();
    this._appState = {};
    this._selectedSessionID = '';
    this._loading = false;
    this._error = null;
    this._addLabel = 'Add Session';
    // Session ids with an in-flight soft delete. The app owns the set and hands
    // it in via update() so a full re-render cannot lose the pending state.
    this._deletingSessionIDs = new Set();
  }

  // The grid always lists direct children of parentSessionID. It owns this
  // filter so no caller can accidentally hand it an unfiltered list.
  get _sessions() {
    return childSessions(this._allSessions, this._parentSessionID);
  }

  // Scope-aware label for the leading add card ("Add Project" / "Add Session" /
  // "Add Sub-Session"). Set by the app via update().
  set addLabel(value) {
    this._addLabel = typeof value === 'string' && value.trim() !== '' ? value.trim() : 'Add Session';
  }

  get addLabel() {
    return this._addLabel || 'Add Session';
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
    if (Array.isArray(input.allSessions))
      this._allSessions = input.allSessions;
    else if (Array.isArray(input.sessions))
      this._allSessions = input.sessions;
    if (Object.hasOwn(input, 'parentSessionID'))
      this._parentSessionID = input.parentSessionID || null;
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
    if (Object.hasOwn(input, 'addLabel'))
      this.addLabel = input.addLabel;
    if (input.deletingSessionIDs instanceof Set)
      this._deletingSessionIDs = input.deletingSessionIDs;

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

  cardElement(sessionID) {
    return this._cardFor(sessionID);
  }

  cardViewElement(sessionID) {
    return this._cardFor(sessionID)?.querySelector('kikx-chat-view') || null;
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
      deleting: this._deletingSessionIDs.has(sessionID),
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

    // A leading empty card that creates a new entry at this scope.
    this.appendChild(this._buildAddCard());

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

  _buildAddCard() {
    let card = document.createElement('button');
    card.type = 'button';
    card.className = 'kikx-session-card kikx-session-card--add';
    card.setAttribute('role', 'listitem');
    let label = document.createElement('span');
    label.className = 'kikx-session-card--add__label';
    label.textContent = `+ ${this.addLabel}`;
    card.appendChild(label);
    card.addEventListener('click', () => {
      this.dispatchEvent(new CustomEvent('kikx-card-add', {
        bubbles: true,
        composed: true,
        detail: { parentSessionID: this._parentSessionID },
      }));
    });
    return card;
  }
}

if (typeof customElements !== 'undefined' && !customElements.get('kikx-session-grid'))
  customElements.define('kikx-session-grid', KikxSessionGrid);
