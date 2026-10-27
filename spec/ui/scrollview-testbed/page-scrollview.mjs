'use strict';

// Page/container prototype for the scrollview campaign.
//
// Unlike the first item-slot prototype, this model has a page ledger and native
// flow containers. A gap is one element for a contiguous unloaded page range;
// a loaded page is one chunk element. Messages are normal DOM inside the chunk.
// A page load is a focal-point transaction: split the gap, insert the chunk,
// measure it, then correct scrollTop by the focal point's old/new position.

const LOAD_THRESHOLD_PAGES = 1;
const DEFAULT_PAGE_HEIGHT = 4000;
const SCROLL_ANIMATION_MS = 250;

export class AeorPageScrollView extends HTMLElement {
  static get observedAttributes() {
    return [ 'scroll-animation-duration', 'page-enter-duration', 'page-load-debounce' ];
  }

  get scrollAnimationDuration() {
    let value = Number(this.getAttribute('scroll-animation-duration'));
    return Number.isFinite(value) && value >= 0 ? value : 250;
  }

  set scrollAnimationDuration(value) {
    this.setAttribute('scroll-animation-duration', String(Math.max(0, Number(value) || 0)));
  }

  get pageEnterDuration() {
    let value = Number(this.getAttribute('page-enter-duration'));
    return Number.isFinite(value) && value >= 0 ? value : 250;
  }

  set pageEnterDuration(value) {
    this.setAttribute('page-enter-duration', String(Math.max(0, Number(value) || 0)));
  }

  get pageLoadDebounce() {
    let value = Number(this.getAttribute('page-load-debounce'));
    return Number.isFinite(value) && value >= 0 ? value : 150;
  }

