'use strict';

// Adapter between Kikx's loaded frame window and Aeor's <aeor-scrollview>.
// Kikx owns frame identity, item rendering and the app state; the shared
// element owns page/gap geometry, page loading and programmatic scrolling.

import { captureFrameListAnchor, frameItemTopWithinList, restoreFrameListAnchor } from './frame-scroll-anchor.mjs';
import { KikxThreadPageSource } from './kikx-thread-page-source.mjs';
import { frameMatchesWindowFilters } from '../../shared/frame-window-filters.mjs';
import { promoteTailResponse } from './thread-display-order.mjs';
import { getSessionPaging } from '../state/kikx-state.mjs';

const CSS_ESCAPE = globalThis.CSS?.escape || ((value) => String(value).replace(/["\\]/g, '\\$&'));
const PAGE_SIZE = 120;

function pageCount(frames, pageSize = PAGE_SIZE) {
  return Math.max(1, Math.ceil(frames.length / pageSize));
}

export function createKikxPageContext(app, sessionID) {
  let paging = getSessionPaging(app?._state, sessionID);
  let total = Number(paging.total);
  if (!Number.isFinite(total) || total <= 0)
    return null;
  return {
    key: `${sessionID}:${JSON.stringify(app?._state?.frameFilters || null)}:${app?._state?.sessionSearch || ''}`,
    sessionID,
    totalRawFrames: total,
    pageSize: PAGE_SIZE,
    loadPage: (pageIndex, pageSize) => app._loadFramePage(sessionID, pageIndex, pageSize),
    getFilters: () => app?._state?.frameFilters || null,
    getQuery: () => app?._state?.sessionSearch || '',
    getTotalRawFrames: () => Number(getSessionPaging(app?._state, sessionID).total) || total,
    getStartPage: () => {
      let offset = Number(getSessionPaging(app?._state, sessionID).startOffset);
      return Number.isInteger(offset) && offset >= 0 ? Math.floor(offset / PAGE_SIZE) : null;
    },
  };
}

export class KikxChatScrollView {
  constructor({ host, pageSize, createFrameItem, getAppState }) {
    this.host = host;
    this.pageSize = Math.max(1, pageSize || PAGE_SIZE);
    this.createFrameItem = createFrameItem;
    this.getAppState = getAppState;
    this.element = null;
    this.frames = [];
    this.source = null;
    this.pageContext = null;
    this.pageSource = null;
    this.windowStart = 0;
    this.windowEnd = 0;
    this._pendingAnchor = null;
    this._pendingPage = null;
    this._pendingLiveFrames = new Map();
    this._visiblePageAnchors = new Map();
    this._userPageAnchor = null;
    this._userPageAnchorTimer = null;
    this._pinAfterContext = false;
    this._pinHoldUntil = 0;
  }

  get frameList() {
    return this.element?.viewport || null;
  }

  get frameStream() {
    return this.element?.querySelector?.('.kikx-frame-stream') || null;
  }

  get usesPagedSource() {
    return Boolean(this.pageSource);
  }

  mount(frames, pageContext = this.pageContext) {
    this.host.textContent = '';
    this.element = document.createElement('aeor-scrollview');
    this.element.className = 'kikx-thread-scrollview';
    this.element.setAttribute('page-enter-duration', '0');
    this.element.setAttribute('page-load-debounce', '100');
    this.host.appendChild(this.element);
    this._installEvents();
    this.frames = Array.isArray(frames) ? frames : [];
    this.pageContext = pageContext || null;
    this.pageSource = null;
    this._pageSourceKey = '';
    this._pendingLiveFrames.clear();
    if (this.pageContext?.loadPage)
      this._mountPagedSource();
    else
      this._setSource(this.frames);
    this._applyClasses();
    return this;
  }

  _mountPagedSource() {
    this._pendingLiveFrames.clear();
    this._pageSourceKey = this.pageContext?.key || '';
    this.pageSource = new KikxThreadPageSource({
      pageSize: this.pageContext.pageSize || this.pageSize,
      totalRawFrames: this.pageContext.totalRawFrames,
      loadPage: this.pageContext.loadPage,
      getFilters: this.pageContext.getFilters,
      getQuery: this.pageContext.getQuery,
      updateItem: (item, node) => {
        node.updateFrame?.(item.frame, this.getAppState(), { force: false });
      },
    });
    this.pageSource.renderItem = (item) => this.createFrameItem(item.frame);
    this.source = this.pageSource;
    this.element.setSource(this.source, { follow: false });
    // Sparse filtered pages can be much shorter than their raw-page estimate.
    // Preserve the segment under the viewport when a page loads above it;
    // otherwise a filtered load clamps the viewport to the new bottom.
    this.element.behavior = { preserveViewportOnPageLoad: true };
    let last = Math.max(0, this.source.totalPages - 1);
    let startPage = this.pageContext?.getStartPage?.();
    let target = Number.isInteger(startPage)
      ? Math.max(0, Math.min(last, startPage))
      : last;
    this.windowStart = target * this.pageSize;
    this.windowEnd = this.frames.length;
    this._pendingPage = target;
    this._pendingAnchor = null;
    this.element.scrollToPage(target, { align: target === last ? 'end' : 'start', animate: false });
  }

  // Re-scope the mounted page source after a filter/query change. The source
  // already has the raw pages; reloading projection for only the mounted pages
  // preserves the scrollview, page wrappers, and scroll anchor. A different
  // session (or a missing source) must return false so the caller can mount.
  updatePageContext(pageContext) {
    if (!this.pageSource || !this.element || !pageContext)
      return false;
    let pinBottom = this._pinAfterContext === true;
    this._pinAfterContext = false;
    if (this.pageContext?.sessionID && pageContext.sessionID && this.pageContext.sessionID !== pageContext.sessionID)
      return false;

    let key = pageContext.key || '';
    if (key === this._pageSourceKey) {
      this.pageContext = pageContext;
      if (pinBottom)
        this.pinToEnd();
      return true;
    }

    this.pageContext = pageContext;
    this._pageSourceKey = key;
    this.pageSource.getFilters = pageContext.getFilters;
    this.pageSource.getQuery = pageContext.getQuery;
    this.pageSource.loadRawPage = pageContext.loadPage;
    let epoch = (this._pageContextEpoch || 0) + 1;
    this._pageContextEpoch = epoch;

    let indexes = [ ...this.pageSource.rawPages.keys() ]
      .filter((index) => this.element.pages?.[index]?.loaded === true);
    let visible = this._visiblePageIndexes(indexes);
    let visibleSet = new Set(visible);
    let anchor = captureFrameListAnchor(this.frameList);
    let filterAnchor = captureFilterAnchor(this.frameList);

    // Clearing a search used to re-project every page the user had ever
    // scrolled through. On a long session that meant rebuilding thousands of
    // frame nodes in one turn and could lock the browser. Keep the pages under
    // the viewport live, and return the rest to the page source's estimated
    // gaps. They are re-projected against the current query when scrolled back
    // into range, without rebuilding the scrollview or losing its position.
    let offscreen = indexes.filter((index) => !visibleSet.has(index));
    if (offscreen.length > 0)
      this.element.invalidatePages(offscreen);

    let updates = visible.map((index) => (
      this.pageSource.loadPage({ pageIndex: index }).then((page) => {
        if (epoch !== this._pageContextEpoch || this._pageSourceKey !== key)
          return false;
        this.element.updatePage(index, page.items);
        return true;
      }).catch(() => false)
    ));
    Promise.all(updates).then(() => {
      if (epoch !== this._pageContextEpoch || this._pageSourceKey !== key)
        return;
      this._promoteTailResponse();
      if (pinBottom) {
        this.pinToEnd();
        // Enforce the bounded-offscreen contract DETERMINISTICALLY after the
        // pin (owner cap: <=6 loaded pages after clearing search). Visibility
        // math alone flapped 5..8 under content-visibility — placeholder
        // geometry vs metadata drift decides borderline pages by luck — so
        // keep exactly the tail's prefetch band and return everything else to
        // estimated gaps. Heights survive invalidatePages; scrolling back
        // re-projects on demand.
        this._enforceLoadedPageBudget();
      } else if (!restoreFrameListAnchor(this.frameList, anchor)) {
        restoreFilterAnchor(this.frameList, filterAnchor);
      }
    });
    return true;
  }

  // Keep loaded pages within the prefetch radius of the CURRENT center page.
  // Runs only after an explicit bottom pin, where the center is the tail: the
  // kept band is tail..tail-radius (<=4 pages with the default radius 3), so
  // re-projections that landed mid-document during the clear cannot linger.
  _enforceLoadedPageBudget() {
    let element = this.element;
    if (!element?.metrics || !Array.isArray(element.pages))
      return;
    let radius = Number(element.prefetchPages);
    if (!Number.isFinite(radius) || radius < 0)
      radius = 3;
    let center = Number(element.metrics().centerPage);
    if (!Number.isInteger(center))
      return;
    let excess = [];
    element.pages.forEach((page, index) => {
      if (page?.loaded && Math.abs(index - center) > radius)
        excess.push(index);
    });
    if (excess.length > 0)
      element.invalidatePages(excess);
  }

  pinToLatestAfterContext() {
    this._pinAfterContext = true;
    this._pinHoldUntil = performance.now() + 2000;
  }

  pinToEnd() {
    if (!this.element)
      return false;
    // Gesture supremacy (mobile bottom-follow glitch, 2026-11-05): a live
    // frame arriving under a PHYSICAL finger must not re-pin the viewport — the old
    // immediate write re-armed aeor's ignore-scroll window, hid the user's
    // scroll events from _onScroll, and follow never released (three-way
    // sawtooth with the settle timer and the focus driver). If follow survives
    // the gesture, aeor's settle timer re-pins; if the gesture releases
    // follow, the caller falls through to the anchor restore below.
    if (this.element.viewportPointerActive)
      return false;
    let last = Math.max(0, (this.pageSource?.totalPages || pageCount(this.frames, this.pageSize)) - 1);
    this.windowStart = last * this.pageSize;
    this.windowEnd = this.frames.length;
    this._pendingAnchor = null;
    this._pendingPage = last;
    this.element.scrollToEnd({ follow: true, animate: false, immediate: true });
    return true;
  }

  _visiblePageIndexes(indexes) {
    let element = this.element;
    if (!element?.metrics)
      return indexes.slice();
    // Segment metadata, not rects (owner cap regression, 2026-11-05): with
    // content-visibility, offscreen pages report PLACEHOLDER geometry whose
    // seeded height drifts from the real one, so rect intersection kept 2-3
    // extra pages "near" the viewport and the post-clear loaded-page count
    // flapped 5..8 against a <=6 cap. Offsets/bounds are the same metadata the
    // pending-page, band and pin math already use — one source of truth, and
    // no layout reads at a moment when a filter change is rebuilding pages.
    let metrics = element.metrics();
    let top = metrics.scrollTop;
    let bottom = top + metrics.clientHeight;
    let margin = Math.max(0, metrics.clientHeight * 0.5);
    let visible = indexes.filter((index) => {
      let bounds = element.pageBounds?.(index);
      return Boolean(bounds) && bounds.bottom >= top - margin && bounds.top <= bottom + margin;
    });
    if (visible.length === 0) {
      let center = Number(metrics.centerPage);
      if (Number.isInteger(center) && indexes.includes(center))
        visible.push(center);
      else if (indexes.length > 0)
        visible.push(indexes[indexes.length - 1]);
    }
    return visible.sort((left, right) => left - right);
  }

  _installEvents() {
    this.element.addEventListener('scrollview-follow-change', (event) => {
      // A deliberate user scroll releases the temporary clear-filter pin.
      if (event.detail?.follow === false)
        this._pinHoldUntil = 0;
    });
    this.element.addEventListener('scrollview-page-load', (event) => {
      let pageIndex = event.detail?.pageIndex;
      if (!Number.isInteger(pageIndex) || this.element.follow !== false)
        return;
      // A pending page belongs to an explicit scrollToPage() transaction. Its
      // alignment must win; do not capture the pre-jump frame as an anchor.
      if (this.element._pendingPage)
        return;
      if (!this._userPageAnchor)
        this._userPageAnchor = captureVisibleFrameAnchor(this.frameList);
    });
    this.element.addEventListener('scrollview-page-loaded', (event) => {
      let pageIndex = event.detail?.pageIndex;
      if (!Number.isInteger(pageIndex))
        return;
      this.windowStart = Math.min(this.windowStart, pageIndex * this.pageSize);
      this.windowEnd = this.frames.length;
      this.pageSource?.measured?.(pageIndex, event.detail?.measuredHeight);
      if (this._pendingPage === pageIndex) {
        let anchor = this._pendingAnchor;
        this._pendingPage = null;
        this._pendingAnchor = null;
        this._restoreAnchor(anchor);
      }
      this._flushPendingLiveFrames();
      this._promoteTailResponse();
      let anchor = this._userPageAnchor;
      if (anchor && this.element.follow === false)
        restoreFrameListAnchor(this.frameList, anchor);
      if (this.element._loading?.size === 0) {
        clearTimeout(this._userPageAnchorTimer);
        this._userPageAnchorTimer = setTimeout(() => {
          if (anchor && this.element?.follow === false)
            restoreFrameListAnchor(this.frameList, anchor);
          this._userPageAnchor = null;
          this._userPageAnchorTimer = null;
        }, 220);
      }
      // Pages can finish loading after the clear-filter pin was applied and
      // change every segment height. Keep the pin alive briefly so those late
      // page loads cannot leave the user above the newest frame.
      if (this._pinHoldUntil !== 0 && performance.now() <= this._pinHoldUntil && this.element.follow === true)
        this.pinToEnd();
    });
  }

  _applyClasses() {
    let viewport = this.element?.viewport;
    let stream = this.element?.querySelector?.('.aeor-scrollview__window');
    viewport?.classList.add('kikx-frame-list');
    stream?.classList.add('kikx-frame-stream');
  }

  _setSource(frames, { anchor = null, page = null, align = 'end' } = {}) {
    this.frames = Array.isArray(frames) ? frames : [];
    this.source = this._createSource(this.frames);
    this.element.setSource(this.source, { follow: false });
    let targetPage = Number.isInteger(page)
      ? page
      : Math.max(0, pageCount(this.frames, this.pageSize) - 1);
    this.windowStart = targetPage * this.pageSize;
    this.windowEnd = this.frames.length;
    this._pendingAnchor = anchor;
    this._pendingPage = targetPage;
    this.element.scrollToPage(targetPage, { align, animate: false });
    this._applyClasses();
  }

  _createSource(frames) {
    let pageSize = this.pageSize;
    return {
      pageSize,
      totalItems: frames.length,
      totalPages: pageCount(frames, pageSize),
      pageToken: (index) => String(index),
      loadPage: async ({ start, end }) => ({
        start,
        end,
        items: frames.slice(start, end).map((frame, index) => ({
          key: frame.id,
          index: start + index,
          frame,
        })),
      }),
      renderItem: (item) => this.createFrameItem(item.frame),
      estimatePageHeight: () => Math.max(2400, pageSize * 160),
    };
  }

  _restoreAnchor(anchor) {
    if (!anchor?.frameID || !this.frameList)
      return false;
    let item = [ ...this.frameList.querySelectorAll('kikx-frame-item') ]
      .find((candidate) => candidate.dataset.frameId === anchor.frameID);
    if (!item)
      return false;
    let target = frameItemTopWithinList(this.frameList, item) - anchor.offset;
    let max = Math.max(0, this.frameList.scrollHeight - this.frameList.clientHeight);
    this.frameList.scrollTop = Math.min(Math.max(0, target), max);
    return true;
  }

  syncFrames(frames, appState, options = {}) {
    if (this.pageSource)
      return this._syncPagedFrames(frames, appState, options);

    let anchor = captureFrameListAnchor(this.frameList);
    let previous = this.frames;
    let next = Array.isArray(frames) ? frames : [];
    let overlap = Math.min(next.length, previous.length);
    let structural = next.length < previous.length
      || options.prepend === true
      || next.slice(0, overlap).some((frame, index) => frame?.id !== previous[index]?.id);
    if (!this.element || structural) {
      let olderInserted = next.length > previous.length
        && (options.prepend === true || next[0]?.id !== previous[0]?.id);
      this.frames = next;
      this._setSource(next, {
        anchor: olderInserted ? null : anchor,
        page: olderInserted ? 0 : this._pageForFrame(next, anchor?.frameID),
        align: 'start',
      });
      return { insertedNew: true };
    }

    this.frames = next;
    this.source.totalItems = next.length;
    this.source.totalPages = pageCount(next, this.pageSize);
    let insertedNew = false;
    if (next.length > previous.length) {
      for (let index = previous.length; index < next.length; index++) {
        let frame = next[index];
        if (!frame?.id)
          continue;
        this.element.appendItem({ key: frame.id, index, frame });
        insertedNew = true;
      }
    }
    this._updateMountedItems(next, appState, options);
    this.windowEnd = next.length;
    restoreFrameListAnchor(this.frameList, anchor);
    return { insertedNew: insertedNew || structural };
  }

  _syncPagedFrames(frames, appState, options = {}) {
    let anchor = captureFrameListAnchor(this.frameList);
    let previous = this.frames;
    let next = Array.isArray(frames) ? frames : [];
    // The state window is only the newest live tail; older server pages live in
    // the scrollview source. A trim or a new tail frame must not reset that
    // source. Only a different first frame means a different session/filter.
    // The loaded state window trims its oldest frame on every live append once
    // it reaches its cap. That is not a session/filter change; remounting the
    // page source here re-requested every visible page on every append and made
    // streaming progressively slower.
    let contextKey = this.pageContext?.key || '';
    let structural = !this.pageSource || contextKey !== this._pageSourceKey;
    this.frames = next;
    if (structural) {
      this._mountPagedSource();
      return { insertedNew: true };
    }

    let total = Number(this.pageContext?.getTotalRawFrames?.());
    if (Number.isFinite(total) && total > this.pageSource.totalRawFrames) {
      this.pageSource.totalRawFrames = total;
      this.pageSource.totalPages = Math.ceil(total / this.pageSource.pageSize);
    }
    let insertedNew = false;
    // Detect NEW tail frames by identity, not by length. The bounded state
    // window trims its oldest frame and appends the newest one on every live
    // update, so at the cap `next.length === previous.length` even though a new
    // message just arrived. Length-only detection silently stopped appends.
    let previousIDs = new Set(previous.map((frame) => frame?.id).filter(Boolean));
    let previousLastID = previous.at(-1)?.id || null;
    let previousLastIndex = previousLastID ? next.findIndex((frame) => frame?.id === previousLastID) : -1;
    let tailStart = previousLastIndex >= 0
      ? previousLastIndex + 1
      : (next.length > previous.length ? previous.length : 0);
    for (let index = tailStart; index < next.length; index++) {
      let frame = next[index];
      if (frame?.id && !previousIDs.has(frame.id))
        this._pendingLiveFrames.set(frame.id, frame);
    }
    // If the previous tail id disappeared (a reorder or a full tail swap),
    // queue every frame the previous window did not already know.
    if (previousLastIndex < 0) {
      for (let frame of next) {
        if (frame?.id && !previousIDs.has(frame.id))
          this._pendingLiveFrames.set(frame.id, frame);
      }
    }
    if (this._pendingLiveFrames.size > 0)
      insertedNew = this._flushPendingLiveFrames();
    this._updateMountedItems(next, appState, options);
    this.windowEnd = next.length;
    // Follow mode is a stronger contract than "preserve the old anchor": a
    // runtime sync that lands after a filter clear must not leave the viewport
    // a few hundred pixels above the newest frame. Only unlocked readers get
    // anchor restoration. A pin DECLINED for an active gesture falls through
    // to the anchor restore: holding the frame under the finger beats both
    // yanking home and standing still while the list re-scopes.
    if (this.element.follow === true && this.pinToEnd()) {
      // Pinned to the newest content.
    } else {
      restoreFrameListAnchor(this.frameList, anchor);
    }
    return { insertedNew };
  }

  // Append a just-written frame to the mounted tail immediately. The state
  // upsert and SSE echo can race; waiting for the next page/sync can leave the
  // sent message invisible for a moment. appendItem is key-idempotent.
  appendFrame(frame) {
    if (!frame?.id || !this.element || !this.pageSource)
      return false;
    let state = this.getAppState?.() || {};
    let filters = state.frameFilters || null;
    let query = state.sessionSearch || '';
    if (!frameMatchesWindowFilters(frame, filters, query))
      return false;
    let pageIndex = Math.max(0, (this.element.pages?.length || 1) - 1);
    let page = this.element.pages?.[pageIndex];
    if (!page?.loaded) {
      // A live frame can arrive while the tail page is unloaded (after a filter
      // re-scope, or during startup). Queue it and start the page load now;
      // waiting for a scroll event would strand the message until the user
      // happened to move the viewport.
      this._pendingLiveFrames.set(frame.id, frame);
      this.element.preloadPage(pageIndex);
      return false;
    }
    let index = pageIndex * this.pageSize + (page.items?.length || 0);
    let added = this.element.appendItem({ key: frame.id, index, frame });
    if (added) {
      this.pageSource.totalRawFrames = Math.max(this.pageSource.totalRawFrames, index + 1);
      this.pageSource.totalPages = Math.max(this.pageSource.totalPages, pageIndex + 1);
      this._pendingLiveFrames.delete(frame.id);
    }
    return added;
  }

  _promoteTailResponse() {
    if (!this.element || !this.pageSource)
      return;
    let updates = promoteTailResponse(this.element.pages || []);
    for (let update of updates) {
      let page = this.element.pages?.[update.pageIndex];
      if (!page)
        continue;
      page.items = update.items;
      this.element.updatePage(update.pageIndex, update.items);
    }
  }

  _flushPendingLiveFrames() {
    if (!this.element || !this.pageSource || this._pendingLiveFrames.size === 0)
      return false;

    let lastPage = Math.max(0, this.pageSource.totalPages - 1);
    let page = this.element.pages?.[lastPage];
    // Appending into an unloaded page would mark it loaded with only the live
    // item and prevent its real page request. Start the real load now; the
    // page-loaded event will flush the queue. Without this, new frames wait
    // for a user scroll that may never come while the viewport is at bottom.
    if (!page?.loaded) {
      this.element.preloadPage(lastPage);
      return false;
    }

    let inserted = false;
    let index = lastPage * this.pageSize + page.items.length;
    for (let [ key, frame ] of this._pendingLiveFrames) {
      // appendItem is idempotent for a key already present in any page; this
      // covers the live-append/page-load race that previously produced
      // duplicate rows.
      if (this.element.appendItem({ key, index: index++, frame }))
        inserted = true;
      this._pendingLiveFrames.delete(key);
    }
    return inserted;
  }

  _updateMountedItems(frames, appState, options) {
    let touched = options.touchedFrameIDs instanceof Set ? options.touchedFrameIDs : null;
    for (let frame of frames) {
      if (options.force !== true && touched && !touched.has(frame.id))
        continue;
      let item = this.frameList?.querySelector(`kikx-frame-item[data-frame-id="${CSS_ESCAPE(frame.id)}"]`);
      item?.updateFrame?.(frame, appState || this.getAppState(), { force: options.force === true });
    }
  }

  _pageForFrame(frames, frameID) {
    let index = frameID ? frames.findIndex((frame) => frame.id === frameID) : -1;
    return index < 0 ? null : Math.floor(index / this.pageSize);
  }

  expandOlderFrames(count = 40) {
    if (!this.element)
      return false;
    let page = Math.max(0, Math.floor(this.windowStart / this.pageSize) - 1);
    if (this.pageSource) {
      if (page >= this.pageSource.totalPages || page === Math.floor(this.windowStart / this.pageSize))
        return false;
      this.windowStart = page * this.pageSize;
      this.element.preloadPage(page);
      return true;
    }
    if (this.windowStart <= 0)
      return false;
    let anchor = captureFrameListAnchor(this.frameList);
    this.windowStart = page * this.pageSize;
    this._pendingAnchor = anchor;
    this._pendingPage = page;
    this.element.scrollToPage(page, { align: 'start', animate: false });
    return true;
  }

  showLatestFrames() {
    if (!this.element)
      return false;
    let page = (this.pageSource?.totalPages || pageCount(this.frames, this.pageSize)) - 1;
    if (this.windowStart === page * this.pageSize)
      return false;
    this.windowStart = page * this.pageSize;
    this.windowEnd = this.frames.length;
    this._pendingAnchor = null;
    this._pendingPage = page;
    this.element.scrollToPage(page, { align: 'end', animate: false });
    return true;
  }

  expandNewerFrames(count = 40) {
    if (!this.element || this.windowEnd >= this.frames.length)
      return false;
    let page = Math.min(pageCount(this.frames, this.pageSize) - 1, Math.floor(this.windowEnd / this.pageSize));
    this.windowEnd = Math.min(this.frames.length, (page + 1) * this.pageSize);
    this.element.scrollToPage(page, { align: 'end', animate: false });
    return true;
  }
}


function captureFilterAnchor(frameList) {
  if (!frameList)
    return null;
  let listTop = frameList.getBoundingClientRect().top;
  let items = [ ...frameList.querySelectorAll('kikx-frame-item[data-frame-id]') ];
  let item = items.find((candidate) => candidate.getBoundingClientRect().bottom > listTop);
  if (!item)
    return null;

  let order = Number(item._frame?.order);
  return {
    order: Number.isFinite(order) ? order : null,
    offset: item.getBoundingClientRect().top - listTop,
  };
}

function restoreFilterAnchor(frameList, anchor) {
  if (!frameList || !anchor)
    return false;

  let items = [ ...frameList.querySelectorAll('kikx-frame-item[data-frame-id]') ];
  if (items.length === 0 || !Number.isFinite(anchor.order))
    return false;

  let ordered = items
    .map((item) => ({ item, order: Number(item._frame?.order) }))
    .filter((entry) => Number.isFinite(entry.order))
    .sort((left, right) => left.order - right.order);
  if (ordered.length === 0)
    return false;

  let candidate = ordered.find((entry) => entry.order >= anchor.order) || ordered.at(-1);
  let listTop = frameList.getBoundingClientRect().top;
  let target = frameItemTopWithinList(frameList, candidate.item) - anchor.offset;
  let max = Math.max(0, frameList.scrollHeight - frameList.clientHeight);
  frameList.scrollTop = Math.min(Math.max(0, target), max);
  return true;
}

function captureVisibleFrameAnchor(frameList) {
  if (!frameList)
    return null;
  let listRect = frameList.getBoundingClientRect();
  let item = [ ...frameList.querySelectorAll('kikx-frame-item[data-frame-id]') ]
    .find((candidate) => {
      let rect = candidate.getBoundingClientRect();
      return rect.bottom > listRect.top && rect.top < listRect.bottom;
    });
  if (!item)
    return null;
  return {
    frameID: item.dataset.frameId,
    offset: item.getBoundingClientRect().top - listRect.top,
  };
}
