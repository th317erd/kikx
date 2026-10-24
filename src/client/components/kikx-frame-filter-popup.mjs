'use strict';

import { createIcon } from '../lib/icons.mjs';
import {
  CATEGORY_ROWS,
  FILTER_KEYS,
  HIDDEN_ROW,
  filterCounts,
  filterSummary,
  frameMatchesFilters,
  normalizeFrameFilters,
  allFilters,
  everyFilterOn,
  onlyFilter,
  toggleAllFilters,
  toggleFilter,
} from '../lib/frame-filters.mjs';

// The eyeball popup: a pinned master checkbox, then one checkbox per frame
// category. Every row starts checked, so opening the popup changes nothing
// until the user clicks.
//
// Click semantics (deliberately unlike a plain checkbox list):
//   plain click  - flip that one row
//   Ctrl+Click   - leave only the clicked row on
//   Shift+Click  - turn every row on
//   pinned row   - all on if anything is off, all off if everything is on
//
// The element owns no state of its own: filters live on app state so the
// thread renderer and the popup cannot disagree.
export class KikxFrameFilterPopup extends HTMLElement {
  constructor() {
    super();
    this._app = null;
    this._appState = null;
    this._sessionID = null;
    this._childCount = 0;
    this._button = null;
    this._panel = null;
    this._master = null;
    this._rows = new Map();
    this._outsideHandler = null;
    this._keyHandler = null;
  }

  configure({ app, appState = null, sessionID = null, childCount = 0 } = {}) {
    this._app = app || null;
    this._appState = appState || app?._state || null;
    this._sessionID = sessionID || null;
    this._childCount = Number.isFinite(childCount) ? childCount : 0;
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

  get _filters() {
    return normalizeFrameFilters(this._appState?.frameFilters);
  }

  _render() {
    if (!this._app || !this._appState)
      return;

    let root = document.createElement('div');
    root.className = 'kikx-frame-filter';

    let button = document.createElement('button');
    button.type = 'button';
    button.className = 'kikx-frame-filter__button';
    button.title = 'Filter frames';
    button.setAttribute('aria-label', 'Filter frames');
    button.setAttribute('aria-haspopup', 'dialog');
    button.setAttribute('aria-expanded', 'false');
    button.appendChild(createIcon('eyeball', { ownerDocument: document }));
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      this._toggle();
    });

