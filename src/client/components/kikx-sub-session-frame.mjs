'use strict';

import './kikx-session-card.mjs';

// Renders a tool/frame result that declares a session reference
// (content.references [{ type:'session', id, ... }]) as a live mini card.
// Clicking it (or the card's own open event) enters that session.
export class KikxSubSessionFrame extends HTMLElement {
  constructor() {
    super();
    this._frame = null;
    this._appState = {};
    this._card = null;
  }

  set appState(value) {
    this._appState = value || {};
    if (this._card)
      this._card.update({ appState: this._appState });
  }

  set frame(value) {
    this.updateFrame(value, this._appState);
  }

  updateFrame(frame, appState = {}) {
    this._frame = frame || null;
    this._appState = appState || {};
    this._render();
  }

  connectedCallback() {
    if (this._frame && this.childNodes.length === 0)
      this._render();
  }

  _render() {
    this.textContent = '';
    let reference = sessionReferenceFromFrame(this._frame);
    if (!reference) {
      this._card = null;
      let fallback = document.createElement('p');
      fallback.className = 'kikx-sub-session-frame__missing';
      fallback.textContent = this._frame?.content?.preview || 'No session reference.';
      this.appendChild(fallback);
      return;
    }

    this.className = 'kikx-sub-session-frame';
    this._card = document.createElement('kikx-session-card');
    this._card.classList.add('kikx-session-card--embedded');
    this._card.addEventListener('kikx-card-open', (event) => {
      event.stopPropagation();
      this._emitEnter(reference.id);
    });
    this.appendChild(this._card);
    this._paintFromState(this._appState);
  }

  get sessionID() {
    return sessionReferenceFromFrame(this._frame)?.id || '';
  }

  // Refresh an embedded child card in place from the parent app state. Live
  // child-session frame events update appState.framesBySessionID, and preview
  // fetches update sessionPreviewsByID; this card owns neither source.
  refreshFromState(appState = this._appState, onlySessionID = '') {
    if (!this._card)
      return;

    let reference = sessionReferenceFromFrame(this._frame);
    if (!reference || (onlySessionID && onlySessionID !== reference.id))
      return;

    this._appState = appState || {};
    this._paintFromState(this._appState);
  }

  _paintFromState(appState = {}) {
    let reference = sessionReferenceFromFrame(this._frame);
    if (!reference || !this._card)
      return;

    let preview = appState.sessionPreviewsByID?.[reference.id] || null;
    let session = appState.sessionDetailsByID?.[reference.id] || preview?.session || {
      id: reference.id,
      title: reference.title,
      parentSessionID: reference.parentSessionID,
      messageCount: reference.messageCount,
      createdAt: reference.createdAt,
      updatedAt: reference.updatedAt,
    };
    let liveFrames = appState.framesBySessionID?.[reference.id];
    let heads = Array.isArray(liveFrames) && liveFrames.length > 0
      ? liveFrames.slice(-6)
      : (Array.isArray(preview?.heads) && preview.heads.length > 0
        ? preview.heads
        : (reference.heads || []));

    this._card.update({ session, heads, appState });
  }

  _emitEnter(sessionID) {
    this.dispatchEvent(new CustomEvent('kikx-session-enter', {
      bubbles: true,
      composed: true,
      detail: { sessionID },
    }));
  }
}

export function sessionReferenceFromFrame(frame) {
  let references = frame?.content?.references;
  if (!Array.isArray(references))
    return null;

  for (let reference of references) {
    if (reference?.type === 'session' && typeof reference.id === 'string' && reference.id.trim() !== '')
      return { ...reference, id: reference.id.trim() };
  }

  return null;
}

export function refreshSubSessionCards(root, appState, sessionID = '') {
  if (!root || typeof root.querySelectorAll !== 'function')
    return;

  for (let card of root.querySelectorAll('kikx-sub-session-frame'))
    card.refreshFromState?.(appState, sessionID);
}

if (typeof customElements !== 'undefined' && !customElements.get('kikx-sub-session-frame'))
  customElements.define('kikx-sub-session-frame', KikxSubSessionFrame);
