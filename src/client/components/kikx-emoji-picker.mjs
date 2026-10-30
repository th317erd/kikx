'use strict';

import { suggestEmoji, findActiveEmojiQuery, applyEmojiInsertion } from './emoji-data.mjs';

// 12 fits two screens worth in the 320px list, which is what makes the
// "selected row stays in view" behaviour below reachable at all: with 8 the
// whole list fits and scrollIntoView would be a silent no-op.
const MAX_RESULTS = 12;
const OUTSIDE_CLICK_EVENT = 'pointerdown';
const LIST_ID = 'kikx-emoji-picker-list';

// Renders the `:` typeahead above a composer textarea.
//
// The element owns no state that matters across a rebuild: `configure()` is
// called with the app + the textarea, exactly like `kikx-composer-history`, and
// the closed state is the default. Selections are applied synchronously
// through `_commitText`, because an await inside a keystroke would let the
// draft flush race the insertion (see composer-drafts.mjs:344 — replaceComposerText
// is async for exactly that reason and is therefore unusable per keystroke).
export class KikxEmojiPicker extends HTMLElement {
  constructor() {
    super();
    this._app = null;
    this._textarea = null;
    this._span = null;
    this._results = [];
    this._selectedIndex = 0;
    this._optionNodes = [];
    this._outsideHandler = null;
    this._open = false;
    // Deliberately does NOT set `this.hidden` here. A custom element built via
    // `document.createElement()` must not gain attributes during construction,
    // and `hidden` is a reflected attribute: setting it throws "The result must
    // not have attributes", `createElement` then returns a plain
    // HTMLUnknownElement, the element never upgrades, `configure` is undefined
    // and the picker is dead in a real browser. Reflected in `_build` instead.
  }

  configure({ app, textarea } = {}) {
    this._app = app || null;
    this._textarea = textarea || null;
    this._build();
    if (this._app)
      this._app._emojiPicker = this;
  }

  // The shell builds the textarea inside a builder chain, so resolving it here
  // is the same lookup the composer's own helpers already use
  // (kikx-composer.mjs:97, composer-drafts.mjs:441) rather than plumbing the
  // node through the builder.
  _ensureTextarea() {
    if (this._textarea)
      return this._textarea;
    if (this._app?.querySelector)
      this._textarea = this._app.querySelector('textarea[name="message"]') || null;
    return this._textarea;
  }

  connectedCallback() {
    if (!this._built && this._app)
      this._build();
  }

  disconnectedCallback() {
    this._removeOutsideHandler();
    if (this._app && this._app._emojiPicker === this)
      this._app._emojiPicker = null;
  }

  get isOpen() {
    return this._open;
  }

  get span() {
    return this._span;
  }

  get results() {
    return this._results.slice();
  }

  get selectedIndex() {
    return this._selectedIndex;
  }

  // Called on every value/caret change. `caret` is explicit rather than read
  // off the textarea because mini-dom has no selection model and the caller
  // (the app's keydown/input bridge) knows it precisely in a real browser.
  update(value, caret) {
    let span = findActiveEmojiQuery(value, caret);
    if (!span) {
      this.close();
      return false;
    }

    // A bare `:` offers a popular set, so the picker opens the moment the colon
    // is typed; any query narrows it.
    let results = suggestEmoji(span.query, { limit: MAX_RESULTS });
    if (results.length === 0) {
      this.close();
      return false;
    }

    // Keep the highlight only while the query is unchanged; typing another
    // character is a new result list and selection restarts at the top.
    let sameQuery = Boolean(this._span) && this._span.query === span.query;
    this._span = span;
    this._results = results;
    if (!sameQuery || this._selectedIndex >= results.length)
      this._selectedIndex = 0;

    this.open();
    return true;
  }

  open() {
    this._open = true;
    this.hidden = false;
    this._render();
    this._attachOutsideHandler();
    return true;
  }

  close() {
    if (this._open || this.hidden !== true) {
      this._open = false;
      this.hidden = true;
      this._removeOutsideHandler();
    }
    this._span = null;
    this._results = [];
    this._selectedIndex = 0;
    this._optionNodes = [];
    if (this._list) {
      while (this._list.firstChild)
        this._list.removeChild(this._list.firstChild);
    }
    this._syncAria(false, null);
    return false;
  }

  moveSelection(delta) {
    if (!this.isOpen || this._results.length === 0)
      return false;
    let count = this._results.length;
    this._selectedIndex = ((this._selectedIndex + delta) % count + count) % count;
    // Repaint in place instead of rebuilding: a rebuild discards the scroll
    // offset, so the row the user just moved to would land off-screen.
    this._paintSelection({ scroll: true });
    return true;
  }

  // Returns true when a selection was made, so the caller can preventDefault
  // and stop Enter from also submitting the half-written message.
  select(index = this._selectedIndex) {
    if (!this.isOpen || this._results.length === 0)
      return false;
    let entry = this._results[index] || this._results[0];
    if (!entry)
      return false;
    this.commit(entry.char);
    return true;
  }

