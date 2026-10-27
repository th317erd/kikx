'use strict';

import { ScrollLayoutModel } from './scroll-layout.mjs';

const DEFAULT_OVERSCAN = 1.5;
const LOAD_THRESHOLD_PX = 240;

function now() {
  return globalThis.performance?.now?.() ?? Date.now();
}

export class AeorScrollView extends HTMLElement {
  constructor() {
    super();
    this._source = null;
    this._layout = null;
    this._viewport = null;
    this._windowEl = null;
    this._topSpacer = null;
    this._bottomSpacer = null;
    this._topStatus = null;
    this._bottomStatus = null;
    this._itemNodes = new Map();
    this._renderScheduled = false;
    this._measureScheduled = false;
    this._userIntentUntil = 0;
    this._pointer = { x: 0, y: 0, at: 0, inside: false };
    this._programmaticScroll = false;
    this._ignoreScrollUntil = 0;
    this._follow = true;
    this._loadState = {
      top: 'idle',
      bottom: 'idle',
      topError: '',
      bottomError: '',
    };
    this._inflight = new Set();
    this._loadedMin = Infinity;
    this._loadedMax = -1;
    this._initialTailPending = false;
    this._renderCount = 0;
    this._lastScrollTop = 0;
    this._lastAnchor = null;
    this._pendingAnchor = null;
    this._pendingFocal = null;
    this._scrollAdjustment = 0;
    this._resizeObserver = null;
  }

