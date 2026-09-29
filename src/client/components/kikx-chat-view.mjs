'use strict';

import './kikx-frame-item.mjs';
import { miniPreviewFrames } from './chat-view-model.mjs';

const FRAME_ENTER_ANIMATION_MS = 220;

export class KikxChatView extends HTMLElement {
  constructor() {
    super();
    this._frames = [];
    this._appState = {};
    this._mode = 'full';
    this._frameList = null;
    this._frameStream = null;
  }

  get mode() {
    return this._mode;
  }

  set mode(value) {
    let next = value === 'mini' ? 'mini' : 'full';
    if (next === this._mode)
      return;

    this._mode = next;
    this._render();
  }

  get frameList() {
    return this.querySelector('.kikx-frame-list');
  }

  get frameStream() {
    return this.querySelector('.kikx-frame-stream');
  }

  get frames() {
    return this._frames;
  }

  connectedCallback() {
    if (this.childNodes.length === 0 && this._frames.length > 0)
      this._render();
  }

  update(input = {}) {
    if (Array.isArray(input.frames))
      this._frames = input.frames;

    if (input.appState)
      this._appState = input.appState;

    this._render();
  }

  setFrames(frames, appState) {
    this._frames = Array.isArray(frames) ? frames : [];
    if (appState)
      this._appState = appState;

    this._render();
  }

  // Incremental update used by the app's frame-runtime flush path. Preserves
  // existing items and only updates touched/new frames, keeping the same DOM
  // contract the UI tests assert.
  syncFrames(frames, appState, options = {}) {
    this._frames = Array.isArray(frames) ? frames : [];
    if (appState)
      this._appState = appState;

    if (this._mode === 'mini') {
      this._render();
      return { insertedNew: false };
    }

    let stream = this.frameStream;
    if (!stream) {
      this._render();
      return { insertedNew: false };
    }

    let touchedFrameIDs = options.touchedFrameIDs instanceof Set ? options.touchedFrameIDs : null;
    let existingByID = new Map();
    for (let item of Array.from(stream.children).filter((node) => node.matches?.('kikx-frame-item[data-frame-id]')))
      existingByID.set(item.dataset.frameId, item);

    let cursor = stream.firstElementChild;
    let insertedNew = false;

    for (let frame of this._frames) {
      let item = existingByID.get(frame.id);
      let isNewItem = false;
      if (!item) {
        item = this._createFrameItem(frame);
        isNewItem = true;
      } else {
        existingByID.delete(frame.id);
        if (options.force === true || !touchedFrameIDs || touchedFrameIDs.has(frame.id))
          item.updateFrame(frame, this._appState, { force: options.force === true });
      }

      if (item === cursor) {
        cursor = cursor.nextElementSibling;
      } else {
        if (isNewItem)
          prepareFrameEntryAnimation(item);

        stream.insertBefore(item, cursor);

        if (isNewItem) {
          insertedNew = true;
          startFrameEntryAnimation(item);
        }
      }
    }

    for (let stale of existingByID.values())
      stale.remove();

    return { insertedNew };
  }

  _render() {
    if (this._mode === 'mini') {
      this._renderMini();
      return;
    }

    this._renderFull();
  }

  _renderFull() {
    this.textContent = '';
    this.classList.add('kikx-chat-view--full');
    this.classList.remove('kikx-chat-view--mini');
    this.setAttribute('role', 'list');

    if (this._frames.length === 0) {
      let empty = document.createElement('div');
      empty.className = 'kikx-thread__empty';
      let message = document.createElement('p');
      message.textContent = 'No frames yet.';
      empty.appendChild(message);
      this.appendChild(empty);
      return;
    }

    let list = document.createElement('div');
    list.className = 'kikx-frame-list';
    list.setAttribute('role', 'list');
    let stream = document.createElement('div');
    stream.className = 'kikx-frame-stream';
    for (let frame of this._frames)
      stream.appendChild(this._createFrameItem(frame));

    list.appendChild(stream);
    this.appendChild(list);
  }

  _renderMini() {
    this.textContent = '';
    this.classList.add('kikx-chat-view--mini');
    this.classList.remove('kikx-chat-view--full');
    this.removeAttribute('role');

    let preview = document.createElement('div');
    preview.className = 'kikx-chat-view__preview';
    preview.setAttribute('aria-hidden', 'true');

    for (let frame of miniPreviewFrames(this._frames))
      preview.appendChild(this._createFrameItem(frame));

    this.appendChild(preview);
  }

  _createFrameItem(frame) {
    let item = document.createElement('kikx-frame-item');
    item.updateFrame(frame, this._appState);
    return item;
  }
}

function prepareFrameEntryAnimation(item) {
  if (!item || prefersReducedMotion())
    return;

  item.classList.add('kikx-frame--animating', 'kikx-frame--entering');
}

function startFrameEntryAnimation(item) {
  if (!item || prefersReducedMotion())
    return;

  scheduleAnimationFrame(() => {
    item.classList.remove('kikx-frame--entering');
    let finish = () => item.classList.remove('kikx-frame--animating');
    item.addEventListener('transitionend', finish, { once: true });
    setTimeout(finish, FRAME_ENTER_ANIMATION_MS + 80);
  });
}

function prefersReducedMotion() {
  return typeof matchMedia === 'function'
    && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function scheduleAnimationFrame(callback) {
  if (typeof requestAnimationFrame === 'function')
    return requestAnimationFrame(callback);

  return setTimeout(callback, 0);
}

if (typeof customElements !== 'undefined' && !customElements.get('kikx-chat-view'))
  customElements.define('kikx-chat-view', KikxChatView);
