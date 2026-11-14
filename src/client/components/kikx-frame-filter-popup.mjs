'use strict';

import { createIcon } from '../lib/icons.mjs';
import {
  CATEGORY_ROWS,
  DELETED_ROW,
  FILTER_KEYS,
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
// category, then the Hidden reveal. Every category starts checked and the
// reveal starts off, so opening the popup changes nothing until the user clicks.
//
// "Hidden" is the single control for soft-deleted and hidden content: it
// reveals both in the thread AND makes the session grid include the soft-deleted
// session bucket. There is deliberately no second eye: one popup, one idiom,
// nothing stranded on a screen the popup does not reach.
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
    this._button = null;
    this._panel = null;
    this._master = null;
    this._rows = new Map();
    // View toggles (Raw/Debug) are NOT category filters, so they keep their own
    // map: _paint writes frameFilters[key] for everything in _rows, and a view
    // toggle in there would be reset to false on every repaint.
    this._viewRows = new Map();
    this._outsideHandler = null;
    this._keyHandler = null;
  }

  configure({ app, appState = null, sessionID = null, embedded = false } = {}) {
    this._app = app || null;
    this._appState = appState || app?._state || null;
    this._sessionID = sessionID || null;
    // Embedded mode (owner change, 2026-11-05): the panel renders INLINE and
    // always-open inside the mobile ⋮ overflow menu (kikx-overflow-popup.mjs),
    // which supplies the trigger and the outside/Escape close itself. Nothing
    // else about the rows changes — same state, same click semantics.
    this._embedded = embedded === true;
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
    root.className = this._embedded
      ? 'kikx-frame-filter kikx-frame-filter--embedded'
      : 'kikx-frame-filter';

    let button = null;
    if (!this._embedded) {
      button = document.createElement('button');
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
    }

    let panel = document.createElement('div');
    panel.className = 'kikx-frame-filter__panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Filter frames');
    // Embedded: visible from birth — the host menu is the only open/close it
    // needs, and `hidden` here would also swallow its outside-close contract.
    panel.hidden = !this._embedded;

    this.replaceChildren(root);
    if (button)
      root.append(button, panel);
    else
      root.append(panel);
    this._button = button;
    this._panel = panel;
    this._renderPanel();

    if (this._embedded) {
      // No _open() will ever fire for this instance, so ask for the server-side
      // frame counts right away or the rows would never earn their badges.
      this._requestCounts();
      return;
    }

    if (this._app._frameFilterPopupOpen === true)
      this._open({ focus: false });
  }

  _renderPanel() {
    if (!this._panel)
      return;

    this._panel.replaceChildren();
    this._rows = new Map();
    this._viewRows = new Map();

    let header = document.createElement('div');
    header.className = 'kikx-frame-filter__header';
    let title = document.createElement('strong');
    title.textContent = 'Show';
    header.append(title);

    let list = document.createElement('div');
    list.className = 'kikx-frame-filter__list';

    // No session means no frames on screen (the Projects/session grid). Frame
    // categories would be meaningless there, so the popup keeps only the one
    // control that still applies: the Hidden reveal, which is what brings
    // soft-deleted sessions back into the grid.
    let hasFrames = Boolean(this._sessionID);

    // The pinned row is a sibling of the list, not a member of it, so no list
    // scroll position can ever move it.
    let pinned = document.createElement('div');
    pinned.className = 'kikx-frame-filter__pinned';
    this._master = rowControl({ label: 'All frames', key: 'all', kind: 'master' });
    // Click semantics live on the ROW, not on the checkbox. The row is a
    // <label>, so a click on its text or badge activates the checkbox through
    // the label. That activation is a synthetic click on the input with the
    // modifier flags dropped, so Ctrl+Click and Shift+Click on the row arrived
    // indistinguishable from a plain click and did nothing. Listening on the
    // label keeps the real event, with its modifiers, and preventDefault stops
    // the label from forwarding a second, modifier-free click to the input.
    this._master.row.addEventListener('click', (event) => {
      event.preventDefault();
      this._apply(toggleAllFilters(this._filters));
    });
    pinned.appendChild(this._master.row);
    if (!hasFrames)
      pinned.hidden = true;

    // `null` counts mean "not known yet" (or "not knowable from paths"), and
    // render as a row with no badge rather than a confident zero.
    let counts = this._serverCounts();
    for (let entry of CATEGORY_ROWS) {
      if (!hasFrames)
        break;

      let control = rowControl({
        label: entry.label,
        key: entry.key,
        count: counts ? counts[entry.key] : null,
      });
      control.row.addEventListener('click', (event) => {
        event.preventDefault();
        this._handleRowClick(entry.key, event);
      });
      this._rows.set(entry.key, control);
      list.appendChild(control.row);
    }
    if (!hasFrames)
      list.hidden = true;

    // The Hidden reveal is not a category, so it sits outside the list, below a
    // rule, with no count-as-category semantics. It stays inside the scrolling
    // area's sibling group but is visually its own block.
    let gate = document.createElement('div');
    gate.className = 'kikx-frame-filter__gate';
    let gateControl = rowControl({
      label: DELETED_ROW.label,
      key: DELETED_ROW.key,
      count: hasFrames && counts ? counts[DELETED_ROW.key] : null,
    });
    gateControl.row.addEventListener('click', (event) => {
      event.preventDefault();
      this._handleRowClick(DELETED_ROW.key, event);
    });
    this._rows.set(DELETED_ROW.key, gateControl);
    gate.appendChild(gateControl.row);

    // There is deliberately no child-session entry point here. This popup
    // narrows what the current window shows; child sessions are not another view
    // to travel to, they are rendered inside the window that owns them. The footer
    // that used to reach the child grid existed only because that grid was the one
    // place the "+ Add Session" card lived -- and a grid you could enter but never
    // leave is what made child sessions a dead end. Creation lives in the window
    // header at every level now, so this popup keeps a single job.
    // View-level toggles (owner change, 2026-11-14): "I want the RAW and DEBUG
    // items to be under the Filter popup menu with the Eye icon... they are
    // View-level controls... put these two items down at the bottom with
    // Hidden". This closes the popup's job: everything that changes what the
    // window SHOWS lives here, and the top bar keeps no view chips.
    //
    // They are deliberately not rows of the category list: a category narrows
    // WHICH frames render (frameFilters), a view toggle changes HOW the same
    // frames render. They also carry no count badge, because "how many frames
    // are in raw mode" is not a fact about the session.
    let viewBlock = document.createElement('div');
    viewBlock.className = 'kikx-frame-filter__view';
    for (let entry of VIEW_ROWS) {
      let control = viewRowControl({ label: entry.label, key: entry.key });
      control.row.addEventListener('click', (event) => {
        // Same reason as the category rows: preventDefault stops the <label>
        // from forwarding a second, modifier-free click to the checkbox.
        event.preventDefault();
        this._toggleView(entry.key);
      });
      this._viewRows.set(entry.key, control);
      viewBlock.appendChild(control.row);
    }

    this._panel.append(header, pinned, list, gate, viewBlock);
    this._paint();
  }

  // Counts come from the server, not from the loaded window.
  //
  // `framesBySessionID[sessionID]` holds only the page the browser currently
  // has, so counting it answers "how many are on this page" — which is how the
  // panel ended up showing Agent 60 next to User 0, Tools 0 and Commands 0 for a
  // session that contains 17,581 frames. A badge is a fact about the session.
  //
  // The request is issued on open and cached on app state. Until it lands the
  // counts read as `null` and the rows render without a number, which is honest:
  // no number is better than a number computed from the wrong set.
  _serverCounts() {
    let sessionID = this._sessionID;
    if (!sessionID)
      return null;

    return this._appState?.frameCountsBySessionID?.[sessionID]?.counts || null;
  }

  _requestCounts() {
    let sessionID = this._sessionID;
    let app = this._app;
    if (!sessionID || !app || typeof app._loadFrameCounts !== 'function')
      return;

    let signature = this._countSignature();
    if (this._countsRequestedFor === signature)
      return;

    this._countsRequestedFor = signature;
    Promise.resolve(app._loadFrameCounts(sessionID))
      .then(() => {
        // Repaint the badges IN PLACE. This used to call _renderPanel(), which
        // replaces every row — a row a user is mid-click on disappears and the
        // click lands on a detached node (observed as "Node is detached from
        // document" under the mobile ⋮ menu). A badge number never needs a
        // structural rebuild.
        this._repaintCounts();
      })
      .catch(() => {
        // A failed count request must not break the popup: the rows still work
        // and simply have no badges.
        this._countsRequestedFor = null;
      });
  }

  // Update (or add/remove) each row's count badge without touching the rows
  // themselves. `null` means "not known" and renders no badge, same as at
  // build time.
  _repaintCounts() {
    if (!this._panel)
      return;

    let counts = this._serverCounts();
    for (let [ key, control ] of this._rows) {
      let value = counts ? counts[key] : null;
      let badge = control.row.querySelector('.kikx-frame-filter__count');
      if (typeof value === 'number') {
        if (!badge) {
          badge = document.createElement('span');
          badge.className = 'kikx-frame-filter__count';
          control.row.appendChild(badge);
        }
        if (badge.textContent !== String(value))
          badge.textContent = String(value);
      } else if (badge) {
        badge.remove();
      }
    }
  }

  _countSignature() {
    return `${this._sessionID || ''}`;
  }

  _handleRowClick(key, event) {
    let filters = this._filters;
    let next;
    if (event.ctrlKey === true || event.metaKey === true)
      next = onlyFilter(filters, key);
    else if (event.shiftKey === true)
      // Shift is a toggle for the whole set, not "turn on". Hard-coding true
      // meant that once everything was on -- the default -- Shift+Click could
      // only ever set the same all-on value again, so the gesture looked inert.
      next = allFilters(filters, !everyFilterOn(filters));
    else
      next = toggleFilter(filters, key);

    this._apply(next);
  }

  // Paint the checkboxes from state. The pinned row is tri-state, and
  // `indeterminate` is a property only: setting the attribute does nothing.
  refresh() {
    this._paint();
  }

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

    for (let [ key, control ] of this._viewRows) {
      let on = this._viewState(key) === true;
      control.input.checked = on;
      control.row.classList.toggle('is-on', on);
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

  _viewState(key) {
    if (key === 'raw')
      return this._appState?.rawMarkdown === true;
    if (key === 'debug')
      return this._appState?.debugMode === true;
    return false;
  }

  // These rows call the SAME app handlers the top-bar chips called, so there is
  // exactly one implementation of raw mode and one of debug mode: the owner's
  // change is a relocation, not a reimplementation.
  //
  // The repaint afterwards is required, not defensive. Debug mode re-renders the
  // whole app, which recreates this popup mid-callback. Raw mode does NOT
  // repaint the shell by design (see raw-markdown.mjs: it flips the renderer
  // flag and re-renders mounted frame CONTENT in place, preserving scroll), so
  // it updates neither this checkbox nor this row. Neither path paints this
  // popup, so without the call below the row would show stale state.
  _toggleView(key) {
    if (key === 'raw')
      this._app?._toggleRawMarkdown?.();
    else if (key === 'debug')
      this._app?._toggleDebugMode?.();
    this._paint();
  }

  _toggle() {
    if (this.isOpen)
      this._close();
    else
      this._open({ focus: true });
  }

  _open({ focus = true } = {}) {
    if (!this._panel || !this._app || this._embedded)
      return;
    this._app._frameFilterPopupOpen = true;
    this._panel.hidden = false;
    // Counts are a session fact fetched from the server; ask for them when the
    // panel opens rather than counting whatever the browser has loaded.
    this._requestCounts();
    this._button?.setAttribute('aria-expanded', 'true');
    this.classList.add('is-open');
    this._paint();
    this._installOutsideHandlers();
    if (focus)
      this._panel.focus?.();
  }

  _close() {
    if (!this._panel || this._embedded)
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

// The view-level toggles, in the order the owner named them. Raw first, then
// Debug, both BELOW the Hidden gate because all three answer "what do I see".
const VIEW_ROWS = [
  { label: 'Raw', key: 'raw' },
  { label: 'Debug', key: 'debug' },
];

// Same row shell as a category row, minus the badge, plus a state class the CSS
// can colour. Deliberately the same <label>+checkbox idiom so it reads as part
// of the list above it and is keyboard-operable for free.
function viewRowControl({ label, key }) {
  let row = document.createElement('label');
  row.className = 'kikx-frame-filter__row kikx-frame-filter__row--view';
  row.setAttribute('data-view-key', key);

  let input = document.createElement('input');
  input.type = 'checkbox';
  input.className = 'kikx-frame-filter__checkbox';
  input.checked = false;
  input.setAttribute('aria-label', label);

  let text = document.createElement('span');
  text.className = 'kikx-frame-filter__label';
  text.textContent = label;

  row.append(input, text);
  return { row, input, label, key };
}

function rowControl({ label, key, count = null, kind = 'row' }) {
  let row = document.createElement('label');
  row.className = `kikx-frame-filter__row kikx-frame-filter__row--${kind}`;
  row.setAttribute('data-filter-key', key);

  let input = document.createElement('input');
  input.type = 'checkbox';
  input.className = 'kikx-frame-filter__checkbox';
  input.checked = kind === 'master' || key !== DELETED_ROW.key;
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
