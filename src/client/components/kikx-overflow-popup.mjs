'use strict';

import { createIcon } from '../lib/icons.mjs';

// The mobile toolbar overflow menu (owner change, 2026-11-05):
//
//   "turn the 'eye' icon into a vertical triple-dot icon on mobile, and have it
//    be a popup menu. This popup menu will have all the current toolbar
//    actions, and it will have the filter selection checkboxes at the bottom of
//    the popup items"
//
// It lives in the SAME SLOT as the eye — a sibling of the search field inside
// `.kikx-topbar__search-group` — and the two swap by breakpoint through
// overflow-popup.css: desktop shows eye + actions cluster and hides this; the
// mobile layout hides eye + cluster and shows this.
//
// Contents, top to bottom: the toolbar action nodes handed in by
// `buildTopbarOverflowActionNodes` (Raw, Debug, participants, Settings,
// + Add — one definition each, built once by kikx-topbar.mjs), a divider, then
// the frame FILTER CHECKBOXES rendered by a `kikx-frame-filter-popup` in
// embedded mode (always-open panel, no trigger, no outside-close of its own).
//
// State: opening sets `app._overflowPopupOpen`, mirroring the eye's
// `app._frameFilterPopupOpen`, so a shell rebuild re-opens the menu the same
// way. Filters themselves never live here — they live on app state, exactly as
// the eye popup requires.

export class KikxOverflowPopup extends HTMLElement {
  constructor() {
    super();
    this._app = null;
    this._appState = null;
    this._sessionID = null;
    this._actions = [];
    this._button = null;
    this._panel = null;
    this._outsideHandler = null;
    this._keyHandler = null;
  }

  configure({ app, appState = null, sessionID = null, actions = [] } = {}) {
    this._app = app || null;
    this._appState = appState || app?._state || null;
    this._sessionID = sessionID || null;
    this._actions = Array.isArray(actions) ? actions.filter(Boolean) : [];
    if (this.isConnected)
      this._render();
  }

  connectedCallback() {
    this._render();
  }

  disconnectedCallback() {
    this._removeOutsideHandlers();
  }

  get isOpen() {
    return this._panel?.hidden === false;
  }

  _render() {
    if (!this._app || !this._appState)
      return;

    let root = document.createElement('div');
    root.className = 'kikx-overflow';

    let button = document.createElement('button');
    button.type = 'button';
    button.className = 'kikx-overflow__button';
    button.title = 'More actions';
    button.setAttribute('aria-label', 'More actions');
    button.setAttribute('aria-haspopup', 'dialog');
    button.setAttribute('aria-expanded', 'false');
    button.appendChild(createIcon('dots-vertical', { ownerDocument: document }));
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      this._toggle();
    });

    let panel = document.createElement('div');
    panel.className = 'kikx-overflow__panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Toolbar menu');
    panel.hidden = true;

    this.replaceChildren(root);
    root.append(button, panel);
    this._button = button;
    this._panel = panel;
    // Panel CONTENT is built lazily on open (_open below): a hidden duplicate
    // of every filter row would otherwise sit in the DOM from first paint
    // (doubling row counts for anything that queries them), the server-count
    // request would fire for a menu nobody opened, and rebuilding on every open
    // guarantees the checkboxes reflect app state even after an EXTERNAL
    // change (clear-filters, search) while the menu was closed.

    if (this._app._overflowPopupOpen === true)
      this._open({ focus: false });
  }

  _renderPanel() {
    if (!this._panel)
      return;

    this._panel.replaceChildren();

    // Action rows first. Each node is wrapped so a click anywhere in the row
    // activates it (the wrapper closes the menu afterwards); participants is
    // the one exception — its own popup opens INSIDE this menu, so closing the
    // menu would instantly hide what the click just opened.
    for (let action of this._actions) {
      if (action.localName === 'kikx-participants-popup') {
        this._panel.appendChild(action);
        continue;
      }

      let row = document.createElement('div');
      row.className = 'kikx-overflow__item';
      row.appendChild(action);
      // Target-phase (the button's own listener) runs first — Settings/+Add
      // schedule their render — then this bubble-phase close lands before the
      // coalesced rAF rebuild, so the rebuilt menu comes back CLOSED.
      row.addEventListener('click', () => this._close());
      this._panel.appendChild(row);
    }

    let divider = document.createElement('div');
    divider.className = 'kikx-overflow__divider';
    this._panel.appendChild(divider);

    // The filter checkboxes, at the bottom of the popup items, in embedded
    // mode: the eye's own panel rendered inline and always open. Same rows,
    // same click semantics, same app-state filters — only the chrome differs.
    let filtersHost = document.createElement('div');
    filtersHost.className = 'kikx-overflow__filters';
    let filters = document.createElement('kikx-frame-filter-popup');
    filters.configure({ app: this._app, appState: this._appState, sessionID: this._sessionID, embedded: true });
    filtersHost.appendChild(filters);
    this._panel.appendChild(filtersHost);
  }

  _toggle() {
    if (this.isOpen)
      this._close();
    else
      this._open({ focus: true });
  }

  _open({ focus = true } = {}) {
    if (!this._panel || !this._app)
      return;
    // Always (re)build from app state on open — see the lazy-build note in
    // _render. The action nodes come from configure() and are MOVED into fresh
    // wrappers each time; their listeners were attached once at build.
    this._renderPanel();
    this._app._overflowPopupOpen = true;
    this._panel.hidden = false;
    this._button?.setAttribute('aria-expanded', 'true');
    this.classList.add('is-open');
    this._installOutsideHandlers();
    if (focus)
      this._panel.focus?.();
  }

  _close() {
    if (!this._panel)
      return;
    this._panel.hidden = true;
    this._button?.setAttribute('aria-expanded', 'false');
    this.classList.remove('is-open');
    if (this._app)
      this._app._overflowPopupOpen = false;
    this._removeOutsideHandlers();
  }

  _installOutsideHandlers() {
    this._removeOutsideHandlers();
    this._outsideHandler = (event) => {
      if (!this.contains(event.target))
        this._close();
    };
    this._keyHandler = (event) => {
      if (event.key !== 'Escape')
        return;
      event.preventDefault();
      this._close();
      this._button?.focus?.();
    };
    document.addEventListener('pointerdown', this._outsideHandler, true);
    document.addEventListener('keydown', this._keyHandler, true);
    this._panel?.setAttribute('tabindex', '-1');
  }

  _removeOutsideHandlers() {
    if (this._outsideHandler)
      document.removeEventListener('pointerdown', this._outsideHandler, true);
    if (this._keyHandler)
      document.removeEventListener('keydown', this._keyHandler, true);
    this._outsideHandler = null;
    this._keyHandler = null;
  }
}

if (typeof customElements !== 'undefined' && !customElements.get('kikx-overflow-popup'))
  customElements.define('kikx-overflow-popup', KikxOverflowPopup);