  set pageLoadDebounce(value) {
    this.setAttribute('page-load-debounce', String(Math.max(0, Number(value) || 0)));
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue === newValue)
      return;
    if (name === 'scroll-animation-duration' && this.scrollAnimationDuration === 0 && this._scrollAnimation) {
      let target = this._animationTarget;
      this._cancelScrollAnimation({ cancelIntent: false });
      if (target != null)
        this._writeScrollTop(target);
    }
  }

  constructor() {
    super();
    this._source = null;
    this._pageSize = 40;
    this._totalPages = 0;
    this._pages = [];
    this._segments = [];
    this._segmentEls = new Map();
    this._viewport = null;
    this._windowEl = null;
    this._topStatus = null;
    this._bottomStatus = null;
    this._follow = true;
    this._loading = new Set();
    this._loadState = { direction: 'idle', error: '' };
    this._pendingPage = null;
    this._renderScheduled = false;
    this._ignoreScrollUntil = 0;
    this._userIntentUntil = 0;
    this._lastScrollTop = 0;
    this._pointer = { x: 0, y: 0, at: 0, inside: false };
    this._resizeObserver = null;
    this._measureScheduled = false;
    this._renderCount = 0;
    this._pageLoadTimer = null;
    this._inputEpoch = 0;
    this._scrollAnimation = null;
    this._animationTarget = null;
    this._lastWrittenScrollTop = 0;
    this._requestCount = 0;
    this._metricsTimer = null;
  }

  connectedCallback() {
    if (this._viewport)
      return;
    this._build();
    this._viewport.addEventListener('scroll', () => this._onScroll(), { passive: true });
    this._viewport.addEventListener('wheel', (event) => this._onWheel(event), { passive: true });
    this._viewport.addEventListener('pointerdown', () => { this._userIntentUntil = performance.now() + 1500; this._pointer.at = 0; this._cancelScrollAnimation({ cancelIntent: true }); }, { passive: true });
    this._viewport.addEventListener('pointermove', (event) => {
      this._pointer = { x: event.clientX, y: event.clientY, at: performance.now(), inside: true };
    }, { passive: true });
    this._viewport.addEventListener('pointerleave', () => { this._pointer.inside = false; }, { passive: true });
    this._viewport.addEventListener('touchstart', () => { this._userIntentUntil = performance.now() + 1500; this._cancelScrollAnimation({ cancelIntent: true }); }, { passive: true });
    this._viewport.addEventListener('touchmove', () => { this._userIntentUntil = performance.now() + 1500; this._cancelScrollAnimation({ cancelIntent: true }); }, { passive: true });
    this._viewport.addEventListener('keydown', () => this._cancelScrollAnimation({ cancelIntent: true }));
    this._resizeObserver = new ResizeObserver(() => {
      if (this._measureScheduled)
        return;
      this._measureScheduled = true;
      requestAnimationFrame(() => {
        this._measureScheduled = false;
        this._measureChunks();
      });
    });
    this._resizeObserver.observe(this._viewport);
    this._settleTimer = setInterval(() => {
      this._measureChunks();
      if (this._follow && this._viewport
        && this._viewport.scrollTop < this._viewport.scrollHeight - this._viewport.clientHeight - 1)
        this._placeBottom();
    }, 250);
  }

  disconnectedCallback() {
    this._resizeObserver?.disconnect();
    this._resizeObserver = null;
    if (this._settleTimer)
      clearInterval(this._settleTimer);
    this._settleTimer = null;
    if (this._pageLoadTimer)
      clearTimeout(this._pageLoadTimer);
    this._pageLoadTimer = null;
  }

  _build() {
    this.classList.add('aeor-page-scrollview');
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
    this._windowEl = document.createElement('div');
    this._windowEl.className = 'aeor-page-scrollview__window';
    this._viewport.appendChild(this._windowEl);
    this.append(this._topStatus, this._viewport, this._bottomStatus);
  }

  setSource(source) {
    this._source = source;
    this._pageSize = Math.max(1, Number(source?.pageSize) || 40);
    this._totalPages = Math.ceil((Number(source?.total) || 0) / this._pageSize);
    this._pages = Array.from({ length: this._totalPages }, (_value, index) => ({
      index,
      loaded: false,
      loading: false,
      items: [],
      height: Number(source?.estimatePageHeight?.(index)) || DEFAULT_PAGE_HEIGHT,
    }));
    this._segments = [];
    this._segmentEls.clear();
    this._windowEl.replaceChildren();
    this._follow = true;
    this._pendingPage = null;
    this._renderSegments();
    if (this._totalPages > 0)
      this._loadPage(this._totalPages - 1, { initial: true });
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
    this.dispatchEvent(new CustomEvent('scrollview-follow-change', { detail: { follow: next }, bubbles: true }));
  }

  get viewport() {
    return this._viewport;
  }

  get pages() {
    return this._pages;
  }

  get segments() {
    return this._segments;
  }

  scrollToEnd({ follow = true, animate = false } = {}) {
    this.follow = follow;
    if (this._totalPages <= 0)
      return;
    if (animate) {
      this.scrollToPage(this._totalPages - 1, { align: 'end', animate: true });
      this.follow = follow;
      return;
    }
    this._loadPage(this._totalPages - 1, { initial: true });
    this._scheduleRender();
  }

  scrollToPage(index, { align = 'start', animate = true } = {}) {
    let pageIndex = Math.max(0, Math.min(this._totalPages - 1, Math.trunc(Number(index) || 0)));
    this.follow = false;
    this._pendingPage = { index: pageIndex, align, animate, startedAt: performance.now(), stable: 0, lastHeight: -1, animating: false };
    this._loadPage(pageIndex);
    this._scheduleRender();
  }

  appendItem(item) {
    if (!item || !this._source)
      return false;
    let pageIndex = Math.floor(item.index / this._pageSize);
    while (this._pages.length <= pageIndex) {
      this._pages.push({
        index: this._pages.length,
        loaded: false,
        loading: false,
        items: [],
        height: this._source.estimatePageHeight?.(this._pages.length) || DEFAULT_PAGE_HEIGHT,
      });
    }
    this._totalPages = Math.max(this._totalPages, this._pages.length);
    let page = this._pages[pageIndex];
    if (!page.loaded) {
      page.items = [ item ];
      page.loaded = true;
      page.loading = false;
      page.height = this._source.estimatePageHeight?.(pageIndex) || DEFAULT_PAGE_HEIGHT;
      this._segments = this._buildSegments();
      this._renderSegments();
      if (this._follow) {
        void this._viewport.scrollHeight;
        this._placeBottom();
      }
      return true;
    }

    page.items.push(item);
    let key = `page:${pageIndex}`;
    let pageElement = this._segmentEls.get(key);
    if (pageElement) {
      let inner = pageElement.querySelector('.aeor-page-scrollview__items');
      let node = this._source.renderItem?.(item, { index: item.index }) || document.createElement('div');
      node.classList.add('aeor-scrollview__item');
      node.dataset.key = item.key || '';
      node.dataset.index = String(item.index);
      inner?.appendChild(node);
      page.actualHeight = pageElement.getBoundingClientRect().height;
      this._segments = this._buildSegments();
      if (this._follow) {
        void this._viewport.scrollHeight;
        this._placeBottom();
      }
    } else {
      this._segments = this._buildSegments();
      this._renderSegments();
    }
    return true;
  }

  updatePage(index, items = []) {
    let page = this._pages[index];
    if (!page)
      return;
    page.items = Array.isArray(items) ? items : [];
    page.loaded = true;
    page.loading = false;
    page.height = this._pageHeight(page);
    this._renderSegments();
    if (this._follow)
      this._scheduleRender({ follow: true });
    else
      this._scheduleRender();
  }

  metrics() {
    let viewport = this._viewport;
    let scrollTop = viewport?.scrollTop || 0;
    let center = scrollTop + (viewport?.clientHeight || 0) / 2;
    let centerPage = this._pageAtOffset(center);
    let loadedPages = this._pages.filter((page) => page.loaded).length;
    let mountedItems = 0;
    for (let page of this._pages) {
      if (page.loaded)
        mountedItems += page.items.length;
    }
    return {
      totalPages: this._totalPages,
      loadedPages,
      mountedItems,
      renderedPages: this._segmentEls.size,
      scrollTop: Math.round(scrollTop * 100) / 100,
      scrollHeight: viewport?.scrollHeight || 0,
      clientHeight: viewport?.clientHeight || 0,
      maxScrollTop: Math.max(0, (viewport?.scrollHeight || 0) - (viewport?.clientHeight || 0)),
      follow: this._follow,
      centerPage,
      loading: [ ...this._loading ],
      loadState: { ...this._loadState },
      renderCount: this._renderCount,
      requests: this._requestCount,
      segments: this._segments.map((segment) => ({ type: segment.type, start: segment.start, end: segment.end, height: Math.round(segment.height) })),
    };
  }

  _pageHeight(page) {
    return page?.actualHeight || page?.height || this._source?.estimatePageHeight?.(page?.index) || DEFAULT_PAGE_HEIGHT;
  }

  _buildSegments() {
    let segments = [];
    let current = null;
    for (let page of this._pages) {
      if (!page.loaded) {
        if (!current || current.type !== 'gap') {
          current = { type: 'gap', start: page.index, end: page.index + 1, pages: [] };
          segments.push(current);
        }
        current.end = page.index + 1;
        current.pages.push(page);
        current.height = current.pages.reduce((sum, item) => sum + this._pageHeight(item), 0);
      } else {
        // One chunk per loaded page keeps focal nodes stable and makes gap
        // splitting explicit. Adjacent chunks remain separate for the prototype;
        // the production container can merge them when no split is pending.
        segments.push({ type: 'page', start: page.index, end: page.index + 1, page, height: this._pageHeight(page) });
        current = null;
      }
    }
    return segments;
  }

  _renderSegments() {
    let previousSegments = this._segments;
    let nextSegments = this._buildSegments();
    let previousKeys = new Set(previousSegments.map((segment) => this._segmentKey(segment)));
    let nextKeys = new Set(nextSegments.map((segment) => this._segmentKey(segment)));
    let fragment = document.createDocumentFragment();
    let nextEls = new Map();
    for (let segment of nextSegments) {
      let key = this._segmentKey(segment);
      let element = this._segmentEls.get(key);
      if (!element) {
        element = this._createSegmentElement(segment);
        this._observeSegment(element);
      }
      element.style.height = segment.type === 'gap' ? `${Math.round(segment.height)}px` : 'auto';
      element.dataset.start = String(segment.start);
      element.dataset.end = String(segment.end);
      nextEls.set(key, element);
      fragment.appendChild(element);
    }
    this._windowEl.replaceChildren(fragment);
    for (let [key, element] of this._segmentEls) {
      if (!nextKeys.has(key))
        element.remove();
    }
    this._segmentEls = nextEls;
    this._segments = nextSegments;
    this._renderCount++;
    this._applyPendingPage();
    if (this._follow) {
      // Force the new flow height to be observed before reading scrollHeight.
      void this._viewport.scrollHeight;
      this._placeBottom();
    }
  }

  _segmentKey(segment) {
    return segment.type === 'page' ? `page:${segment.start}` : `gap:${segment.start}:${segment.end}`;
  }

  _createSegmentElement(segment) {
    if (segment.type === 'gap') {
      let element = document.createElement('div');
      element.className = 'aeor-page-scrollview__gap';
      element.dataset.pageStart = String(segment.start);
      element.dataset.pageEnd = String(segment.end);
      element.setAttribute('aria-hidden', 'true');
      element.textContent = '';
      return element;
    }

    let element = document.createElement('div');
    element.className = 'aeor-page-scrollview__page';
    element.dataset.page = String(segment.start);
    let inner = document.createElement('div');
    inner.className = 'aeor-page-scrollview__items';
    for (let item of segment.page.items) {
      let node = this._source?.renderItem?.(item, { index: item.index }) || document.createElement('div');
      node.classList.add('aeor-scrollview__item');
      node.dataset.key = item.key || '';
      node.dataset.index = String(item.index);
      inner.appendChild(node);
    }
    element.appendChild(inner);
    if (!prefersReducedMotion() && this.pageEnterDuration > 0) {
      element.classList.add('aeor-page-scrollview__page--entering');
      element.style.animationDuration = `${this.pageEnterDuration}ms`;
      element.addEventListener('animationend', () => {
        element.classList.remove('aeor-page-scrollview__page--entering');
      }, { once: true });
    }
    return element;
  }

  _observeSegment(element) {
    if (element._pageObserved || !this._resizeObserver)
      return;
    element._pageObserved = true;
    this._resizeObserver.observe(element);
  }

  _measureChunks() {
    let changed = false;
    for (let segment of this._segments) {
      if (segment.type !== 'page')
        continue;
      let element = this._segmentEls.get(this._segmentKey(segment));
      if (!element?.isConnected)
        continue;
      let height = element.getBoundingClientRect().height;
      if (height > 0 && Math.abs(height - this._pageHeight(segment.page)) > 0.5) {
        segment.page.actualHeight = height;
        segment.height = height;
        changed = true;
      }
    }
    if (!changed)
      return;
    this._segments = this._buildSegments();
    this._scheduleRender();
    if (this._follow)
      requestAnimationFrame(() => this._placeBottom());
  }

  _pageAtOffset(offset) {
    let value = Math.max(0, Number(offset) || 0);
    let cursor = 0;
    for (let segment of this._segments) {
      if (value < cursor + segment.height) {
        if (segment.type === 'page')
          return segment.start;
        let local = value - cursor;
        let count = Math.max(1, segment.end - segment.start);
        let pageOffset = Math.floor((local / Math.max(1, segment.height)) * count);
        return Math.max(segment.start, Math.min(segment.end - 1, segment.start + pageOffset));
      }
      cursor += segment.height;
    }
    return Math.max(0, this._totalPages - 1);
  }

  _offsetOfPage(index) {
    let cursor = 0;
    for (let segment of this._segments) {
      if (segment.type === 'page' && segment.start === index)
        return cursor;
      if (segment.type === 'gap' && index >= segment.start && index < segment.end) {
        let relative = (index - segment.start) / Math.max(1, segment.end - segment.start);
        return cursor + relative * segment.height;
      }
      cursor += segment.height;
    }
    return cursor;
  }

  _loadPage(index, options = {}) {
    let page = this._pages[index];
    if (!page || page.loaded || page.loading || !this._source)
      return Promise.resolve(false);
    page.loading = true;
    this._cancelScrollAnimation();
    this._loading.add(index);
    this._requestCount++;
    this._loadState = { direction: index >= this._pageAtOffset(this._viewport.scrollTop) ? 'bottom' : 'top', error: '' };
    this._updateStatus();
    let start = index * this._pageSize;
    let end = Math.min(this._source.total, start + this._pageSize);
    return Promise.resolve(this._source.loadPage({ start, end, pageIndex: index }))
      .then((result) => {
        if (!result?.items)
          return false;
        let focal = this._captureFocal();
        let oldFocalTop = focal?.node?.getBoundingClientRect().top ?? null;
        page.items = result.items;
        page.loaded = true;
        page.loading = false;
        page.height = this._source.estimatePageHeight?.(index) || DEFAULT_PAGE_HEIGHT;
        this._loading.delete(index);
        this._loadState = { direction: 'idle', error: '' };
        this._segments = this._buildSegments();
        this._renderSegments();
        this._measureChunks();
        if (this._pendingPage?.index === index)
          this._applyPendingPage();
        else if (focal?.node?.isConnected && oldFocalTop != null) {
          let newTop = focal.node.getBoundingClientRect().top;
          this._setScrollTop(this._viewport.scrollTop + (newTop - oldFocalTop));
        } else if (this._follow) {
          this._placeBottom();
        }
        this._updateStatus();
        return true;
      })
      .catch((error) => {
        page.loading = false;
        this._loading.delete(index);
        this._loadState = { direction: 'idle', error: error?.message || String(error) };
        this._updateStatus();
        return false;
      });
  }

  _captureFocal() {
    let viewportRect = this._viewport.getBoundingClientRect();
    let center = viewportRect.top + viewportRect.height / 2;
    let candidates = [ ...this._windowEl.querySelectorAll('.aeor-scrollview__item') ]
      .map((node) => {
        let rect = node.getBoundingClientRect();
        if (rect.bottom < viewportRect.top || rect.top > viewportRect.bottom)
          return null;
        let distance = rect.top <= center && rect.bottom >= center
          ? 0
          : Math.min(Math.abs(rect.top - center), Math.abs(rect.bottom - center));
        return { node, rect, distance };
      })
      .filter(Boolean)
      .sort((left, right) => left.distance - right.distance || left.rect.top - right.rect.top);
    let candidate = candidates[0];
    return candidate ? { node: candidate.node, oldTop: candidate.rect.top } : null;
  }

  _applyPendingPage() {
    let pending = this._pendingPage;
    if (!pending)
      return;
    let page = this._pages[pending.index];
    if (!page?.loaded)
      return;
    let top = this._offsetOfPage(pending.index);
    let height = this._pageHeight(page);
    let target = pending.align === 'center'
      ? top - (this._viewport.clientHeight - height) / 2
      : pending.align === 'end' ? top + height - this._viewport.clientHeight : top;
    if (!pending.animating) {
      pending.animating = true;
      if (prefersReducedMotion()) {
        this._writeScrollTop(target);
        this._pendingPage = null;
      } else {
        this._animateScrollTo(target, () => { this._pendingPage = null; });
      }
      return;
    }
    return;
    if (Math.abs(height - pending.lastHeight) < 0.5)
      pending.stable++;
    else
      pending.stable = 0;
    pending.lastHeight = height;
    if (pending.stable >= 2 || performance.now() - pending.startedAt > 1500)
      this._pendingPage = null;
  }

  _animateScrollTo(target, onComplete = null) {
    this._cancelScrollAnimation();
    let start = this._viewport.scrollTop;
    let distance = Number(target) - start;
    if (!Number.isFinite(distance) || Math.abs(distance) < 4 || prefersReducedMotion()) {
      this._writeScrollTop(target);
      onComplete?.();
      return;
    }
    let token = Symbol('scroll-animation');
    let startedAt = performance.now();
    let duration = this.scrollAnimationDuration;
    if (duration <= 0) {
      this._writeScrollTop(target);
      onComplete?.();
      return;
    }
    this._animationTarget = target;
    this._scrollAnimation = token;
    let step = (now) => {
      if (this._scrollAnimation !== token)
        return;
      let progress = Math.min(1, (now - startedAt) / duration);
      let eased = 1 - (1 - progress) ** 3;
      this._writeScrollTop(start + distance * eased);
      if (progress < 1) {
        requestAnimationFrame(step);
      } else {
        this._scrollAnimation = null;
        this._animationTarget = null;
        this._writeScrollTop(target);
        onComplete?.();
      }
    };
    requestAnimationFrame(step);
  }

  _cancelScrollAnimation({ cancelIntent = false } = {}) {
    this._scrollAnimation = null;
    this._animationTarget = null;
    if (cancelIntent) {
      this._pendingPage = null;
      this._ignoreScrollUntil = 0;
    }
  }

  _onScroll() {
    if (!this._viewport)
      return;
    if (this._scrollAnimation) {
      let drift = Math.abs(this._viewport.scrollTop - this._lastWrittenScrollTop);
      if (drift > 1) {
        // A scroll not produced by the animation means the user took over.
        this._userIntentUntil = performance.now() + 1500;
        this._cancelScrollAnimation({ cancelIntent: true });
      } else {
        this._lastScrollTop = this._viewport.scrollTop;
        return;
      }
    }
    let programmatic = performance.now() < this._ignoreScrollUntil || !!this._scrollAnimation;
    let user = !programmatic && performance.now() < this._userIntentUntil;
    if (!programmatic)
      this._inputEpoch++;
    let max = Math.max(0, this._viewport.scrollHeight - this._viewport.clientHeight);
    if (user && this._viewport.scrollTop < this._lastScrollTop - 4 && this._follow)
      this.follow = false;
    if (user && max - this._viewport.scrollTop <= 2)
      this.follow = true;
    this._lastScrollTop = this._viewport.scrollTop;
    this._scheduleRender();
    if (!programmatic)
      this._scheduleSettledPageLoad();
  }

  _scheduleSettledPageLoad() {
    if (!this._viewport || this._scrollAnimation)
      return;
    if (this._pageLoadTimer)
      clearTimeout(this._pageLoadTimer);
    let epoch = this._inputEpoch;
    this._pageLoadTimer = setTimeout(() => {
      this._pageLoadTimer = null;
      if (epoch !== this._inputEpoch || this._scrollAnimation)
        return;
      let page = this._pageAtOffset(this._viewport.scrollTop + this._viewport.clientHeight / 2);
      this._loadPage(page);
      // One adjacent prefetch only after the position has settled.
      if (page + 1 < this._totalPages)
        this._loadPage(page + 1);
    }, this.pageLoadDebounce);
  }

  _onWheel(event) {
    this._cancelScrollAnimation({ cancelIntent: true });
    this._userIntentUntil = performance.now() + 1500;
    if (!this._viewport)
      return;
    let page = this._pageAtOffset(this._viewport.scrollTop);
    if (event.deltaY < 0 && this._viewport.scrollTop <= 1)
      this._loadPage(page - 1);
    else if (event.deltaY > 0 && this._viewport.scrollTop >= this._viewport.scrollHeight - this._viewport.clientHeight - 1)
      this._loadPage(page + 1);
  }

  _placeBottom() {
    if (!this._viewport)
      return;
    this._setScrollTop(Math.max(0, this._viewport.scrollHeight - this._viewport.clientHeight));
  }

  _setScrollTop(value, { immediate = false } = {}) {
    let target = Math.max(0, Number(value) || 0);
    if (immediate || prefersReducedMotion()) {
      this._writeScrollTop(target);
      return;
    }
    this._animateScrollTo(target);
  }

  _writeScrollTop(value) {
    this._programmatic = true;
    this._ignoreScrollUntil = performance.now() + 120;
    this._viewport.scrollTop = Math.max(0, Number(value) || 0);
    this._lastWrittenScrollTop = this._viewport.scrollTop;
    this._lastScrollTop = this._viewport.scrollTop;
    this._programmatic = false;
  }

  _updateStatus() {
    if (!this._topStatus || !this._bottomStatus)
      return;
    let loading = this._loading.size > 0;
    this._topStatus.hidden = !loading;
    this._bottomStatus.hidden = true;
    if (loading)
      this._topStatus.textContent = `Loading page${this._loading.size > 1 ? 's' : ''}…`;
    this._viewport.setAttribute('aria-busy', loading ? 'true' : 'false');
    if (this._loadState.error) {
      this._topStatus.hidden = false;
      this._topStatus.textContent = `Load failed: ${this._loadState.error}`;
    }
  }

  _scheduleRender(options = {}) {
    if (this._follow && options.follow !== false)
      options.follow = true;
    this._renderOptions = { ...this._renderOptions, ...options };
    if (this._renderScheduled)
      return;
    this._renderScheduled = true;
    requestAnimationFrame(() => {
      this._renderScheduled = false;
      let next = this._renderOptions || {};
      this._renderOptions = {};
      this._renderSegments();
      if (next.follow && this._follow)
        this._placeBottom();
      this._scheduleSettledPageLoad();
    });
  }

}

function prefersReducedMotion() {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

if (!customElements.get('aeor-page-scrollview'))
  customElements.define('aeor-page-scrollview', AeorPageScrollView);
