'use strict';

import './kikx-frame-item.mjs';
import { guardClientOperation } from '../lib/error-boundary.mjs';
import { miniPreviewFrames, miniScale, MINI_DESIGN_WIDTH, MINI_DESIGN_HEIGHT } from './chat-view-model.mjs';
import { countRebuild } from './render-stats.mjs';
import { captureFrameListAnchor, restoreFrameListAnchor } from './frame-scroll-anchor.mjs';

const FRAME_ENTER_ANIMATION_MS = 220;

// Keep the live thread bounded. The full frame list remains in state (so older
// pages can be revealed without a refetch), but only a recent window is kept in
// the DOM. Scrolling to the top reveals older state frames in chunks; scrolling
// back to the bottom switches back to the newest window.
export const MAX_RENDERED_FRAMES = 200;
export const MAX_TOTAL_RENDERED_FRAMES = 800;
export const RENDER_WINDOW_REVEAL = 40;

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
    this._windowStart = 0;
    this._windowEnd = 0;
    this._windowStartFrameID = null;
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

    this._pendingWindowStart = Number.isInteger(input.windowStart) ? input.windowStart : null;
    this._render();
  }

  setFrames(frames, appState) {
    this._frames = Array.isArray(frames) ? frames : [];
    if (appState)
      this._appState = appState;

    this._render();
  }

  get windowStart() {
    return this._windowStart;
  }

  get windowStartFrameID() {
    return this._windowStartFrameID;
  }

  get windowEnd() {
    return this._windowEnd;
  }

  // Incremental update used by the app's frame-runtime flush path. Preserves
  // existing items and only updates touched/new frames, keeping the same DOM
  // contract the UI tests assert. Only the active render window is materialized;
  // frames outside it stay in `_frames` and can be revealed by scrolling up.
  syncFrames(frames, appState, options = {}) {
    let previousFrames = this._frames;
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

    let wasAtBottom = this._isAtBottom();
    let prependedCount = Math.max(0, this._frames.length - previousFrames.length);
    let currentLength = Math.max(0, this._windowEnd - this._windowStart);
    let windowOptions = options;
    if (!Number.isInteger(options.maxRendered) && currentLength > 0)
      windowOptions = { ...windowOptions, maxRendered: Math.min(MAX_TOTAL_RENDERED_FRAMES, currentLength) };
    if (options.prepend === true && prependedCount > 0) {
      windowOptions = {
        ...windowOptions,
        windowStart: Math.max(0, this._windowStart - prependedCount),
        maxRendered: Math.min(
          MAX_TOTAL_RENDERED_FRAMES,
          Math.max(windowOptions.maxRendered || currentLength, currentLength + prependedCount),
        ),
      };
    }

    let window = this._resolveWindow(windowOptions);
    let touchedFrameIDs = options.touchedFrameIDs instanceof Set ? options.touchedFrameIDs : null;
    let animate = options.animate !== false;
    let existingByID = new Map();
    for (let item of Array.from(stream.children).filter((node) => node.matches?.('kikx-frame-item[data-frame-id]')))
      existingByID.set(item.dataset.frameId, item);

    let cursor = stream.firstElementChild;
    let insertedNew = false;

    for (let frame of this._frames.slice(window.start, window.end)) {
      let item = existingByID.get(frame.id);
      let isNewItem = false;
      if (!item) {
        item = guardClientOperation('kikx-chat-view.createFrameItem', () => this._createFrameItem(frame), {
          frameID: frame.id,
          frameType: frame.type,
        });
        if (!item)
          continue;
        isNewItem = true;
      } else {
        existingByID.delete(frame.id);
        if (options.force === true || !touchedFrameIDs || touchedFrameIDs.has(frame.id)) {
          guardClientOperation('kikx-chat-view.updateFrame', () => {
            item.updateFrame(frame, this._appState, { force: options.force === true });
          }, { frameID: frame.id, frameType: frame.type });
        }
      }

      if (item === cursor) {
        cursor = cursor.nextElementSibling;
      } else {
        if (isNewItem && animate)
          prepareFrameEntryAnimation(item);

        stream.insertBefore(item, cursor);

        if (isNewItem) {
          insertedNew = true;
          if (animate)
            startFrameEntryAnimation(item);
        }
      }
    }

    for (let stale of existingByID.values())
      stale.remove();

    this._windowStart = window.start;
    this._windowEnd = window.end;
    this._windowStartFrameID = this._frames[window.start]?.id || null;

    return { insertedNew };
  }

  // Reveal older frames already held in state. Returns true when the window
  // actually moved; the caller can then avoid an unnecessary server fetch.
  expandOlderFrames(count = RENDER_WINDOW_REVEAL) {
    let amount = Math.max(1, Number.isFinite(count) ? Math.trunc(count) : RENDER_WINDOW_REVEAL);
    let nextStart = Math.max(0, this._windowStart - amount);
    if (nextStart === this._windowStart)
      return false;

    let list = this.frameList;
    let anchor = captureFrameListAnchor(list);
    let beforeHeight = list?.scrollHeight ?? 0;
    let beforeTop = list?.scrollTop ?? 0;
    let added = this._windowStart - nextStart;
    let currentLength = Math.max(0, this._windowEnd - this._windowStart);
    // Grow the rendered window instead of dropping the newest end. Dropping the
    // opposite end forced a large scrollTop correction and looked like a jump.
    let maxRendered = Math.min(MAX_TOTAL_RENDERED_FRAMES, currentLength + added);
    this.syncFrames(this._frames, this._appState, {
      windowStart: nextStart,
      maxRendered: Math.max(MAX_RENDERED_FRAMES, maxRendered),
      animate: false,
    });
    if (list) {
      this._markProgrammaticScroll();
      if (!restoreFrameListAnchor(list, anchor)) {
        // Keep the content under the user's eyes stationary when older frames are
        // inserted above it.
        list.scrollTop = beforeTop + Math.max(0, list.scrollHeight - beforeHeight);
      }
    }
    return true;
  }

  // Reveal newer state frames without replacing the whole rendered window.
  // The previous top-visible frame stays fixed, so reaching the bottom extends
  // the list downward instead of jumping thousands of pixels to a new window.
  expandNewerFrames(count = RENDER_WINDOW_REVEAL) {
    let amount = Math.max(1, Number.isFinite(count) ? Math.trunc(count) : RENDER_WINDOW_REVEAL);
    if (this._windowEnd >= this._frames.length)
      return false;

    let stream = this.frameStream;
    if (!stream) {
      this._render();
      return false;
    }

    let nextEnd = Math.min(
      this._frames.length,
      this._windowEnd + amount,
      this._windowStart + MAX_TOTAL_RENDERED_FRAMES,
    );
    if (nextEnd <= this._windowEnd)
      return false;

    // Append only the newly revealed frames. Do NOT re-render the existing
    // window: an unrelated off-screen message finishing its Markdown can change
    // height above the viewport, and re-rendering it here forced a multi-thousand
    // pixel scrollTop correction (the recorded jump-back).
    for (let frame of this._frames.slice(this._windowEnd, nextEnd))
      stream.appendChild(this._createFrameItem(frame));

    this._windowEnd = nextEnd;
    return true;
  }

  // Return to the newest window after the user has finished reading older
  // frames. Returns true when the window changed.
  showLatestFrames() {
    let latestStart = Math.max(0, this._frames.length - MAX_RENDERED_FRAMES);
    if (latestStart === this._windowStart)
      return false;

    this.syncFrames(this._frames, this._appState, { windowStart: latestStart, animate: false });
    return true;
  }

  _resolveWindow(options = {}) {
    let frames = this._frames;
    let max = Number.isInteger(options.maxRendered) && options.maxRendered > 0
      ? Math.min(options.maxRendered, MAX_TOTAL_RENDERED_FRAMES)
      : MAX_RENDERED_FRAMES;

    let start;
    if (options.followLatest === true) {
      start = Math.max(0, frames.length - max);
    } else if (Number.isInteger(options.windowStart)) {
      start = Math.min(Math.max(0, options.windowStart), Math.max(0, frames.length - 1));
    } else if (this._windowStartFrameID) {
      let index = frames.findIndex((frame) => frame?.id === this._windowStartFrameID);
      start = index >= 0 ? index : Math.max(0, frames.length - max);
    } else {
      start = Math.max(0, frames.length - max);
    }

    let end = Math.min(frames.length, start + max);
    return { start, end };
  }

  _isAtBottom() {
    let list = this.frameList;
    if (!list)
      return true;

    return list.scrollHeight - list.scrollTop - list.clientHeight <= 50;
  }

  _markProgrammaticScroll() {
    let app = this.closest?.('kikx-app');
    if (app)
      app._ignoreFrameScrollUntil = Date.now() + 200;
  }

  _scrollToBottom() {
    let list = this.frameList;
    if (!list)
      return;
    this._markProgrammaticScroll();
    list.scrollTop = Math.max(0, list.scrollHeight - list.clientHeight);
  }

  _render() {
    guardClientOperation('kikx-chat-view.render', () => {
      if (this._mode === 'mini') {
        this._renderMini();
        return;
      }

      this._renderFull();
    });
  }

  _renderFull() {
    countRebuild('chatView');
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
    let window = this._resolveWindow(Number.isInteger(this._pendingWindowStart) ? { windowStart: this._pendingWindowStart } : {});
    this._pendingWindowStart = null;
    this._windowStart = window.start;
    this._windowEnd = window.end;
    this._windowStartFrameID = this._frames[window.start]?.id || null;
    for (let frame of this._frames.slice(window.start, window.end))
      stream.appendChild(this._createFrameItem(frame));

    list.appendChild(stream);
    this.appendChild(list);
  }

  _renderMini() {
    countRebuild('chatView');
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
