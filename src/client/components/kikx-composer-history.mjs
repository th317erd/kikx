'use strict';

import {
  deleteComposerHistoryEntry,
  listLocalComposerDrafts,
  replaceComposerText,
} from './composer-drafts.mjs';

const PAGE_SIZE = 30;
const SEARCH_DEBOUNCE_MS = 150;

export class KikxComposerHistory extends HTMLElement {
  constructor() {
    super();
    this._app = null;
    this._sessionID = null;
    this._entries = [];
    this._loading = false;
    this._hasMoreOlder = true;
    this._before = null;
    this._query = '';
    this._selectedIndex = -1;
    this._searchTimer = null;
    this._outsideHandler = null;
  }

  configure({ app, sessionID }) {
    this._app = app || null;
    this._sessionID = sessionID || null;
    this._build();
    this._restoreOpen = app?._composerHistoryOpen === true;
  }

  connectedCallback() {
    if (this._app && this.childNodes.length === 0)
      this._build();
    if (this._restoreOpen) {
      this._restoreOpen = false;
      queueMicrotask(() => this.open());
    }
  }

  get isOpen() {
    return this.hidden === false;
  }

  toggle() {
    if (this.isOpen)
      return this.close();
    return this.open();
  }

  async open() {
    if (!this._app || !this._sessionID || !this.isConnected)
      return false;

    this.hidden = false;
    if (this._app)
      this._app._composerHistoryOpen = true;
    this._query = '';
    this._before = null;
    this._entries = [];
    this._selectedIndex = -1;
    this._hasMoreOlder = true;
    this._search.value = '';
    this._renderEntries();
    this._search.focus();
    queueMicrotask(() => this._search.focus());
    this._installOutsideHandler();
    await this._load({ reset: true });
    return true;
  }

  close() {
    if (!this.isOpen)
      return false;
    this.hidden = true;
    if (this._app)
      this._app._composerHistoryOpen = false;
    this._removeOutsideHandler();
    let composer = this._app?.querySelector?.('textarea[name="message"]');
    composer?.focus?.();
    return true;
  }

  _build() {
    if (this._built)
      return;
    this._built = true;
    this.className = 'kikx-composer-history-popover';
    this.hidden = true;
    this.setAttribute('role', 'dialog');
    this.setAttribute('aria-label', 'Message history');

    let searchWrap = document.createElement('div');
    searchWrap.className = 'kikx-composer-history__search-wrap';
    this._search = document.createElement('input');
    this._search.type = 'search';
    this._search.className = 'kikx-composer-history__search';
    this._search.placeholder = 'Search...';
    this._search.autocomplete = 'off';
    this._search.spellcheck = false;
    this._search.addEventListener('input', () => this._onSearchInput());
    this._search.addEventListener('keydown', (event) => this._onSearchKeydown(event));
    searchWrap.appendChild(this._search);

    this._status = document.createElement('div');
    this._status.className = 'kikx-composer-history__status';
    this._status.hidden = true;

    this._list = document.createElement('div');
    this._list.className = 'kikx-composer-history__list';
    this._list.setAttribute('role', 'listbox');
    this._list.addEventListener('scroll', () => this._onListScroll());

    this.replaceChildren(searchWrap, this._status, this._list);
  }

  _installOutsideHandler() {
    this._removeOutsideHandler();
    this._outsideHandler = (event) => {
      if (this.contains(event.target))
        return;
      if (event.target?.closest?.('.kikx-composer-history-button'))
        return;
      this.close();
    };
    document.addEventListener('pointerdown', this._outsideHandler, true);
  }

  _removeOutsideHandler() {
    if (!this._outsideHandler)
      return;
    document.removeEventListener('pointerdown', this._outsideHandler, true);
    this._outsideHandler = null;
  }

  _onSearchInput() {
    clearTimeout(this._searchTimer);
    this._searchTimer = setTimeout(() => {
      this._query = this._search.value;
      this._before = null;
      this._hasMoreOlder = true;
      this._entries = [];
      this._selectedIndex = -1;
      this._load({ reset: true });
    }, SEARCH_DEBOUNCE_MS);
    this._searchTimer.unref?.();
  }

