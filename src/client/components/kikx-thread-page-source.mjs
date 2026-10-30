'use strict';

// Whole-session page source for <aeor-scrollview>. The server page index counts
// raw frames from the oldest frame, so page tokens stay stable as new frames
// append. A page response is raw frames; this module projects them into the
// same display heads the thread normally renders.
//
// A projected head can straddle a page boundary (a tool call on one page and
// its result on the next). We load one page ahead and project the pair, then
// assign each head to the page containing its order. That keeps a tool pair in
// exactly one chunk and prevents duplicate heads at the seam.

import { projectFrameMessages } from '../../shared/frame-manager/frame-manager.mjs';
import { defaultFrameWindowFilters, frameMatchesWindowFilters } from '../../shared/frame-window-filters.mjs';
import { threadRenderFrames } from '../state/thinking-state.mjs';

const DEFAULT_PAGE_HEIGHT = 3500;

function frameOrder(frame) {
  let value = Number(frame?.order);
  if (Number.isFinite(value))
    return value;
  value = Number(frame?.commitOrder);
  return Number.isFinite(value) ? value : 0;
}

export class KikxThreadPageSource {
  constructor({ pageSize, totalRawFrames, loadPage, getFilters, getQuery }) {
    this.pageSize = Math.max(1, Number(pageSize) || 120);
    this.totalRawFrames = Math.max(0, Number(totalRawFrames) || 0);
    this.totalItems = this.totalRawFrames;
    this.totalPages = Math.max(0, Math.ceil(this.totalRawFrames / this.pageSize));
    this.loadRawPage = loadPage;
    this.getFilters = getFilters;
    this.getQuery = getQuery;
    this.rawPages = new Map();
    this.pageHeights = new Map();
    this.averagePageHeight = DEFAULT_PAGE_HEIGHT;
    this.requests = 0;
  }

  pageToken(index) {
    return String(index);
  }

  pageIndex(token) {
    return Math.max(0, Math.trunc(Number(token) || 0));
  }

  estimatePageHeight() {
    return this.averagePageHeight;
  }

  measured(index, height) {
    let value = Number(height);
    if (Number.isFinite(value) && value > 0) {
      this.pageHeights.set(index, value);
      let total = 0;
      for (let pageHeight of this.pageHeights.values())
        total += pageHeight;
      if (this.pageHeights.size > 0)
        this.averagePageHeight = total / this.pageHeights.size;
    }
  }

  _raw(index) {
    let key = Math.trunc(index);
    if (key < 0 || key >= this.totalPages)
      return Promise.resolve(null);
    if (!this.rawPages.has(key)) {
      this.requests++;
      this.rawPages.set(key, Promise.resolve(this.loadRawPage(key, this.pageSize)).then((page) => {
        if (page?.totalPages != null && Number(page.totalPages) !== this.totalPages) {
          this.totalPages = Math.max(this.totalPages, Number(page.totalPages) || 0);
          this.totalRawFrames = Math.max(this.totalRawFrames, Number(page.totalRawFrames) || 0);
          this.totalItems = this.totalRawFrames;
        }
        return page;
      }));
    }
    return this.rawPages.get(key);
  }

  async loadPage({ pageIndex }) {
    let index = Math.max(0, Math.trunc(Number(pageIndex) || 0));
    let [page, next] = await Promise.all([
      this._raw(index),
      index + 1 < this.totalPages ? this._raw(index + 1) : Promise.resolve(null),
    ]);
    if (!page)
      return { items: [] };

    let raw = [ ...(Array.isArray(page.frames) ? page.frames : []) ];
    if (next?.frames)
      raw.push(...next.frames);

    let start = page.oldestOrder != null ? Number(page.oldestOrder) : null;
    let nextStart = next?.oldestOrder != null ? Number(next.oldestOrder) : null;
    let end = page.newestOrder != null ? Number(page.newestOrder) : null;
    let heads = projectFrameMessages(raw);
    heads = heads.filter((frame) => {
      let order = frameOrder(frame);
      if (start != null && order < start)
        return false;
      if (nextStart != null)
        return order < nextStart;
      return end == null || order <= end;
    });
    // A null app filter means "untouched defaults", not "skip filtering". The
    // query and the default category set still have to be applied, or a search
    // over a freshly loaded session returns every frame on the page.
    let filters = this.getFilters?.() || defaultFrameWindowFilters();
    let query = this.getQuery?.() || '';
    heads = heads.filter((frame) => frameMatchesWindowFilters(frame, filters, query));
    heads = threadRenderFrames(heads, { includeHidden: filters.deleted === true })
      .filter((frame) => frame.deleted !== true || filters.deleted === true);
    // A projected head can be emitted from two adjacent raw windows during a
    // tool call/result seam. Keep one row per frame id even if the seam logic
    // ever sees the same head twice.
    let seen = new Set();
    heads = heads.filter((frame) => {
      if (!frame?.id || seen.has(frame.id))
        return false;
      seen.add(frame.id);
      return true;
    });
    let items = heads.map((frame, offset) => ({
      key: frame.id,
      index: index * this.pageSize + offset,
      frame,
    }));
    return {
      items,
      start,
      end: nextStart ?? end,
      measuredHint: this.pageHeights.get(index),
    };
  }
}
