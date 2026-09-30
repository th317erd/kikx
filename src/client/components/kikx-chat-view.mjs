'use strict';

import './kikx-frame-item.mjs';
import { miniPreviewFrames, miniScale, MINI_DESIGN_WIDTH, MINI_DESIGN_HEIGHT } from './chat-view-model.mjs';

const FRAME_ENTER_ANIMATION_MS = 220;

export class KikxChatView extends HTMLElement {
  constructor() {
    super();
    this._frames = [];
    this._appState = {};
    this._mode = 'full';
    this._frameList = null;
    this._frameStream = null;
    this._miniScaler = null;
    this._resizeObserver = null;
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

    this._observeResize();
  }

  disconnectedCallback() {
    this._disconnectResize();
  }

  _observeResize() {
    if (this._resizeObserver || typeof ResizeObserver !== 'function')
      return;

    this._resizeObserver = new ResizeObserver(() => this._applyMiniScale());
    this._resizeObserver.observe(this);
  }

  _disconnectResize() {
    if (!this._resizeObserver)
      return;

    this._resizeObserver.disconnect();
    this._resizeObserver = null;
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
      message.textContent = 'No messages yet.';
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
    this.setAttribute('aria-hidden', 'true');

    // Render the real chat thread (same DOM as full mode) inside a scaler that
    // is sized to the design dimensions and scaled down to fit the card.
    let scaler = document.createElement('div');
    scaler.className = 'kikx-chat-view__scaler';
    scaler.style.setProperty('--kikx-mini-design-width', `${MINI_DESIGN_WIDTH}px`);
    scaler.style.setProperty('--kikx-mini-design-height', `${MINI_DESIGN_HEIGHT}px`);

    let list = document.createElement('div');
    list.className = 'kikx-frame-list';
    let stream = document.createElement('div');
    stream.className = 'kikx-frame-stream';
    for (let frame of miniPreviewFrames(this._frames))
      stream.appendChild(this._createFrameItem(frame));

    list.appendChild(stream);
    scaler.appendChild(list);
    this.appendChild(scaler);

    this._miniScaler = scaler;
    this._applyMiniScale();
  }

  _applyMiniScale() {
    if (this._mode !== 'mini' || !this._miniScaler)
      return;

    let rect = this.getBoundingClientRect();
    let scale = miniScale({ containerWidth: rect.width, containerHeight: rect.height });
    if (scale > 0)
      this._miniScaler.style.setProperty('--kikx-mini-scale', String(scale));
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