  _onSearchKeydown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.close();
      return;
    }

    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      if (this._entries.length === 0)
        return;
      let direction = event.key === 'ArrowUp' ? -1 : 1;
      let next = this._selectedIndex < 0
        ? this._entries.length - 1
        : this._selectedIndex + direction;
      this._selectedIndex = Math.min(this._entries.length - 1, Math.max(0, next));
      this._renderSelection({ scroll: true });
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      let entry = this._entries[this._selectedIndex];
      if (entry)
        this._select(entry);
    }
  }

  async _load({ reset = false } = {}) {
    if (!this._app || !this._sessionID || this._loading)
      return;

    this._loading = true;
    this._setStatus('Loading...', true);
    try {
      let params = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (this._query)
        params.set('q', this._query);
      if (!reset && this._before != null)
        params.set('before', String(this._before));
      let result = await this._app._getJSON(`/api/v1/sessions/${encodeURIComponent(this._sessionID)}/composer/history?${params}`);
      let page = result?.data?.entries || [];
      this._hasMoreOlder = result?.data?.hasMoreOlder === true;
      this._before = result?.data?.oldestOrder ?? null;

      let list = this._list;
      let beforeHeight = list?.scrollHeight ?? 0;
      let beforeTop = list?.scrollTop ?? 0;
      this._entries = reset
        ? mergeLocalDraft(this._entriesForSession(), page, this._query)
        : mergeLocalDraft(this._entriesForSession(), [ ...page, ...this._entries ], this._query);
      this._renderEntries();

      if (reset) {
        if (list)
          list.scrollTop = list.scrollHeight;
        this._selectedIndex = this._entries.length - 1;
        this._renderSelection();
      } else if (list) {
        list.scrollTop = beforeTop + Math.max(0, list.scrollHeight - beforeHeight);
      }
      this._setStatus(this._entries.length === 0 ? 'No matching messages.' : '', this._entries.length === 0);
    } catch (error) {
      this._setStatus(error.message || 'History unavailable.', true);
    } finally {
      this._loading = false;
    }
  }

  _entriesForSession() {
    return this._entries.slice();
  }

  _onListScroll() {
    if (this._list.scrollTop > 24 || this._loading || !this._hasMoreOlder)
      return;
    this._load({ reset: false });
  }

  _renderEntries() {
    this._list.replaceChildren();
    for (let index = 0; index < this._entries.length; index++) {
      let entry = this._entries[index];
      let row = document.createElement('div');
      row.className = 'kikx-composer-history__item';
      row.dataset.index = String(index);
      row.setAttribute('role', 'option');
      row.addEventListener('click', () => this._select(entry));

      let body = document.createElement('div');
      body.className = 'kikx-composer-history__body';
      let text = document.createElement('div');
      text.className = 'kikx-composer-history__text';
      text.textContent = entry.text;
      body.appendChild(text);

      let meta = document.createElement('div');
      meta.className = 'kikx-composer-history__meta';
      let time = document.createElement('span');
      time.textContent = formatTimestamp(entry.createdAt);
      meta.appendChild(time);
      if (entry.kind === 'draft') {
        let badge = document.createElement('span');
        badge.className = 'kikx-composer-history__badge';
        badge.textContent = entry.local ? 'Local draft' : 'Draft';
        meta.appendChild(badge);
      }
      body.appendChild(meta);
      row.appendChild(body);
      row.appendChild(this._buildDeleteControl(entry));
      this._list.appendChild(row);
    }
    this._renderSelection();
  }

  _renderSelection({ scroll = false } = {}) {
    let rows = [ ...this._list.children ];
    for (let index = 0; index < rows.length; index++) {
      let selected = index === this._selectedIndex;
      rows[index].classList.toggle('is-selected', selected);
      rows[index].setAttribute('aria-selected', selected ? 'true' : 'false');
      if (selected && scroll)
        rows[index].scrollIntoView({ block: 'nearest' });
    }
  }

  _buildDeleteControl(entry) {
    let tagName = 'aeor-progress-button';
    let control;
    if (customElements.get?.(tagName)) {
      control = document.createElement(tagName);
      control.setAttribute('icon', 'close');
      control.setAttribute('label', 'Delete message');
      control.setAttribute('title', entry.kind === 'draft' ? 'Delete draft (hold)' : 'Delete message (hold)');
      control.setAttribute('duration', '500');
      control.setAttribute('size', '1.75rem');
    } else {
      control = document.createElement('button');
      control.type = 'button';
      control.textContent = '\u00d7';
      control.title = entry.kind === 'draft' ? 'Delete draft' : 'Delete message';
    }
    control.classList.add('kikx-composer-history__delete');
    let eventName = control.localName === 'aeor-progress-button' ? 'confirm' : 'click';
    control.addEventListener(eventName, async (event) => {
      event.preventDefault();
      event.stopPropagation();
      control.disabled = true;
      try {
        await deleteComposerHistoryEntry(this._app, entry);
        this._entries = this._entries.filter((candidate) => candidate.frameID !== entry.frameID);
        this._selectedIndex = Math.min(this._entries.length - 1, this._selectedIndex);
        this._renderEntries();
        this._setStatus(this._entries.length === 0 ? 'No matching messages.' : '', this._entries.length === 0);
      } catch (error) {
        control.disabled = false;
        this._setStatus(error.message || 'Could not delete history item.', true);
      }
    });
    control.addEventListener('click', (event) => event.stopPropagation());
    return control;
  }

  async _select(entry) {
    if (!entry)
      return;
    let replaced = await replaceComposerText(this._app, entry.text, {
      draftID: entry.kind === 'draft' ? entry.draftID : null,
      savedText: entry.kind === 'draft' ? entry.text : null,
    });
    if (replaced)
      this.close();
    else
      this._setStatus('Could not save the current draft before replacing it.', true);
  }

  _setStatus(text, visible) {
    this._status.textContent = text || '';
    this._status.hidden = visible !== true;
  }
}

