'use strict';

import './kikx-chat-view.mjs';
import { sessionCardLabel, sessionCardMeta } from './chat-view-model.mjs';

function createToolbar(owner) {
  let toolbar = document.createElement('footer');
  toolbar.className = 'kikx-session-card__toolbar';

  // The bottom toolbar holds per-session actions. Both controls are radial
  // aeor-progress-buttons (the icon-centric form the design calls for): Open is
  // click-to-activate (duration 0); Delete requires a 1s hold so a stray click
  // can never destroy a session.
  let openButton = document.createElement('aeor-progress-button');
  openButton.className = 'kikx-session-card__action kikx-session-card__action--open';
  openButton.setAttribute('icon', 'open');
  openButton.setAttribute('label', 'Open session');
  openButton.setAttribute('title', 'Open session');
  openButton.setAttribute('duration', '0');
  openButton.setAttribute('size', '1.75rem');

  let deleteButton = document.createElement('aeor-progress-button');
  deleteButton.className = 'kikx-session-card__action kikx-session-card__action--delete progress-button-danger';
  deleteButton.setAttribute('icon', 'delete');
  deleteButton.setAttribute('label', 'Delete session');
  deleteButton.setAttribute('title', 'Hold 1s to delete');
  deleteButton.setAttribute('duration', '1000');
  deleteButton.setAttribute('size', '1.75rem');

  toolbar.append(openButton, deleteButton);

  // The card root is itself clickable (open). Actions inside the toolbar must
  // not trigger that, so stop click/keydown at the toolbar boundary.
  toolbar.addEventListener('click', (event) => event.stopPropagation());
  toolbar.addEventListener('keydown', (event) => event.stopPropagation());
  // aeor-progress-button fires `confirm` when its hold (or click) completes.
  toolbar.addEventListener('confirm', (event) => {
    event.stopPropagation();
    if (event.target === deleteButton)
      owner._emitDelete();
    else
      owner._emitOpen();
  });

  return { toolbar, openButton, deleteButton };
}

function createCardShell(owner) {
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

  // One toolbar per card, owned by the card so its confirm handler can reach
  // back and emit open/delete. Built here, never rebuilt.
  let { toolbar, openButton, deleteButton } = createToolbar(owner);
  root.append(header, body, status, toolbar);

  return { root, title, meta, view, status, body, toolbar, openButton, deleteButton };
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
    this._deleting = false;
    this._shell = null;
  }

  get sessionID() {
    return this._session?.id || '';
  }

  get viewElement() {
    return this._shell?.view || null;
  }

  connectedCallback() {
    if (!this._shell)
      this._build();
  }

  _build() {
    this.textContent = '';
    this._shell = createCardShell(this);

    this._shell.root.tabIndex = 0;
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

  _emitDelete() {
    if (!this.sessionID)
      return;

    this.dispatchEvent(new CustomEvent('kikx-card-delete', {
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
    if (Object.hasOwn(input, 'deleting'))
      this._deleting = input.deleting === true;

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
    let label = sessionCardLabel(session);
    shell.title.textContent = label;
    shell.meta.textContent = sessionCardMeta(session, this._heads, this._truncated);
    // Stable accessible name: the session title only, not the preview text.
    shell.root.setAttribute('aria-label', label);

    shell.root.classList.toggle('is-selected', this._selected);
    // The root is not a button (it contains real controls), so mark the current
    // item instead of aria-pressed; clear it when unselected so no stale
    // attribute survives a re-render.
    if (this._selected)
      shell.root.setAttribute('aria-current', 'true');
    else
      shell.root.removeAttribute('aria-current');

    // Name the actions after the session so screen readers announce the target.
    if (shell.openButton) {
      shell.openButton.setAttribute('label', label ? `Open ${label}` : 'Open session');
      shell.openButton.setAttribute('title', 'Open session');
    }
    if (shell.deleteButton) {
      shell.deleteButton.setAttribute('label', label ? `Delete ${label}` : 'Delete session');
      shell.deleteButton.setAttribute('title', 'Hold 1s to delete');
      shell.deleteButton.disabled = this._deleting;
    }
    shell.root.classList.toggle('is-deleting', this._deleting);
    shell.root.setAttribute('aria-busy', this._deleting ? 'true' : 'false');

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