    let panel = document.createElement('div');
    panel.className = 'kikx-frame-filter__panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Filter frames');
    panel.hidden = true;

    this.replaceChildren(root);
    root.append(button, panel);
    this._button = button;
    this._panel = panel;
    this._renderPanel();

    if (this._app._frameFilterPopupOpen === true)
      this._open({ focus: false });
  }

  _renderPanel() {
    if (!this._panel)
      return;

    this._panel.replaceChildren();
    this._rows = new Map();

    let header = document.createElement('div');
    header.className = 'kikx-frame-filter__header';
    let title = document.createElement('strong');
    title.textContent = 'Show';
    header.append(title);

    let list = document.createElement('div');
    list.className = 'kikx-frame-filter__list';

    // The pinned row is a sibling of the list, not a member of it, so no list
    // scroll position can ever move it.
    let pinned = document.createElement('div');
    pinned.className = 'kikx-frame-filter__pinned';
    this._master = rowControl({ label: 'All frames', key: 'all', kind: 'master' });
    this._master.input.addEventListener('click', (event) => {
      event.preventDefault();
      this._apply(toggleAllFilters(this._filters));
    });
    pinned.appendChild(this._master.row);

    let counts = filterCounts(this._countSourceFrames());
    for (let entry of CATEGORY_ROWS) {
      let control = rowControl({ label: entry.label, key: entry.key, count: counts[entry.key] });
      control.input.addEventListener('click', (event) => {
        event.preventDefault();
        this._handleRowClick(entry.key, event);
      });
      this._rows.set(entry.key, control);
      list.appendChild(control.row);
    }

    // The Hidden gate is not a category, so it sits outside the list, below a
    // rule, with no count-as-category semantics. It stays inside the scrolling
    // area's sibling group but is visually its own block.
    let gate = document.createElement('div');
    gate.className = 'kikx-frame-filter__gate';
    let gateControl = rowControl({
      label: HIDDEN_ROW.label,
      key: HIDDEN_ROW.key,
      count: counts[HIDDEN_ROW.key],
    });
    gateControl.input.addEventListener('click', (event) => {
      event.preventDefault();
      this._handleRowClick(HIDDEN_ROW.key, event);
    });
    this._rows.set(HIDDEN_ROW.key, gateControl);
    gate.appendChild(gateControl.row);

    // The child-session grid used to be reachable only from the grid-of-dots
    // toggle this popup replaced, and that grid is the only place the
    // "+ Add Session" card is rendered. Removing the toggle therefore left
    // child-session creation with no UI route at all. This footer is where that
    // capability now lives: one control restores the grid, the add card and
    // renaming, instead of a second creation path that could drift from it.
    let footer = document.createElement('div');
    footer.className = 'kikx-frame-filter__footer';
    let gridButton = document.createElement('button');
    gridButton.type = 'button';
    gridButton.className = 'kikx-frame-filter__action';
    gridButton.setAttribute('data-filter-action', 'child-sessions-grid');
    gridButton.textContent = `Child sessions (${this._childCount})`;
    gridButton.addEventListener('click', () => {
      this._close();
      if (typeof this._app?._showSubSessions === 'function')
        this._app._showSubSessions();
    });
    footer.appendChild(gridButton);

    this._panel.append(header, pinned, list, gate, footer);
    this._paint();
  }

  _countSourceFrames() {
    let sessionID = this._sessionID;
    if (!sessionID)
      return [];

    return this._appState?.framesBySessionIdForFilters?.(sessionID)
      || this._appState?.framesBySessionID?.[sessionID]
      || [];
  }

  _handleRowClick(key, event) {
    let filters = this._filters;
    let next;
    if (event.ctrlKey === true || event.metaKey === true)
      next = onlyFilter(filters, key);
    else if (event.shiftKey === true)
      next = allFilters(filters, true);
    else
      next = toggleFilter(filters, key);

    this._apply(next);
  }

  // Paint the checkboxes from state. The pinned row is tri-state, and
  // `indeterminate` is a property only: setting the attribute does nothing.
  _paint() {
    let filters = this._filters;

    if (this._master) {
      let summary = filterSummary(filters);
      this._master.input.checked = summary === 'on';
      this._master.input.indeterminate = summary === 'mixed';
      this._master.row.classList.toggle('is-mixed', summary === 'mixed');
    }

    for (let [ key, control ] of this._rows) {
      let on = filters[key] === true;
      control.input.checked = on;
      control.row.classList.toggle('is-off', !on);
    }

    // The header button dims while any category is switched off, so a narrowed
    // thread is visible without opening the popup.
    this.classList.toggle('is-all-on', everyFilterOn(filters));
  }

  _apply(next) {
    if (typeof this._app?._setFrameFilters === 'function') {
      this._app._setFrameFilters(next);
      this._paint();
      return;
    }

    // No app hook (an older shell, or a test harness): fall back to writing
    // state directly so the popup still behaves, just without a repaint.
    if (this._appState)
      this._appState.frameFilters = normalizeFrameFilters(next);
    this._paint();
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
    this._app._frameFilterPopupOpen = true;
    this._panel.hidden = false;
    this._button?.setAttribute('aria-expanded', 'true');
    this.classList.add('is-open');
    this._paint();
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
      this._app._frameFilterPopupOpen = false;
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

function rowControl({ label, key, count = null, kind = 'row' }) {
  let row = document.createElement('label');
  row.className = `kikx-frame-filter__row kikx-frame-filter__row--${kind}`;
  row.setAttribute('data-filter-key', key);

  let input = document.createElement('input');
  input.type = 'checkbox';
  input.className = 'kikx-frame-filter__checkbox';
  input.checked = true;
  input.setAttribute('aria-label', label);

  let text = document.createElement('span');
  text.className = 'kikx-frame-filter__label';
  text.textContent = label;

  row.append(input, text);

  if (typeof count === 'number') {
    let badge = document.createElement('span');
    badge.className = 'kikx-frame-filter__count';
    badge.textContent = String(count);
    row.appendChild(badge);
  }

  return { row, input, label, key };
}

// True when anything would be rendered under these filters. The thread uses it
// to explain an empty result instead of looking broken.
export function framesWouldRender(frames, filters) {
  let normal = normalizeFrameFilters(filters);
  return (Array.isArray(frames) ? frames : []).some((frame) => frameMatchesFilters(frame, normal));
}

export { FILTER_KEYS };

if (typeof customElements !== 'undefined' && !customElements.get('kikx-frame-filter-popup'))
  customElements.define('kikx-frame-filter-popup', KikxFrameFilterPopup);
