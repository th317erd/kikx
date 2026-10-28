'use strict';

// Adapter between Kikx's loaded frame window and Aeor's <aeor-scrollview>.
// Kikx owns frame identity, item rendering and the app state; the shared
// element owns page/gap geometry, page loading and programmatic scrolling.

import { captureFrameListAnchor, frameItemTopWithinList, restoreFrameListAnchor } from './frame-scroll-anchor.mjs';

const CSS_ESCAPE = globalThis.CSS?.escape || ((value) => String(value).replace(/["\\]/g, '\\$&'));

function pageCount(frames, pageSize) {
  return Math.max(1, Math.ceil(frames.length / pageSize));
}

export class KikxChatScrollView {
  constructor({ host, pageSize, createFrameItem, getAppState }) {
    this.host = host;
    this.pageSize = Math.max(1, pageSize);
    this.createFrameItem = createFrameItem;
    this.getAppState = getAppState;
    this.element = null;
    this.frames = [];
    this.source = null;
    this.windowStart = 0;
    this.windowEnd = 0;
    this._pendingAnchor = null;
    this._pendingPage = null;
  }

  get frameList() {
    return this.element?.viewport || null;
  }

  get frameStream() {
    return this.element?.querySelector?.('.kikx-frame-stream') || null;
  }

  mount(frames) {
    this.host.textContent = '';
    this.element = document.createElement('aeor-scrollview');
    this.element.className = 'kikx-thread-scrollview';
    this.element.setAttribute('page-enter-duration', '0');
    this.element.setAttribute('page-load-debounce', '100');
    this.host.appendChild(this.element);
    this._installEvents();
    this.frames = Array.isArray(frames) ? frames : [];
    this._setSource(this.frames);
    this._applyClasses();
    return this;
  }

  _installEvents() {
    this.element.addEventListener('scrollview-page-loaded', (event) => {
      let pageIndex = event.detail?.pageIndex;
      if (!Number.isInteger(pageIndex))
        return;
      this.windowStart = Math.min(this.windowStart, pageIndex * this.pageSize);
      this.windowEnd = this.frames.length;
      if (this._pendingPage === pageIndex) {
        let anchor = this._pendingAnchor;
        this._pendingPage = null;
        this._pendingAnchor = null;
        this._restoreAnchor(anchor);
      }
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
    let anchor = captureFrameListAnchor(this.frameList);
    let previous = this.frames;
    let next = Array.isArray(frames) ? frames : [];
    let overlap = Math.min(next.length, previous.length);
    let structural = next.length < previous.length
      || options.prepend === true
      || next.slice(0, overlap).some((frame, index) => frame?.id !== previous[index]?.id);
    if (!this.element || structural) {
      // Older history is inserted above the current source. Show the newly
      // loaded oldest page instead of restoring the old top frame: restoring it
      // puts the entire fetched page above the viewport and undoes the upward
      // scroll that requested the page.
      let olderInserted = next.length > previous.length
        && (options.prepend === true || next[0]?.id !== previous[0]?.id);
      let showOlderPage = olderInserted;
      this.frames = next;
      this._setSource(next, {
        anchor: showOlderPage ? null : anchor,
        page: showOlderPage ? 0 : this._pageForFrame(next, anchor?.frameID),
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
    let touched = options.touchedFrameIDs instanceof Set ? options.touchedFrameIDs : null;
    for (let frame of next) {
      if (options.force !== true && touched && !touched.has(frame.id))
        continue;
      let item = this.frameList?.querySelector(`kikx-frame-item[data-frame-id="${CSS_ESCAPE(frame.id)}"]`);
      item?.updateFrame?.(frame, appState || this.getAppState(), { force: options.force === true });
    }
    this.windowEnd = next.length;
    // Preserve the frame under the reader when a streaming item changes size
    // or a tail item is appended. Kikx's old focus driver is bypassed in shared
    // mode; this is the equivalent synchronous transaction.
    restoreFrameListAnchor(this.frameList, anchor);
    return { insertedNew: insertedNew || structural };
  }

  _pageForFrame(frames, frameID) {
    let index = frameID ? frames.findIndex((frame) => frame.id === frameID) : -1;
    return index < 0 ? null : Math.floor(index / this.pageSize);
  }

  expandOlderFrames(count = 40) {
    if (!this.element || this.windowStart <= 0)
      return false;
    let page = Math.max(0, Math.floor(this.windowStart / this.pageSize) - 1);
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
    let page = pageCount(this.frames, this.pageSize) - 1;
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