function mergeLocalDraft(serverEntries, page, query) {
  let entries = Array.isArray(page) ? page.slice() : [];
  for (let local of listLocalComposerDrafts()) {
    let text = typeof local.text === 'string' ? local.text : '';
    if (text.trim() === '')
      continue;
    if (query && !text.toLowerCase().includes(query.toLowerCase()))
      continue;

    let index = entries.findIndex((entry) => entry.kind === 'draft' && local.draftID && entry.draftID === local.draftID);
    let localEntry = {
      frameID: index >= 0 ? entries[index].frameID : `local-draft-${local.draftID || local.updatedAt}`,
      id: index >= 0 ? entries[index].id : `local-draft-${local.draftID || local.updatedAt}`,
      kind: 'draft',
      draftID: local.draftID || null,
      text,
      order: index >= 0 ? entries[index].order : Number.MAX_SAFE_INTEGER,
      createdAt: index >= 0 ? entries[index].createdAt : local.updatedAt * 1000,
      updatedAt: local.updatedAt,
      authorDisplayName: 'You',
      local: true,
    };
    if (index >= 0)
      entries[index] = localEntry;
    else
      entries.push(localEntry);
  }
  entries.sort((left, right) => (left.order || 0) - (right.order || 0));
  return entries;
}

function formatTimestamp(value) {
  let number = Number(value);
  if (!Number.isFinite(number) || number <= 0)
    return '';
  let ms = number > 1_000_000_000_000_000 ? number / 1000 : number;
  try {
    return new Date(ms).toLocaleString();
  } catch (_error) {
    return '';
  }
}

if (typeof customElements !== 'undefined' && !customElements.get('kikx-composer-history'))
  customElements.define('kikx-composer-history', KikxComposerHistory);
