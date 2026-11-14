'use strict';

// Page-context factory + page math for the shared scrollview adapter.
// Extracted from kikx-chat-scrollview (2026-11-14, 800-line hard cap): this is
// the seam between app state (session paging totals, filters, query) and the
// scrollview's source model — cohesive on its own and imported by the shell
// builders and the frame-scroll driver, which have no business pulling the
// whole adapter class for it.

import { getSessionPaging } from '../state/kikx-state.mjs';

export const PAGE_SIZE = 120;

export function pageCount(frames, pageSize = PAGE_SIZE) {
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
