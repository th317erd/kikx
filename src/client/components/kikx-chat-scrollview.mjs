'use strict';

// Adapter between Kikx's loaded frame window and Aeor's <aeor-scrollview>.
// Kikx owns frame identity, item rendering and the app state; the shared
// element owns page/gap geometry, page loading and programmatic scrolling.

import { captureFrameListAnchor, frameItemTopWithinList, restoreFrameListAnchor } from './frame-scroll-anchor.mjs';
import { KikxThreadPageSource } from './kikx-thread-page-source.mjs';
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
    key: `${sessionID}:${JSON.stringify(app?._state?.frameFilters || null)}`,
    sessionID,
    totalRawFrames: total,
    pageSize: PAGE_SIZE,
    loadPage: (pageIndex, pageSize) => app._loadFramePage(sessionID, pageIndex, pageSize),
    getFilters: () => app?._state?.frameFilters || null,
    getQuery: () => app?._state?.sessionSearch || '',
    getTotalRawFrames: () => Number(getSessionPaging(app?._state, sessionID).total) || total,
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
    this.pageSource = new KikxThreadPageSource({
      pageSize: this.pageContext.pageSize || this.pageSize,
      totalRawFrames: this.pageContext.totalRawFrames,
      loadPage: this.pageContext.loadPage,
      getFilters: this.pageContext.getFilters,
      getQuery: this.pageContext.getQuery,
    });
    this.pageSource.renderItem = (item) => this.createFrameItem(item.frame);
    this.source = this.pageSource;
    this.element.setSource(this.source, { follow: false });
    let last = Math.max(0, this.source.totalPages - 1);
    this.windowStart = last * this.pageSize;
    this.windowEnd = this.frames.length;
    this._pendingPage = last;
    this._pendingAnchor = null;
    this.element.scrollToPage(last, { align: 'end', animate: false });
  }

  _installEvents() {
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
    let structural = (next.length > 0 && previous.length > 0 && next[0]?.id !== previous[0]?.id)
      || (options.force === true && next.length !== previous.length);
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
    if (next.length > previous.length) {
      for (let index = previous.length; index < next.length; index++) {
        let frame = next[index];
        if (frame?.id)
          this._pendingLiveFrames.set(frame.id, frame);
      }
      insertedNew = this._flushPendingLiveFrames();
    }
    this._updateMountedItems(next, appState, options);
    this.windowEnd = next.length;
    restoreFrameListAnchor(this.frameList, anchor);
    return { insertedNew };
  }

  _flushPendingLiveFrames() {
    if (!this.element || !this.pageSource || this._pendingLiveFrames.size === 0)
      return false;

    let lastPage = Math.max(0, this.pageSource.totalPages - 1);
    let page = this.element.pages?.[lastPage];
    // Appending into an unloaded page would mark it loaded with only the live
    // item and prevent its real page request. Wait for the page load instead.
    if (!page?.loaded)
      return false;

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