  commit(char) {
    let textarea = this._ensureTextarea();
    let span = this._span;
    if (!textarea || !span)
      return false;

    let { value, caret } = applyEmojiInsertion(textarea.value, span, char);
    this._commitText(value, caret);
    this.close();
    return true;
  }

  // Synchronous value write + caret restore + draft sync. One path only, so a
  // mouse click and an Enter keypress cannot diverge.
  _commitText(value, caret) {
    let textarea = this._ensureTextarea();
    if (!textarea)
      return;

    textarea.value = value;
    try {
      textarea.setSelectionRange?.(caret, caret);
    } catch (_error) {}

    if (this._app) {
      this._app._state.draft = value;
      // Reuse the app's own input path so local draft persistence, the typing
      // idle window and any listeners all behave exactly as typing does.
      this._app._syncDraft?.({ target: textarea });
      // The selection moved without an input event; keep the picker honest.
      this._textareaFocused = true;
    }
  }

  _build() {
    this._built = true;
    this.hidden = !this._open;
    this.classList?.add('kikx-emoji-picker');
    this.setAttribute?.('role', 'listbox');
    this.setAttribute?.('aria-label', 'Emoji');
    this.setAttribute?.('id', LIST_ID);

    while (this.firstChild)
      this.removeChild(this.firstChild);

    let list = document.createElement('div');
    list.className = 'kikx-emoji-picker__list';
    list.setAttribute?.('role', 'presentation');
    this._list = list;
    this.appendChild(list);
  }

  _render() {
    if (!this._list)
      return;

    while (this._list.firstChild)
      this._list.removeChild(this._list.firstChild);
    this._optionNodes = [];

    this._results.forEach((entry, index) => {
      let option = document.createElement('button');
      option.setAttribute?.('type', 'button');
      option.className = 'kikx-emoji-picker__option';
      option.setAttribute?.('role', 'option');
      option.setAttribute?.('id', `${LIST_ID}-option-${index}`);
      option.setAttribute?.('data-emoji', entry.char);
      option.setAttribute?.('title', `:${entry.name}:`);
      option.__emojiIndex = index;

      let glyph = document.createElement('span');
      glyph.className = 'kikx-emoji-picker__glyph';
      glyph.textContent = entry.char;
      option.appendChild(glyph);

      let code = document.createElement('span');
      code.className = 'kikx-emoji-picker__code';
      code.textContent = `:${entry.name}:`;
      option.appendChild(code);

      // mousedown, not click alone: a click steals focus from the textarea
      // first, which would lose the caret the insertion depends on. Both are
      // wired because a synthesised click (tests, assistive tech) never sends
      // mousedown, but `select()` is idempotent-safe: the second call lands
      // after close() and returns false without touching the text.
      option.addEventListener('mousedown', (event) => {
        event.preventDefault?.();
        this.select(index);
      });
      option.addEventListener('click', (event) => {
        event.preventDefault?.();
        this.select(index);
      });

      this._optionNodes.push(option);
      this._list.appendChild(option);
    });

    this._paintSelection({ scroll: false });
  }

  // Moves the highlight without rebuilding the list. Keeps the active row in
  // view and mirrors the state into aria so a screen reader follows the arrows.
  _paintSelection({ scroll = false } = {}) {
    let nodes = this._optionNodes || [];
    nodes.forEach((node, index) => {
      let selected = index === this._selectedIndex;
      node.setAttribute?.('aria-selected', selected ? 'true' : 'false');
      if (selected)
        node.classList?.add?.('is-selected');
      else
        node.classList?.remove?.('is-selected');
    });

    let active = nodes[this._selectedIndex] || null;
    this._syncAria(true, active?.getAttribute?.('id') || null);
    if (scroll)
      active?.scrollIntoView?.({ block: 'nearest' });
  }

  // The listbox pattern puts the state on the element that holds focus, which
  // here is the textarea: focus never leaves the composer.
  _syncAria(expanded, activeID) {
    let textarea = this._ensureTextarea();
    if (!textarea || !textarea.setAttribute)
      return;
    textarea.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    textarea.setAttribute('aria-controls', LIST_ID);
    textarea.setAttribute('aria-autocomplete', 'list');
    if (expanded && activeID)
      textarea.setAttribute('aria-activedescendant', activeID);
    else
      textarea.removeAttribute?.('aria-activedescendant');
  }

  _attachOutsideHandler() {
    if (this._outsideHandler || typeof document === 'undefined' || !document.addEventListener)
      return;
    this._outsideHandler = (event) => {
      let target = event?.target;
      if (!target)
        return;
      if (target === this || this.contains?.(target) || target === this._ensureTextarea())
        return;
      this.close();
    };
    document.addEventListener(OUTSIDE_CLICK_EVENT, this._outsideHandler);
  }

  _removeOutsideHandler() {
    if (!this._outsideHandler)
      return;
    document.removeEventListener?.(OUTSIDE_CLICK_EVENT, this._outsideHandler);
    this._outsideHandler = null;
  }
}

if (typeof customElements !== 'undefined' && !customElements.get('kikx-emoji-picker'))
  customElements.define('kikx-emoji-picker', KikxEmojiPicker);