  connectedCallback() {
    if (this._viewport)
      return;
    this._build();
    this._resizeObserver = new ResizeObserver(() => {
      if (this._measureScheduled)
        return;
      this._measureScheduled = true;
      requestAnimationFrame(() => {
        this._measureScheduled = false;
        this._measureRenderedItems();
      });
    });
    this._resizeObserver.observe(this._viewport);
    this._viewport.addEventListener('scroll', () => this._onScroll(), { passive: true });
    this._viewport.addEventListener('wheel', (event) => this._onWheel(event), { passive: true });
    this._viewport.addEventListener('pointerdown', () => { this._userIntentUntil = now() + 1500; this._pointer.at = 0; }, { passive: true });
    this._viewport.addEventListener('pointermove', (event) => {
      this._pointer = { x: event.clientX, y: event.clientY, at: now(), inside: true };
    }, { passive: true });
    this._viewport.addEventListener('pointerleave', () => { this._pointer.inside = false; }, { passive: true });
    this._viewport.addEventListener('touchstart', () => { this._userIntentUntil = now() + 1500; }, { passive: true });
    this._viewport.addEventListener('keydown', (event) => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key))
        this._userIntentUntil = now() + 1500;
    });
    this._scheduleRender();
  }

  disconnectedCallback() {
    this._resizeObserver?.disconnect();
    this._resizeObserver = null;
    this._clearItemNodes();
  }

  _build() {
    this.classList.add('aeor-scrollview');
    this.textContent = '';
    this._topStatus = document.createElement('div');
    this._topStatus.className = 'aeor-scrollview__status aeor-scrollview__status--top';
    this._topStatus.setAttribute('role', 'status');
    this._topStatus.hidden = true;

    this._bottomStatus = document.createElement('div');
    this._bottomStatus.className = 'aeor-scrollview__status aeor-scrollview__status--bottom';
    this._bottomStatus.setAttribute('role', 'status');
    this._bottomStatus.hidden = true;

    this._viewport = document.createElement('div');
    this._viewport.className = 'aeor-scrollview__viewport';
    this._viewport.setAttribute('role', 'list');
    this._viewport.tabIndex = 0;

    this._topSpacer = document.createElement('div');
    this._topSpacer.className = 'aeor-scrollview__spacer aeor-scrollview__spacer--top';
    this._topSpacer.setAttribute('aria-hidden', 'true');
    this._bottomSpacer = document.createElement('div');
    this._bottomSpacer.className = 'aeor-scrollview__spacer aeor-scrollview__spacer--bottom';
    this._bottomSpacer.setAttribute('aria-hidden', 'true');
    this._windowEl = document.createElement('div');
    this._windowEl.className = 'aeor-scrollview__window';

    this._viewport.append(this._topSpacer, this._windowEl, this._bottomSpacer);
    this.append(this._topStatus, this._viewport, this._bottomStatus);
  }

  setSource(source) {
    this._source = source;
    let total = Math.max(0, Math.trunc(Number(source?.total) || 0));
    this._layout = new ScrollLayoutModel({
      totalItems: total,
      estimateHeight: (index) => source?.estimateHeight?.(index) ?? 96,
    });
    this._loadedMin = Infinity;
    this._loadedMax = -1;
    this._clearItemNodes();
    this.follow = true;
    this._initialTailPending = true;
    this._scheduleRender();
    if (total > 0)
      this._loadRange(Math.max(0, total - (source.pageSize || 40)), total, 'bottom', { initial: true });
    return this;
  }

  get follow() {
    return this._follow;
  }

  set follow(value) {
    let next = value === true;
    if (next === this._follow)
      return;
    this._follow = next;
    this.dispatchEvent(new CustomEvent('scrollview-follow-change', {
      detail: { follow: next },
      bubbles: true,
    }));
  }

  get layout() {
    return this._layout;
  }

  get viewport() {
    return this._viewport;
  }

  setTotal(total) {
    if (!this._layout)
      return;
    if (!this._follow)
      this._pendingAnchor ||= this._layout.captureAnchor(this._viewport.scrollTop, this._viewport.clientHeight);
    this._layout.setTotal(total);
    this._scheduleRender({ follow: this._follow });
  }

  refreshRange() {
    this._scheduleRender({ follow: this._follow });
  }

  scrollToEnd({ follow = true } = {}) {
    this.follow = follow;
    this._initialTailPending = follow;
    let total = this._source?.total || 0;
    if (total > 0)
      this._loadRange(Math.max(0, total - (this._source.pageSize || 40)), total, 'bottom', { initial: true });
    this._scheduleRender({ follow });
  }

  scrollToIndex(index, { align = 'start' } = {}) {
    if (!this._layout)
      return;
    let target = Math.min(Math.max(0, Math.trunc(index)), Math.max(0, this._layout.totalItems - 1));
    this.follow = false;
    this._pendingJump = { index: target, align, stable: 0, lastHeight: -1, startedAt: now() };
    // Move the viewport into the target's estimated range immediately so the
    // next render materializes the target instead of the previous window.
    this._setScrollTop(this._layout.offsetOf(target));
    let start = Math.max(0, target - 20);
    let end = Math.min(this._layout.totalItems, target + 20);
    this._loadRange(start, end, 'bottom');
    this._scheduleRender();
  }

  updateItem(index, item) {
    if (!this._layout || !item)
      return;
    if (!this._follow)
      this._pendingAnchor ||= this._layout.captureAnchor(this._viewport.scrollTop, this._viewport.clientHeight);
    this._layout.replaceRange(index, [ item ]);
    if (this._follow)
      this._scheduleRender({ follow: true });
    else
      this._scheduleRender({ preserveAnchor: true });
  }

  metrics() {
    let anchor = this._layout?.captureAnchor(this._viewport?.scrollTop || 0, this._viewport?.clientHeight || 0) || null;
    let rendered = 0;
    for (let node of this._itemNodes.values()) {
      if (node.isConnected)
        rendered++;
    }
    let loaded = 0;
    for (let index = 0; index < (this._layout?.totalItems || 0); index++) {
      if (this._layout.slot(index)?.loaded)
        loaded++;
    }
    return {
      total: this._layout?.totalItems || 0,
      loaded,
      loadedMin: Number.isFinite(this._loadedMin) ? this._loadedMin : null,
      loadedMax: this._loadedMax >= 0 ? this._loadedMax : null,
      rendered,
      scrollTop: Math.round((this._viewport?.scrollTop || 0) * 100) / 100,
      scrollHeight: Math.round((this._viewport?.scrollHeight || 0) * 100) / 100,
      clientHeight: this._viewport?.clientHeight || 0,
      follow: this._follow,
      topState: this._loadState.top,
      bottomState: this._loadState.bottom,
      anchor,
      renderCount: this._renderCount,
      requests: this._source?.requests ?? null,
      failures: this._source?.failures ?? null,
    };
  }

  _scheduleRender({ follow = false, preserveAnchor = true } = {}) {
    this._renderOptions = {
      follow: follow || this._renderOptions?.follow === true,
      preserveAnchor: preserveAnchor && this._renderOptions?.preserveAnchor !== false,
    };
    if (this._renderScheduled)
      return;
    this._renderScheduled = true;
    requestAnimationFrame(() => {
      this._renderScheduled = false;
      let options = this._renderOptions || {};
      this._renderOptions = {};
      this._render(options);
    });
  }

  _render(options = {}) {
    if (!this._layout || !this._viewport)
      return;
    let viewport = this._viewport;
    let height = viewport.clientHeight || 1;
    let scrollTop = viewport.scrollTop || 0;
    if (this._pendingJump)
      scrollTop = this._layout.offsetOf(this._pendingJump.index);
    let anchor = this._pendingAnchor || (options.preserveAnchor !== false && !this._pendingJump
      ? this._layout.captureAnchor(scrollTop, height)
      : null);
    this._pendingAnchor = null;
    let overscan = Number(this.getAttribute('overscan')) || DEFAULT_OVERSCAN;
    let window = this._layout.windowFor(scrollTop, height, overscan);
    if (this._pendingFocal && Number.isInteger(this._pendingFocal.index)) {
      window = {
        start: Math.min(window.start, this._pendingFocal.index),
        end: Math.max(window.end, this._pendingFocal.index + 1),
      };
    }
    this._renderWindow(window, anchor, options);
    this._renderCount++;
    if (options.follow === true || this._follow)
      this._placeBottom({ onlyIfPending: this._initialTailPending || options.follow === true });
    this._ensureVisibleLoaded(window);
    this._updateStatus();
    this.dispatchEvent(new CustomEvent('scrollview-render', {
      detail: { start: window.start, end: window.end, metrics: this.metrics() },
      bubbles: true,
    }));
  }

  _renderWindow(window, anchor, options) {
    let topHeight = this._layout.offsetOf(window.start);
    let bottomHeight = Math.max(0, this._layout.totalHeight() - this._layout.offsetOf(window.end));
    this._topSpacer.style.height = `${topHeight}px`;
    this._bottomSpacer.style.height = `${bottomHeight}px`;

    let nextKeys = new Set();
    let nodes = [];
    for (let index = window.start; index < window.end; index++) {
      let slot = this._layout.slot(index);
      if (!slot)
        continue;
      let key = slot.key || `virtual:${index}`;
      nextKeys.add(key);
      let node = this._itemNodes.get(key);
      if (slot.loaded) {
        let item = this._source?.itemAt?.(index);
        if (node?.dataset?.virtual === 'true') {
          node.remove();
          node = null;
        }
        if (!node) {
          node = this._createItemNode(item, index);
          this._itemNodes.set(key, node);
        } else if (item) {
          this._updateItemNode(node, item, index);
        }
      } else if (!node || node.dataset.virtual !== 'true') {
        this._forgetNode(node);
        node = this._createVirtualNode(index, slot);
        this._itemNodes.set(key, node);
      }
      nodes.push(node);
    }

    for (let [key, node] of this._itemNodes) {
      if (!nextKeys.has(key)) {
        this._forgetNode(node);
        this._itemNodes.delete(key);
      }
    }
    this._windowEl.replaceChildren(...nodes);

    if (this._pendingFocal && !this._pendingJump) {
      let focal = this._pendingFocal;
      this._pendingFocal = null;
      let node = this._itemNodes.get(focal.key);
      if (node?.isConnected && node.dataset.virtual !== 'true') {
        let newTop = node.getBoundingClientRect().top;
        this._setScrollTop(this._viewport.scrollTop + (newTop - focal.oldTop));
      }
    }

    let target = null;
    if (this._pendingJump) {
      let jump = this._pendingJump;
      let slot = this._layout.slot(jump.index);
      let loaded = slot?.loaded === true;
      let height = this._layout.heightOf(jump.index);
      let top = this._layout.offsetOf(jump.index);
      if (jump.align === 'end')
        top = top + height - this._viewport.clientHeight;
      else if (jump.align === 'center')
        top = top - (this._viewport.clientHeight - height) / 2;
      target = Math.max(0, top);
      if (loaded && Math.abs(height - jump.lastHeight) < 0.5)
        jump.stable += 1;
      else
        jump.stable = 0;
      jump.lastHeight = height;
      if ((loaded && jump.stable >= 2) || now() - jump.startedAt > 1500)
        this._pendingJump = null;
    } else if (this._follow && (options.follow === true || this._initialTailPending)) {
      target = Math.max(0, this._layout.totalHeight() - this._viewport.clientHeight);
    } else if (anchor) {
      target = this._layout.restoreAnchor(anchor);
    }
    if (target != null)
      this._setScrollTop(target);
    this._lastAnchor = anchor;
  }

  _createItemNode(item, index) {
    let node = this._source?.renderItem?.(item, { index }) || document.createElement('div');
    node.classList?.add('aeor-scrollview__item');
    node.dataset.index = String(index);
    node.dataset.key = item?.key || '';
    node.dataset.virtual = 'false';
    this._observeItem(node, index);
    return node;
  }

  _updateItemNode(node, item, index) {
    try {
      this._source?.updateItem?.(node, item, { index });
    } catch (_) {}
    node.dataset.index = String(index);
    node.dataset.key = item?.key || '';
    node.dataset.virtual = 'false';
    this._observeItem(node, index);
  }

  _createVirtualNode(index, slot) {
    let node = document.createElement('div');
    node.className = 'aeor-scrollview__item aeor-scrollview__item--virtual';
    node.dataset.index = String(index);
    node.dataset.virtual = 'true';
    node.style.height = `${this._layout.heightOf(index)}px`;
    node.textContent = 'Loading message…';
    return node;
  }

  _observeItem(node, index) {
    if (node._scrollviewObserved || !this._resizeObserver)
      return;
    node._scrollviewObserved = true;
    this._resizeObserver.observe(node);
    node._scrollviewIndex = index;
  }

  _measureRenderedItems() {
    if (!this._layout)
      return;
    let anchor = this._follow
      ? null
      : (this._pendingAnchor || this._layout.captureAnchor(this._viewport.scrollTop, this._viewport.clientHeight));
    this._pendingAnchor = null;
    let changed = false;
    for (let node of this._itemNodes.values()) {
      if (!node.isConnected || node.dataset.virtual === 'true')
        continue;
      let index = Number(node.dataset.index);
      if (!Number.isInteger(index))
        continue;
      let height = node.getBoundingClientRect().height;
      if (height > 0 && this._layout.setMeasuredHeight(index, height) !== 0)
        changed = true;
    }
    if (!changed)
      return;
    if (this._follow) {
      this._scheduleRender({ follow: true });
      return;
    }
    if (anchor) {
      this._setScrollTop(this._layout.restoreAnchor(anchor));
      this._scheduleRender();
    }
  }

  _captureFocalPoint() {
    if (!this._viewport)
      return null;
    let viewportRect = this._viewport.getBoundingClientRect();
    let center = viewportRect.top + viewportRect.height / 2;
    let attention = this._attentionFocal(viewportRect, center);
    if (attention)
      return this._focalRecord(attention);

    let candidates = [ ...this._itemNodes.values() ]
      .filter((node) => node.isConnected && node.dataset.virtual !== 'true')
      .map((node) => {
        let rect = node.getBoundingClientRect();
        if (rect.bottom < viewportRect.top || rect.top > viewportRect.bottom)
          return null;
        let distance = rect.top <= center && rect.bottom >= center
          ? 0
          : Math.min(Math.abs(rect.top - center), Math.abs(rect.bottom - center));
        return { node, key: node.dataset.key || '', rect, distance };
      })
      .filter(Boolean)
      .sort((left, right) => left.distance - right.distance || left.rect.top - right.rect.top || left.key.localeCompare(right.key));
    let candidate = candidates[0];
    if (!candidate)
      return null;
    return this._focalRecord({ key: candidate.key, node: candidate.node, oldTop: candidate.rect.top });
  }

  _focalRecord(candidate) {
    if (!candidate?.node)
      return null;
    let index = Number(candidate.node.dataset.index);
    if (!Number.isInteger(index))
      return null;
    return {
      ...candidate,
      index,
      oldOffset: this._layout.offsetOf(index),
    };
  }

  _attentionFocal(viewportRect, center) {
    let resolveNode = (node) => {
      let element = node?.nodeType === 3 ? node.parentElement : node;
      let item = element?.closest?.('.aeor-scrollview__item');
      if (!item || item.dataset.virtual === 'true' || !item.isConnected)
        return null;
      let rect = item.getBoundingClientRect();
      if (rect.bottom < viewportRect.top || rect.top > viewportRect.bottom)
        return null;
      return { node: item, key: item.dataset.key || '', rect };
    };

    let focused = document.activeElement && document.activeElement !== this._viewport
      ? resolveNode(document.activeElement)
      : null;
    if (focused)
      return this._focalRecord({ key: focused.key, node: focused.node, oldTop: focused.rect.top });

    let selection = document.getSelection?.();
    if (selection && selection.rangeCount > 0 && selection.isCollapsed !== true) {
      let range = selection.getRangeAt(0);
      let ends = [ resolveNode(range.startContainer), resolveNode(range.endContainer) ].filter(Boolean);
      if (ends.length > 0) {
        ends.sort((left, right) => {
          let leftDistance = left.rect.top <= center && left.rect.bottom >= center ? 0 : Math.min(Math.abs(left.rect.top - center), Math.abs(left.rect.bottom - center));
          let rightDistance = right.rect.top <= center && right.rect.bottom >= center ? 0 : Math.min(Math.abs(right.rect.top - center), Math.abs(right.rect.bottom - center));
          return leftDistance - rightDistance;
        });
        return this._focalRecord({ key: ends[0].key, node: ends[0].node, oldTop: ends[0].rect.top });
      }
    }

    if (this._pointer.inside && now() - this._pointer.at >= 250) {
      let under = document.elementFromPoint(this._pointer.x, this._pointer.y);
      let pointed = resolveNode(under);
      if (pointed)
        return this._focalRecord({ key: pointed.key, node: pointed.node, oldTop: pointed.rect.top });
    }

    return null;
  }

  _ensureVisibleLoaded(window) {
    if (!this._layout)
      return;
    let start = window.start;
    let end = window.end;
    let firstUnloaded = -1;
    let lastUnloaded = -1;
    for (let index = start; index < end; index++) {
      if (!this._layout.slot(index)?.loaded) {
        if (firstUnloaded < 0)
          firstUnloaded = index;
        lastUnloaded = index;
      }
    }
    if (firstUnloaded >= 0)
      this._loadRange(firstUnloaded, lastUnloaded + 1, firstUnloaded < (this._loadedMin || 0) ? 'top' : 'bottom');
  }

  _loadRange(start, end, direction = 'bottom', options = {}) {
    if (!this._source || !this._layout)
      return Promise.resolve(false);
    let pageSize = Math.max(1, Number(this._source.pageSize) || 40);
    let total = this._layout.totalItems;
    let pageStart = Math.max(0, Math.floor(start / pageSize) * pageSize);
    let pageEnd = Math.min(total, Math.max(pageStart + pageSize, Math.ceil(end / pageSize) * pageSize));
    if (pageEnd <= pageStart)
      return Promise.resolve(false);
    let key = `${direction}:${pageStart}:${pageEnd}`;
    if (this._inflight.has(key))
      return Promise.resolve(false);
    this._inflight.add(key);
    this._loadState[direction] = 'loading';
    this._loadState[`${direction}Error`] = '';
    this._updateStatus();
    return Promise.resolve(this._source.loadPage({ start: pageStart, end: pageEnd, direction }))
      .then((result) => {
        if (!result?.items)
          return false;
        // Capture the reader's focal point BEFORE the geometry changes and
        // accumulate its layout delta. Concurrent page loads must each add
        // their own delta; a single shared pending focal point loses all but
        // the first page and produces a multi-page jump.
        let focal = !this._follow ? this._captureFocalPoint() : null;
        let focalOldOffset = focal ? this._layout.offsetOf(focal.index) : 0;
        if (Number.isFinite(result.total) && result.total !== this._layout.totalItems)
          this._layout.setTotal(result.total);
        this._layout.replaceRange(result.start ?? pageStart, result.items);
        this._loadedMin = Math.min(this._loadedMin, result.start ?? pageStart);
        this._loadedMax = Math.max(this._loadedMax, (result.end ?? pageEnd) - 1);
        this._loadState[direction] = 'idle';
        this._initialTailPending = false;
        this._scheduleRender({ follow: this._follow });
        return true;
      })
      .catch((error) => {
        this._loadState[direction] = 'error';
        this._loadState[`${direction}Error`] = error?.message || String(error);
        this._updateStatus();
        return false;
      })
      .finally(() => {
        this._inflight.delete(key);
      });
  }

  _loadOlder() {
    if (!this._layout)
      return;
    let start = Number.isFinite(this._loadedMin) ? this._loadedMin : this._layout.indexAtOffset(this._viewport.scrollTop);
    let pageSize = Math.max(1, Number(this._source?.pageSize) || 40);
    if (start <= 0)
      return;
    let from = Math.max(0, start - pageSize);
    this._loadRange(from, start, 'top');
  }

  _loadNewer() {
    if (!this._layout)
      return;
    let start = this._loadedMax >= 0 ? this._loadedMax + 1 : this._layout.indexAtOffset(this._viewport.scrollTop + this._viewport.clientHeight);
    if (start >= this._layout.totalItems)
      return;
    let pageSize = Math.max(1, Number(this._source?.pageSize) || 40);
    this._loadRange(start, Math.min(this._layout.totalItems, start + pageSize), 'bottom');
  }

  _onWheel(event) {
    this._userIntentUntil = now() + 1500;
    if (!this._viewport)
      return;
    let max = Math.max(0, this._viewport.scrollHeight - this._viewport.clientHeight);
    let atTop = this._viewport.scrollTop <= 1;
    let atBottom = this._viewport.scrollTop >= max - 1;
    if (event.deltaY < 0 && atTop && this._loadedMin > 0)
      this._loadOlder();
    else if (event.deltaY > 0 && atBottom && this._loadedMax >= 0 && this._loadedMax < this._layout.totalItems - 1)
      this._loadNewer();
    else if (event.deltaY < 0 && atTop && this._loadedMin <= 0 && this._loadedMax < this._layout.totalItems - 1)
      this._loadNewer();
  }

  _onScroll() {
    if (!this._viewport || !this._layout)
      return;
    let scrollTop = this._viewport.scrollTop;
    let total = this._layout.totalHeight();
    let max = Math.max(0, total - this._viewport.clientHeight);
    let programmatic = this._programmaticScroll || now() < this._ignoreScrollUntil;
    let user = !programmatic && now() < this._userIntentUntil;
    let delta = scrollTop - this._lastScrollTop;
    this._lastScrollTop = scrollTop;
    if (user && delta < -4 && this._follow)
      this.follow = false;
    if (user && max - scrollTop <= 2 && !this._follow && this._loadedMax >= this._layout.totalItems - 1)
      this.follow = true;
    if (scrollTop <= LOAD_THRESHOLD_PX && this._loadedMin > 0)
      this._loadOlder();
    if (max - scrollTop <= LOAD_THRESHOLD_PX && this._loadedMax >= 0 && this._loadedMax < this._layout.totalItems - 1)
      this._loadNewer();
    this._scheduleRender({ follow: this._follow && max - scrollTop <= 2 });
  }

  _placeBottom({ onlyIfPending = false } = {}) {
    if (!this._layout || !this._viewport)
      return;
    if (onlyIfPending && !this._initialTailPending && !this._follow)
      return;
    let max = Math.max(0, this._layout.totalHeight() - this._viewport.clientHeight);
    let last = this._layout.totalItems - 1;
    if (last < 0)
      return;
    let height = this._layout.heightOf(last);
    let target = height <= this._viewport.clientHeight
      ? max
      : Math.max(0, this._layout.offsetOf(last));
    this._setScrollTop(target);
    this._initialTailPending = false;
  }

  _setScrollTop(value) {
    if (!this._viewport)
      return;
    this._programmaticScroll = true;
    this._ignoreScrollUntil = now() + 120;
    this._viewport.scrollTop = Math.max(0, Number(value) || 0);
    this._lastScrollTop = this._viewport.scrollTop;
    this._programmaticScroll = false;
  }

  _updateStatus() {
    if (!this._topStatus || !this._bottomStatus)
      return;
    let top = this._loadState.top;
    let bottom = this._loadState.bottom;
    let topVisible = top === 'loading' || top === 'error' || (this._loadedMin > 0 && this._viewport.scrollTop <= 1);
    let bottomVisible = bottom === 'loading' || bottom === 'error';
    this._topStatus.hidden = !topVisible;
    this._bottomStatus.hidden = !bottomVisible;
    if (top === 'loading') this._topStatus.textContent = 'Loading older messages…';
    else if (top === 'error') this._topStatus.textContent = `Older messages failed: ${this._loadState.topError} — Retry`;
    else this._topStatus.textContent = 'Scroll up for older messages';
    if (bottom === 'loading') this._bottomStatus.textContent = 'Loading newer messages…';
    else if (bottom === 'error') this._bottomStatus.textContent = `Newer messages failed: ${this._loadState.bottomError} — Retry`;
    else this._bottomStatus.textContent = 'Loading newer messages…';
    this._viewport?.setAttribute('aria-busy', top === 'loading' || bottom === 'loading' ? 'true' : 'false');
  }

  _forgetNode(node) {
    if (!node)
      return;
    try { this._resizeObserver?.unobserve?.(node); } catch (_) {}
    node._scrollviewObserved = false;
    node.remove();
  }

  _clearItemNodes() {
    for (let node of this._itemNodes.values())
      this._forgetNode(node);
    this._itemNodes.clear();
    this._windowEl?.replaceChildren();
  }
}

if (!customElements.get('aeor-scrollview'))
  customElements.define('aeor-scrollview', AeorScrollView);
